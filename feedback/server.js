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
 *   - откуда: по умолчанию только изнутри контейнера (127.0.0.1 — `make read` на
 *     сервере). Снаружи, через прокси, — только если FEEDBACK_READ_REMOTE=1, иначе 403
 *     даже с верным токеном: утёкший токен сам по себе отзывы не открывает.
 * Неверный токен — не больше FEEDBACK_AUTH_FAILS (5) попыток в минуту с адреса, дальше 429.
 *
 * Отправка: не больше FEEDBACK_RATE (20) в минуту с адреса и FEEDBACK_RATE_TOTAL (300)
 * в минуту всего, дальше 429 с Retry-After. Тело до 64 КБ, обязательные skill (строка)
 * и issues (массив). Необязательный FEEDBACK_TOKEN — тогда POST требует Bearer; bxshef его
 * пока не отправляет, поэтому по умолчанию выключен.
 *
 * Адрес клиента — для лимитов, только в памяти, на диск не пишется. За nginx-proxy сокет
 * — это прокси, поэтому при TRUST_PROXY=1 и соединении из частной сети берётся последний
 * адрес X-Forwarded-For (его дописал прокси; то, что прислал клиент, стоит левее).
 *
 * Хранение: один файл на отзыв в DATA_DIR (по умолчанию ./data), имя —
 * <дата>-<навык>-<случайно>.json; тело отзыва и время приёма, ни IP, ни заголовков.
 * Старше FEEDBACK_RETENTION_DAYS (3) дней удаляются при старте и раз в час; 0 — хранить всё.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const PORT = num(process.env.PORT, 8787);
const DATA = path.resolve(process.env.DATA_DIR || './data');
const TOKEN = process.env.FEEDBACK_TOKEN || '';
const READ_TOKEN = process.env.FEEDBACK_READ_TOKEN || '';
const READ_REMOTE = process.env.FEEDBACK_READ_REMOTE === '1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const RATE = num(process.env.FEEDBACK_RATE, 20);
const RATE_TOTAL = num(process.env.FEEDBACK_RATE_TOTAL, 300);
const AUTH_FAILS = num(process.env.FEEDBACK_AUTH_FAILS, 5);
const RETENTION_DAYS = num(process.env.FEEDBACK_RETENTION_DAYS, 3);
const MAX = 64 * 1024;
fs.mkdirSync(DATA, { recursive: true });

const json = (res, code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(body)); };
const text = (res, code, body) => { res.writeHead(code, { 'content-type': 'text/markdown; charset=utf-8' }); res.end(body); };
const safe = (s) => String(s).replace(/[^a-z0-9-]/gi, '_').slice(0, 60);
const bearer = (req, token) => {
  const a = Buffer.from(req.headers.authorization || '');
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const bare = (ip) => String(ip || '').replace(/^::ffff:/, '');
const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1';
const isPrivate = (ip) => isLoopback(ip) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|f[cd])/i.test(ip);
function clientIp(req) {
  const sock = bare(req.socket.remoteAddress);
  if (!TRUST_PROXY || !isPrivate(sock)) return sock;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => bare(s.trim())).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : sock;
}

// Окно в минуту: счётчик на ключ, сбрасывается целиком с началом новой минуты.
let windowStart = 0;
let counts = new Map();
function hit(key, limit) {
  const now = Date.now();
  if (now - windowStart >= 60_000) { windowStart = now; counts = new Map(); }
  // Предел ключей: поток с тысяч адресов не должен раздуть память — лишние сразу «слишком часто».
  if (!counts.has(key) && counts.size >= 50_000) return false;
  const n = (counts.get(key) || 0) + 1;
  counts.set(key, n);
  return n <= limit;
}
const seen = (key) => (Date.now() - windowStart < 60_000 ? counts.get(key) || 0 : 0);
const retryAfter = () => String(Math.max(1, Math.ceil((windowStart + 60_000 - Date.now()) / 1000)));
const tooMany = (res) => json(res, 429, { error: 'слишком часто, повторите позже' }, { 'retry-after': retryAfter() });

// Ответ, если читать нельзя; null — можно.
function denyRead(req, ip) {
  if (!READ_TOKEN) return [403, 'чтение выключено: задайте FEEDBACK_READ_TOKEN'];
  if (!READ_REMOTE && !isLoopback(bare(req.socket.remoteAddress))) return [403, 'чтение только с сервера: make read'];
  if (seen(`fail:${ip}`) >= AUTH_FAILS) return [429];
  if (!bearer(req, READ_TOKEN)) { hit(`fail:${ip}`, Infinity); return [401, 'token']; }
  return null;
}

function readAll() {
  return fs.readdirSync(DATA).filter((f) => f.endsWith('.json')).sort().map((f) => {
    try { return { file: f, ...JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')) }; } catch { return null; }
  }).filter((it) => it && typeof it.skill === 'string' && Array.isArray(it.issues));
}

function summary(items) {
  const by = new Map();
  for (const it of items) {
    const s = by.get(it.skill) || { n: 0, issues: 0, helped: 0, last: '' };
    s.n++; s.issues += it.issues.length; s.helped += (it.helped || []).length; s.last = it.file.slice(0, 15);
    by.set(it.skill, s);
  }
  let md = `# Отзывы: ${items.length}\n\n| навык | отзывов | замечаний | helped | последний |\n|---|---|---|---|---|\n`;
  for (const [k, s] of [...by].sort((a, b) => b[1].n - a[1].n)) md += `| ${k} | ${s.n} | ${s.issues} | ${s.helped} | ${s.last} |\n`;
  md += `\n## Последние замечания\n\n`;
  for (const it of items.slice(-30).reverse()) for (const i of it.issues) md += `- **${it.skill}**@${it.version ?? '?'} [${i?.kind}] ${i?.text}\n`;
  return md;
}

function sweep() {
  if (!(RETENTION_DAYS > 0)) return;
  const edge = Date.now() - RETENTION_DAYS * 86_400_000;
  let n = 0;
  for (const f of fs.readdirSync(DATA)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(DATA, f);
    try { if (fs.statSync(p).mtimeMs < edge) { fs.unlinkSync(p); n++; } } catch { /* удалён параллельно — не важно */ }
  }
  if (n) console.log(`bxshef feedback: удалено отзывов старше ${RETENTION_DAYS} дн.: ${n}`);
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = clientIp(req);
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
  if (req.method === 'GET' && (url.pathname === '/feedback' || url.pathname === '/feedback.md')) {
    const deny = denyRead(req, ip);
    if (deny) return deny[0] === 429 ? tooMany(res) : json(res, deny[0], { error: deny[1] });
  }
  if (req.method === 'GET' && url.pathname === '/feedback') {
    const skill = url.searchParams.get('skill');
    return json(res, 200, readAll().filter((it) => !skill || it.skill === skill));
  }
  if (req.method === 'GET' && url.pathname === '/feedback.md') return text(res, 200, summary(readAll()));
  if (req.method === 'POST' && url.pathname === '/feedback') {
    if (!hit(`post:${ip}`, RATE) || !hit('post:*', RATE_TOTAL)) return tooMany(res);
    if (TOKEN && !bearer(req, TOKEN)) return json(res, 401, { error: 'token' });
    const chunks = []; let size = 0; let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > MAX) { over = true; json(res, 413, { error: 'too large' }, { connection: 'close' }); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      let j; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { error: 'json' }); }
      if (!j || typeof j !== 'object' || typeof j.skill !== 'string' || !Array.isArray(j.issues)) return json(res, 400, { error: 'skill и issues обязательны' });
      const name = `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${safe(j.skill)}-${crypto.randomBytes(3).toString('hex')}.json`;
      fs.writeFileSync(path.join(DATA, name), JSON.stringify({ ...j, receivedAt: new Date().toISOString() }, null, 1));
      return json(res, 201, { ok: true, id: name });
    });
    return;
  }
  json(res, 404, { error: 'not found' });
}).listen(PORT, () => {
  sweep();
  setInterval(sweep, 3_600_000).unref();
  console.log(`bxshef feedback: :${PORT}, data ${DATA}, post ${TOKEN ? 'token' : 'open'} ${RATE}/мин, read ${READ_TOKEN ? (READ_REMOTE ? 'token, снаружи' : 'token, только с сервера') : 'off'}, хранение ${RETENTION_DAYS > 0 ? RETENTION_DAYS + ' дн.' : 'всё'}`);
});
