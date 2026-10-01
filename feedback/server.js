#!/usr/bin/env node
/**
 * Приёмник отзывов bxshef. Без зависимостей: node:http + файлы.
 *
 *   POST /feedback        тикет — JSON:
 *                         { category, title, body, context: { skill, agent, version,
 *                         main, outcome, helped[] } }; агент шлёт его сам (curl,
 *                         PowerShell — навык <префикс>-feedback). То же формой
 *                         (x-www-form-urlencoded: category, title, body, skill, outcome,
 *                         agent, version, main, helped — повторяется). Ответ 201
 *                         { success: true, data: { id, category, title, status, createdAt } }.
 *                         Из текста вычищаются секреты, адреса, домены, почта, IP, пути и
 *                         телефоны — до записи на диск (SCRUB ниже). Прочие поля отбрасываются.
 *   GET  /feedback        список отзывов (JSON), ?skill=имя — только по навыку
 *   GET  /feedback.md     то же, читаемо: сводка по навыкам и последние замечания
 *   GET  /health          200 ok
 *
 * Чтение (оба GET /feedback*) — два замка:
 *   - токен: заголовок Authorization: Bearer <FEEDBACK_READ_TOKEN>. Не задан — чтение
 *     закрыто совсем (403);
 *   - откуда: по умолчанию только с самого сервера — соединение с 127.0.0.1 без следов
 *     прокси (`make read`, на Вайбкоде — vibecode.sh read). Снаружи — только если
 *     FEEDBACK_READ_REMOTE=1, иначе 403 даже с верным токеном: утёкший токен сам по себе
 *     отзывы не открывает. «Следы прокси» — X-Forwarded-For, Forwarded, X-Real-IP или
 *     X-Vibe-Request-Id: туннель Вайбкода приходит к приложению с 127.0.0.1, и отличить его
 *     от своего запроса можно только по заголовку, который шлюз ставит всегда.
 * Неверный токен — не больше FEEDBACK_AUTH_FAILS (5) попыток в минуту с адреса, дальше 429.
 *
 * Отправка: не больше FEEDBACK_RATE (20) в минуту с адреса и FEEDBACK_RATE_TOTAL (300)
 * в минуту всего, дальше 429 с Retry-After. Тело до 64 КБ. Необязательный FEEDBACK_TOKEN —
 * тогда POST требует Bearer (bxshef — из BXSHEF_FEEDBACK_TOKEN); навыки шлют без токена,
 * поэтому по умолчанию выключен.
 *
 * Хранится не тело как есть, а известные поля отзыва (skill, version, agent, main, task,
 * outcome, issues[].kind/text, helped[]) — строки с ограничением длины, и время приёма. Ни
 * IP, ни заголовков, ни посторонних полей: чужой JSON не раздует диск и не сломает чтение.
 * Место ограничено: FEEDBACK_MAX_FILES (20000) отзывов и FEEDBACK_MAX_MB (200), сверх — 507,
 * пока старые не уйдут по сроку. Файл — <дата>-<навык>-<случайно>.json в DATA_DIR.
 * Старше FEEDBACK_RETENTION_DAYS (3) дней удаляются при старте и раз в час; 0 — хранить всё.
 *
 * Адрес клиента — для лимитов, только в памяти. За nginx-proxy сокет — это прокси, поэтому
 * при TRUST_PROXY берётся последний адрес X-Forwarded-For (его дописал прокси; присланное
 * клиентом стоит левее). TRUST_PROXY=1 — верить соединениям из частной сети;
 * TRUST_PROXY=<имя хоста> — только адресам этого хоста (контейнера nginx-proxy): тогда
 * соседние контейнеры сети не подделают адрес.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns');

// Лимиты: не число или ≤ 0 — значение по умолчанию (0 не должен молча закрывать приём).
const limit = (v, d) => (Number(v) > 0 ? Number(v) : d);
const PORT = limit(process.env.PORT, 8787);
const DATA = path.resolve(process.env.DATA_DIR || './data');
const TOKEN = process.env.FEEDBACK_TOKEN || '';
const READ_TOKEN = process.env.FEEDBACK_READ_TOKEN || '';
const READ_REMOTE = process.env.FEEDBACK_READ_REMOTE === '1';
const TRUST_PROXY = process.env.TRUST_PROXY || '';
const RATE = limit(process.env.FEEDBACK_RATE, 20);
const RATE_TOTAL = limit(process.env.FEEDBACK_RATE_TOTAL, 300);
const AUTH_FAILS = limit(process.env.FEEDBACK_AUTH_FAILS, 5);
const MAX_FILES = limit(process.env.FEEDBACK_MAX_FILES, 20000);
const MAX_BYTES = limit(process.env.FEEDBACK_MAX_MB, 200) * 1024 * 1024;
const KEEP_ALL = process.env.FEEDBACK_RETENTION_DAYS === '0';
const RETENTION_DAYS = limit(process.env.FEEDBACK_RETENTION_DAYS, 3);
const MAX_BODY = 64 * 1024;
fs.mkdirSync(DATA, { recursive: true });

const json = (res, code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', ...headers }); res.end(JSON.stringify(body)); };
// Ответы — как у API Вайбкода: { success, data } и { success: false, error: { code, message } }.
const fail = (res, status, code, message, headers) => json(res, status, { success: false, error: { code, message } }, headers);
const text = (res, code, body) => { res.writeHead(code, { 'content-type': 'text/markdown; charset=utf-8', 'x-content-type-options': 'nosniff' }); res.end(body); };
const safe = (s) => String(s).replace(/[^a-z0-9-]/gi, '_').slice(0, 60);
const bearer = (req, token) => {
  const a = Buffer.from(req.headers.authorization || '');
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// ─── Адрес клиента ──────────────────────────────────────────────────
const bare = (ip) => String(ip || '').replace(/^::ffff:/, '');
const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1';
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-vibe-request-id'];
const isLocal = (req) => isLoopback(bare(req.socket.remoteAddress)) && !PROXY_HEADERS.some((h) => h in req.headers);
const isPrivate = (ip) => isLoopback(ip) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|f[cd])/i.test(ip);
let proxyAddrs = new Set();
function resolveProxy() {
  if (!TRUST_PROXY || TRUST_PROXY === '1') return;
  dns.lookup(TRUST_PROXY, { all: true }, (err, list) => {
    if (err) return console.error(`bxshef feedback: TRUST_PROXY=${TRUST_PROXY} не резолвится: ${err.code}`);
    proxyAddrs = new Set(list.map((a) => bare(a.address)));
  });
}
const trusted = (sock) => (TRUST_PROXY === '1' ? isPrivate(sock) : proxyAddrs.has(sock));
function clientIp(req) {
  const sock = bare(req.socket.remoteAddress);
  if (!TRUST_PROXY || !trusted(sock)) return sock;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => bare(s.trim())).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : sock;
}

// ─── Лимиты: окно в минуту, счётчики сбрасываются целиком ────────────
// Отдельные таблицы: поток отправок с тысяч адресов не вытесняет счётчик неудач токена.
const MAX_KEYS = 50_000;
let windowStart = 0;
const posts = new Map();
const fails = new Map();
function tick() {
  if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); posts.clear(); fails.clear(); }
}
const retryAfter = () => String(Math.max(1, Math.ceil((windowStart + 60_000 - Date.now()) / 1000)));
const tooMany = (res) => fail(res, 429, 'RATE_LIMITED', 'слишком часто, повторите позже', { 'retry-after': retryAfter() });
function allowPost(ip) {
  tick();
  const total = (posts.get('*') || 0) + 1;
  if (total > RATE_TOTAL) return false;
  const own = (posts.get(ip) || 0) + 1;
  if (own > RATE || (!posts.has(ip) && posts.size >= MAX_KEYS)) return false;
  posts.set('*', total); posts.set(ip, own);
  return true;
}

// Ответ, если читать нельзя; null — можно. Таблица неудач переполнена — закрыто для всех.
function denyRead(req, ip) {
  if (!READ_TOKEN) return [403, 'чтение выключено: задайте FEEDBACK_READ_TOKEN'];
  if (!READ_REMOTE && !isLocal(req)) return [403, 'чтение только с сервера: make read'];
  tick();
  if ((fails.get(ip) || 0) >= AUTH_FAILS || fails.size >= MAX_KEYS) return [429];
  if (!bearer(req, READ_TOKEN)) { fails.set(ip, (fails.get(ip) || 0) + 1); return [401, 'нужен верный токен']; }
  return null;
}

// ─── Отзыв: только известные поля ───────────────────────────────────
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
// Один формат — тикет Вайбкода (POST /v1/feedback): category, title, body, context. Навык,
// о котором тикет, — context.skill. Из context берутся только известные поля.
const CATEGORIES = new Set(['BUG', 'SUGGESTION', 'DOCS', 'CHAT', 'BOTS', 'OTHER']);
const OUTCOMES = new Set(['done', 'partial', 'failed']);
const SKILL_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const META_RE = /^[\w.@+-]{1,50}$/;

// Чистка текста: агенту велено не писать в отзыв проект и секреты, но на слово не верим —
// всё похожее заменяется пометкой ДО записи на диск. Порядок важен: сначала крупное (ключи,
// адреса), потом мелкое (длинные строки, похожие на токен).
const SCRUB = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[скрыто: ключ]'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '[скрыто: адрес]'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[скрыто: почта]'],
  [/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, '[скрыто: токен]'],
  [/\b(?:vibe_(?:api|live|app)_|sk-|sk_live_|pk_live_|rk_live_|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[abpr]-|AKIA|ASIA|AIza)[\w-]{8,}/g, '[скрыто: ключ]'],
  [/\b(?:Bearer|Basic)\s+[\w.~+/=-]{8,}/gi, '[скрыто: токен]'],
  [/\b(pass(?:word)?|passwd|pwd|парол[а-я]*|token|токен[а-я]*|secret|секрет[а-я]*|api[_-]?key|access[_-]?key|client[_-]?secret|ключ[а-я]*|webhook)(\s*[:=]\s*)(?!\[скрыто)\S+/gi, '$1$2[скрыто]'],
  [/\b(?:[a-z0-9-]+\.)+(?:ru|by|kz|ua|uz|su|com|net|org|io|dev|app|tech|info|biz|pro|online|site|shop|store|cloud|рф)\b/gi, '[скрыто: домен]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[скрыто: IP]'],
  [/(^|[\s"'(=])(?:~|\/(?:home|Users|root|var|srv|opt|etc|usr|tmp|www|mnt|data))\/[^\s"')]*/g, '$1[скрыто: путь]'],
  [/\b[A-Za-z]:\\[^\s"')]+/g, '[скрыто: путь]'],
  [/\+\d[\d\s()-]{9,}\d/g, '[скрыто: телефон]'],
  [/\b[a-f0-9]{32,}\b/gi, '[скрыто: токен]'],
  [/\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{40,}={0,2}/g, '[скрыто: токен]'],
];
function scrub(s, counter) {
  let out = s;
  for (const [re, to] of SCRUB) out = out.replace(re, (...m) => { counter.n++; return typeof to === 'string' ? to.replace(/\$(\d)/g, (_, d) => m[d] ?? '') : to; });
  return out;
}

// Ошибки формата — списком, как VALIDATION_ERROR у Вайбкода. stored — файл с диска: длины уже
// проверены при приёме, а чистка могла их изменить.
function normalize(j, stored = false) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { errors: ['тело — JSON-объект'] };
  const errors = [];
  const n = { n: 0 };
  const category = String(j.category ?? '').toUpperCase();
  if (!CATEGORIES.has(category)) errors.push(`category — одно из ${[...CATEGORIES].join(', ')}`);
  const title = typeof j.title === 'string' ? j.title.trim() : '';
  if (!stored && (title.length < 3 || title.length > 200)) errors.push('title — 3–200 символов');
  const body = typeof j.body === 'string' ? j.body.trim() : '';
  if (!stored && (body.length < 10 || body.length > 20000)) errors.push('body — 10–20000 символов');
  const ctx = j.context && typeof j.context === 'object' && !Array.isArray(j.context) ? j.context : null;
  if (!ctx) errors.push('context — объект, в нём skill');
  else if (!stored && JSON.stringify(ctx).length > 10240) errors.push('context — до 10 КБ');
  const skill = ctx && typeof ctx.skill === 'string' && SKILL_RE.test(ctx.skill) ? ctx.skill : null;
  if (ctx && !skill) errors.push('context.skill — имя навыка: буквы, цифры, . _ : -');
  if (errors.length) return { errors };

  const context = { skill };
  for (const k of ['agent', 'version', 'main']) if (typeof ctx[k] === 'string' && META_RE.test(ctx[k])) context[k] = ctx[k];
  if (OUTCOMES.has(ctx.outcome)) context.outcome = ctx.outcome;
  const helped = Array.isArray(ctx.helped) ? ctx.helped.slice(0, 20).map((h) => str(h, 500)).filter(Boolean).map((h) => scrub(h, n).trim()) : [];
  if (helped.length) context.helped = helped;
  const it = { category, title: scrub(title.slice(0, 200), n), body: scrub(body.slice(0, 20000), n), context };
  const redacted = n.n + (Number.isInteger(j.redacted) && j.redacted > 0 ? j.redacted : 0);
  if (redacted) it.redacted = redacted;
  if (typeof j.receivedAt === 'string') it.receivedAt = j.receivedAt.slice(0, 30);
  return { it };
}

// Тот же тикет формой (application/x-www-form-urlencoded) — для curl --data-urlencode без JSON в
// команде: проверки оболочки у агентов (Claude Code) не пропускают команду с «{"» внутри. Поля
// плоско: category, title, body, skill, outcome, agent, version, main; helped — повторяется.
function fromForm(raw) {
  const f = new URLSearchParams(raw);
  const v = (k) => (f.has(k) ? f.get(k) : undefined);
  const context = { skill: v('skill'), outcome: v('outcome'), agent: v('agent'), version: v('version'), main: v('main') };
  const helped = f.getAll('helped');
  if (helped.length) context.helped = helped;
  return { category: v('category'), title: v('title'), body: v('body'), context };
}

// ─── Хранилище ──────────────────────────────────────────────────────
let stored = { files: 0, bytes: 0 };
function sweep() {
  const edge = Date.now() - RETENTION_DAYS * 86_400_000;
  let files = 0; let bytes = 0; let removed = 0;
  let names;
  try { names = fs.readdirSync(DATA); } catch (e) { return console.error(`bxshef feedback: каталог ${DATA} недоступен: ${e.code}`); }
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(DATA, f);
    try {
      const st = fs.statSync(p);
      if (!KEEP_ALL && st.mtimeMs < edge) { fs.unlinkSync(p); removed++; continue; }
      files++; bytes += st.size;
    } catch { /* удалён параллельно — не важно */ }
  }
  stored = { files, bytes };
  if (removed) console.log(`bxshef feedback: удалено отзывов старше ${RETENTION_DAYS} дн.: ${removed}`);
}

// Файлы прежних версий (с ip и посторонними полями) проходят через тот же normalize.
function readAll() {
  return fs.readdirSync(DATA).filter((f) => f.endsWith('.json')).sort().map((f) => {
    let it;
    try { it = normalize(JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')), true).it; } catch { return null; }
    return it && { ...it, file: f };
  }).filter(Boolean);
}

// Сводку читают в терминале (make read): управляющие символы и разметка из отзыва — не команды.
const clean = (s) => String(s ?? '?')
  .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ')
  .replace(/[|`*_[\]<>!\\]/g, '\\$&');
const CAT_COLS = ['BUG', 'DOCS', 'SUGGESTION', 'OTHER'];
function summary(items) {
  const by = new Map();
  for (const it of items) {
    const k = it.context.skill;
    const s = by.get(k) || { n: 0, BUG: 0, DOCS: 0, SUGGESTION: 0, OTHER: 0, helped: 0, last: '' };
    s.n++; s[CAT_COLS.includes(it.category) ? it.category : 'OTHER']++;
    s.helped += (it.context.helped || []).length; s.last = it.file.slice(0, 16);
    by.set(k, s);
  }
  let md = `# Отзывы: ${items.length}\n\n| навык | тикетов | BUG | DOCS | SUGGESTION | OTHER | helped | последний |\n|---|---|---|---|---|---|---|---|\n`;
  for (const [k, s] of [...by].sort((a, b) => b[1].n - a[1].n)) md += `| ${clean(k)} | ${s.n} | ${s.BUG} | ${s.DOCS} | ${s.SUGGESTION} | ${s.OTHER} | ${s.helped} | ${s.last} |\n`;
  md += `\n## Последние тикеты\n\n`;
  for (const it of items.slice(-30).reverse()) {
    md += `- **${clean(it.context.skill)}**@${clean(it.context.version)} [${it.category}] ${clean(it.title)} — ${clean(it.body.slice(0, 300))}\n`;
  }
  return md;
}

// ─── HTTP ───────────────────────────────────────────────────────────
function receive(req, res, ip) {
  if (!allowPost(ip)) return tooMany(res);
  if (TOKEN && !bearer(req, TOKEN)) return fail(res, 401, 'UNAUTHORIZED', 'нужен токен');
  const chunks = []; let size = 0; let over = false;
  req.on('data', (c) => {
    if (over) return;
    size += c.length;
    if (size > MAX_BODY) { over = true; fail(res, 413, 'TOO_LARGE', 'отзыв больше 64 КБ', { connection: 'close' }); req.resume(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (over) return;
    try {
      const raw = Buffer.concat(chunks).toString('utf8');
      let j;
      if (/^application\/x-www-form-urlencoded/i.test(req.headers['content-type'] || '')) j = fromForm(raw);
      else { try { j = JSON.parse(raw); } catch { return fail(res, 400, 'VALIDATION_ERROR', 'тело — не JSON и не форма'); } }
      const { it, errors } = normalize(j);
      if (errors) return fail(res, 400, 'VALIDATION_ERROR', errors.join('; '));
      if (stored.files >= MAX_FILES || stored.bytes >= MAX_BYTES) return fail(res, 507, 'STORAGE_FULL', 'хранилище заполнено');
      const createdAt = new Date().toISOString();
      const body = JSON.stringify({ ...it, receivedAt: createdAt });
      const name = `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${safe(it.context.skill)}-${crypto.randomBytes(3).toString('hex')}.json`;
      fs.writeFileSync(path.join(DATA, name), body);
      stored.files++; stored.bytes += Buffer.byteLength(body);
      json(res, 201, { success: true, data: { id: name, category: it.category, title: it.title, status: 'NEW', createdAt } });
    } catch (e) {
      console.error(`bxshef feedback: запись не удалась: ${e.code || e.message}`);
      if (!res.headersSent) fail(res, 500, 'INTERNAL_ERROR', 'не сохранено');
    }
  });
}

function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return fail(res, 400, 'BAD_URL', 'кривой адрес запроса'); }
  const ip = clientIp(req);
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
  if (req.method === 'POST' && url.pathname === '/feedback') return receive(req, res, ip);
  if (req.method === 'GET' && (url.pathname === '/feedback' || url.pathname === '/feedback.md')) {
    const deny = denyRead(req, ip);
    if (deny) return deny[0] === 429 ? tooMany(res) : fail(res, deny[0], deny[0] === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', deny[1]);
    const items = readAll();
    if (url.pathname === '/feedback.md') return text(res, 200, summary(items));
    const skill = url.searchParams.get('skill');
    return json(res, 200, items.filter((it) => !skill || it.context.skill === skill));
  }
  fail(res, 404, 'NOT_FOUND', 'нет такого адреса');
}

const server = http.createServer((req, res) => {
  try { handle(req, res); } catch (e) {
    console.error(`bxshef feedback: ${req.method} ${req.url}: ${e.code || e.message}`);
    if (!res.headersSent) fail(res, 500, 'INTERNAL_ERROR', 'внутренняя ошибка'); else res.destroy();
  }
});
server.on('error', (e) => { console.error(`bxshef feedback: не запустился на :${PORT}: ${e.code || e.message}`); process.exit(1); });
server.listen(PORT, () => {
  sweep(); resolveProxy();
  setInterval(sweep, 3_600_000).unref();
  setInterval(resolveProxy, 300_000).unref();
  console.log(`bxshef feedback: :${PORT}, data ${DATA}, post ${TOKEN ? 'token' : 'open'} ${RATE}/мин, read ${READ_TOKEN ? (READ_REMOTE ? 'token, снаружи' : 'token, только с сервера') : 'off'}, хранение ${KEEP_ALL ? 'всё' : RETENTION_DAYS + ' дн.'}, отзывов ${stored.files}`);
});
