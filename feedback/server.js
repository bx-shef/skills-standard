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
 * Чтение (оба GET /feedback*) — только с заголовком Authorization: Bearer
 * <FEEDBACK_READ_TOKEN>. Токен не задан — чтение закрыто совсем (403): отзывы
 * читает автор навыков, а не любой, кто знает адрес.
 *
 * Хранение: один файл на отзыв в DATA_DIR (по умолчанию ./data), имя —
 * <дата>-<навык>-<случайно>.json. Ничего не удаляет; выгрузка — обычный tar каталога.
 * Хранится только тело отзыва и время приёма — ни IP, ни заголовков запроса.
 *
 * Защита от мусора: тело до 64 КБ, обязательные skill (строка) и issues
 * (массив); необязательный токен FEEDBACK_TOKEN — тогда POST требует заголовок
 * Authorization: Bearer <токен>. bxshef его пока не отправляет, поэтому по
 * умолчанию токен выключен.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8787);
const DATA = path.resolve(process.env.DATA_DIR || './data');
const TOKEN = process.env.FEEDBACK_TOKEN || '';
const READ_TOKEN = process.env.FEEDBACK_READ_TOKEN || '';
const MAX = 64 * 1024;
fs.mkdirSync(DATA, { recursive: true });

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const text = (res, code, body) => { res.writeHead(code, { 'content-type': 'text/markdown; charset=utf-8' }); res.end(body); };
const safe = (s) => String(s).replace(/[^a-z0-9-]/gi, '_').slice(0, 60);
const bearer = (req, token) => {
  const a = Buffer.from(req.headers.authorization || '');
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
// Ответ, если читать нельзя; null — можно.
const denyRead = (req) => !READ_TOKEN ? [403, 'чтение выключено: задайте FEEDBACK_READ_TOKEN']
  : !bearer(req, READ_TOKEN) ? [401, 'token'] : null;

function readAll() {
  return fs.readdirSync(DATA).filter((f) => f.endsWith('.json')).sort().map((f) => {
    try { return { file: f, ...JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')) }; } catch { return null; }
  }).filter(Boolean);
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
  for (const it of items.slice(-30).reverse()) for (const i of it.issues) md += `- **${it.skill}**@${it.version ?? '?'} [${i.kind}] ${i.text}\n`;
  return md;
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
  if (req.method === 'GET' && (url.pathname === '/feedback' || url.pathname === '/feedback.md')) {
    const deny = denyRead(req);
    if (deny) return json(res, deny[0], { error: deny[1] });
  }
  if (req.method === 'GET' && url.pathname === '/feedback') {
    const skill = url.searchParams.get('skill');
    return json(res, 200, readAll().filter((it) => !skill || it.skill === skill));
  }
  if (req.method === 'GET' && url.pathname === '/feedback.md') return text(res, 200, summary(readAll()));
  if (req.method === 'POST' && url.pathname === '/feedback') {
    if (TOKEN && !bearer(req, TOKEN)) return json(res, 401, { error: 'token' });
    let body = ''; let over = false;
    req.on('data', (c) => { body += c; if (body.length > MAX) { over = true; req.destroy(); } });
    req.on('end', () => {
      if (over) return json(res, 413, { error: 'too large' });
      let j; try { j = JSON.parse(body); } catch { return json(res, 400, { error: 'json' }); }
      if (typeof j.skill !== 'string' || !Array.isArray(j.issues)) return json(res, 400, { error: 'skill и issues обязательны' });
      const name = `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${safe(j.skill)}-${crypto.randomBytes(3).toString('hex')}.json`;
      fs.writeFileSync(path.join(DATA, name), JSON.stringify({ ...j, receivedAt: new Date().toISOString() }, null, 1));
      return json(res, 201, { ok: true, id: name });
    });
    return;
  }
  json(res, 404, { error: 'not found' });
}).listen(PORT, () => console.log(`bxshef feedback: :${PORT}, data ${DATA}, post ${TOKEN ? 'token' : 'open'}, read ${READ_TOKEN ? 'token' : 'off'}`));
