#!/usr/bin/env node
/**
 * Приёмник отзывов bxshef. Без зависимостей: node:http + файлы.
 *
 *   POST /feedback        тело — JSON отзыва (как пишет навык <префикс>-feedback,
 *                         отправляет `bxshef feedback send`); ответ 201
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
 * тогда POST требует Bearer; bxshef его пока не отправляет, поэтому по умолчанию выключен.
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
const tooMany = (res) => json(res, 429, { error: 'слишком часто, повторите позже' }, { 'retry-after': retryAfter() });
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
  if (!bearer(req, READ_TOKEN)) { fails.set(ip, (fails.get(ip) || 0) + 1); return [401, 'token']; }
  return null;
}

// ─── Отзыв: только известные поля ───────────────────────────────────
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
function normalize(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const skill = str(j.skill, 100);
  if (!skill || !Array.isArray(j.issues)) return null;
  const issues = j.issues.slice(0, 50).map((i) => ({ kind: str(i?.kind, 20), text: str(i?.text, 1000) })).filter((i) => i.text);
  const helped = Array.isArray(j.helped) ? j.helped.slice(0, 50).map((h) => str(h, 500)).filter(Boolean) : [];
  const out = { skill };
  for (const k of ['version', 'agent', 'main', 'outcome']) { const v = str(j[k], 50); if (v) out[k] = v; }
  const task = str(j.task, 300); if (task) out.task = task;
  if (typeof j.receivedAt === 'string') out.receivedAt = j.receivedAt.slice(0, 30);
  return { ...out, issues, helped };
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
    try { it = normalize(JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'))); } catch { return null; }
    return it && { ...it, file: f };
  }).filter(Boolean);
}

// Сводку читают в терминале (make read): управляющие символы и разметка из отзыва — не команды.
const clean = (s) => String(s ?? '?')
  .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ')
  .replace(/[|`*_[\]<>!\\]/g, '\\$&');
function summary(items) {
  const by = new Map();
  for (const it of items) {
    const s = by.get(it.skill) || { n: 0, issues: 0, helped: 0, last: '' };
    s.n++; s.issues += it.issues.length; s.helped += it.helped.length; s.last = it.file.slice(0, 16);
    by.set(it.skill, s);
  }
  let md = `# Отзывы: ${items.length}\n\n| навык | отзывов | замечаний | helped | последний |\n|---|---|---|---|---|\n`;
  for (const [k, s] of [...by].sort((a, b) => b[1].n - a[1].n)) md += `| ${clean(k)} | ${s.n} | ${s.issues} | ${s.helped} | ${s.last} |\n`;
  md += `\n## Последние замечания\n\n`;
  for (const it of items.slice(-30).reverse()) for (const i of it.issues) md += `- **${clean(it.skill)}**@${clean(it.version)} [${clean(i.kind)}] ${clean(i.text)}\n`;
  return md;
}

// ─── HTTP ───────────────────────────────────────────────────────────
function receive(req, res, ip) {
  if (!allowPost(ip)) return tooMany(res);
  if (TOKEN && !bearer(req, TOKEN)) return json(res, 401, { error: 'token' });
  const chunks = []; let size = 0; let over = false;
  req.on('data', (c) => {
    if (over) return;
    size += c.length;
    if (size > MAX_BODY) { over = true; json(res, 413, { error: 'too large' }, { connection: 'close' }); req.resume(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (over) return;
    try {
      let j; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { error: 'json' }); }
      const it = normalize(j);
      if (!it) return json(res, 400, { error: 'skill (строка) и issues (массив) обязательны' });
      if (stored.files >= MAX_FILES || stored.bytes >= MAX_BYTES) return json(res, 507, { error: 'хранилище заполнено' });
      const body = JSON.stringify({ ...it, receivedAt: new Date().toISOString() });
      const name = `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${safe(it.skill)}-${crypto.randomBytes(3).toString('hex')}.json`;
      fs.writeFileSync(path.join(DATA, name), body);
      stored.files++; stored.bytes += Buffer.byteLength(body);
      json(res, 201, { ok: true, id: name });
    } catch (e) {
      console.error(`bxshef feedback: запись не удалась: ${e.code || e.message}`);
      if (!res.headersSent) json(res, 500, { error: 'не сохранено' });
    }
  });
}

function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return json(res, 400, { error: 'bad url' }); }
  const ip = clientIp(req);
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
  if (req.method === 'POST' && url.pathname === '/feedback') return receive(req, res, ip);
  if (req.method === 'GET' && (url.pathname === '/feedback' || url.pathname === '/feedback.md')) {
    const deny = denyRead(req, ip);
    if (deny) return deny[0] === 429 ? tooMany(res) : json(res, deny[0], { error: deny[1] });
    const items = readAll();
    if (url.pathname === '/feedback.md') return text(res, 200, summary(items));
    const skill = url.searchParams.get('skill');
    return json(res, 200, items.filter((it) => !skill || it.skill === skill));
  }
  json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  try { handle(req, res); } catch (e) {
    console.error(`bxshef feedback: ${req.method} ${req.url}: ${e.code || e.message}`);
    if (!res.headersSent) json(res, 500, { error: 'internal' }); else res.destroy();
  }
});
server.on('error', (e) => { console.error(`bxshef feedback: не запустился на :${PORT}: ${e.code || e.message}`); process.exit(1); });
server.listen(PORT, () => {
  sweep(); resolveProxy();
  setInterval(sweep, 3_600_000).unref();
  setInterval(resolveProxy, 300_000).unref();
  console.log(`bxshef feedback: :${PORT}, data ${DATA}, post ${TOKEN ? 'token' : 'open'} ${RATE}/мин, read ${READ_TOKEN ? (READ_REMOTE ? 'token, снаружи' : 'token, только с сервера') : 'off'}, хранение ${KEEP_ALL ? 'всё' : RETENTION_DAYS + ' дн.'}, отзывов ${stored.files}`);
});
