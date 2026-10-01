#!/usr/bin/env node
/**
 * bxshef — проверка навыков для ИИ-агентов (bx-shef).
 *
 * Распространение навыков — не здесь: `npx skills add <owner/repo>` (vercel-labs/skills)
 * ставит навыки из git в .agents/skills / .claude/skills любого агента. bxshef отвечает
 * за качество навыков — в репозитории навыков (GitHub Action) и у разработчика.
 *
 *   npx bxshef lint [--dir <путь>] [--code <путь к коду>]
 *        оформление по стандарту Agent Skills: name = папка, description 80–1024 символов одной
 *        строкой, evals/selection.json у операционных навыков (имя содержит -new- или -use-),
 *        expected ссылается на существующий навык или <none>, у операционных есть шаг «отзыв».
 *        --code: каждый класс вида \Vendor\Ns\Class из текста навыка должен объявляться в коде.
 *   npx bxshef eval [--dir <путь>] [--repeat N] [--min 0.9] [--only <подстрока>] [--agent claude] [--turns 6]
 *        выбор навыка по фразе. По умолчанию — модель по API (BXSHEF_EVAL_KEY, BXSHEF_EVAL_URL,
 *        BXSHEF_EVAL_MODEL; по умолчанию BitrixGPT через AI Router Вайбкода). --agent claude —
 *        настоящий Claude Code в пустом каталоге, только чтение и Skill.
 *   npx bxshef feedback send --skill <имя> --outcome done|partial|failed --task "<строка>"
 *        [--helped "<что пригодилось>"]… [--issue "<missing|wrong|unclear|noise>: <текст>"]…
 *        [--agent <claude-code|codex|cursor|…>] [--version <версия навыка>] [--main <версия main>]
 *        отзыв о навыке из командной строки, без файла: тикет в формате обратной связи
 *        Вайбкода (category, title, body, context) — POST на адрес из .bxshef.json
 *        ({"feedback": "https://…"}), а без него — из BXSHEF_FEEDBACK_URL. --helped и --issue
 *        повторяются; при done нужен хотя бы один --helped. Похожее на секрет не уходит.
 *        Агенту команда не нужна: навык отзыва шлёт тот же тикет сам, curl-ом.
 *        Токен отправки (FEEDBACK_TOKEN приёмника) — только из окружения: BXSHEF_FEEDBACK_TOKEN.
 *   npx bxshef feedback [send] [--dir <путь>]
 *        старый путь: отзывы из файлов .bxshef/feedback/; send — отправить их и удалить.
 *
 * Где искать навыки (--dir не задан): .agents/skills, затем .claude/skills от текущего каталога
 * вверх; либо текущий каталог, если в нём лежат папки с SKILL.md (репозиторий навыков).
 *
 * evals/selection.json: [{ "input": "…", "expected": "<имя>|<none>|[<имя>, <имя>]", "notes": "…" }]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONFIG = '.bxshef.json';
const SKILL_DIRS = ['.agents/skills', '.claude/skills'];

class Fail extends Error {}
const out = (s) => process.stdout.write(s + '\n');
const err = (s) => process.stderr.write(s + '\n');

const argOf = (argv, k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const argsOf = (argv, k) => argv.flatMap((a, i) => (a === k && i + 1 < argv.length ? [argv[i + 1]] : []));

/** Каталог с навыками: --dir, иначе поиск вверх от cwd, иначе cwd, если он сам — репозиторий навыков. */
function skillsRoot(argv) {
  const explicit = argOf(argv, '--dir', null);
  if (explicit) {
    const p = path.resolve(explicit);
    if (!fs.existsSync(p)) throw new Fail(`каталога нет: ${explicit}`);
    return p;
  }
  let dir = process.cwd();
  for (;;) {
    for (const sd of SKILL_DIRS) if (fs.existsSync(path.join(dir, sd))) return path.join(dir, sd);
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (subdirs(process.cwd()).some((d) => fs.existsSync(path.join(d, 'SKILL.md')))) return process.cwd();
  throw new Fail('навыки не найдены: нет .agents/skills или .claude/skills выше по дереву; укажите --dir');
}

/** Корень проекта для .bxshef.json и .bxshef/feedback: от каталога навыков вверх до конфига, иначе cwd. */
function projectRoot(from) {
  let dir = from;
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return process.cwd();
    dir = up;
  }
}

function readConfig(root) {
  const f = path.join(root, CONFIG);
  const env = process.env.BXSHEF_FEEDBACK_URL || null;
  if (!fs.existsSync(f)) return { feedback: env };
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  return { feedback: cfg.feedback ?? env };
}

function subdirs(base) {
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .map((d) => path.join(base, d.name))
    .filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })
    .sort();
}

function frontmatter(dir) {
  const md = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(md)) return null;
  const text = fs.readFileSync(md, 'utf8');
  const fm = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm) return { text, fields: null };
  const fields = {};
  for (const line of fm[1].split('\n')) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) fields[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return { text, fields, raw: fm[1] };
}

/** Ошибка оформления навыка или null. */
function validateSkill(dir) {
  const f = frontmatter(dir);
  if (!f) return 'нет SKILL.md';
  if (!f.fields) return 'нет frontmatter';
  if (!f.fields.name) return 'нет name';
  if (f.fields.name !== path.basename(dir)) return `name «${f.fields.name}» не совпадает с папкой`;
  if (!f.fields.description) return 'нет description';
  return null;
}

function skillMeta(dir) {
  const f = frontmatter(dir);
  return { name: f.fields.name, description: f.fields.description, dir };
}

const OPERATIONAL = /-(new|use|add|make)-/;

/** Проверка оформления по стандарту и по правилам из прогонов. Код 1, если есть ошибки. */
function lint(argv) {
  const base = skillsRoot(argv);
  const code = argOf(argv, '--code', null);
  const dirs = subdirs(base);
  const names = new Set();
  const problems = [];
  const warnings = [];
  const skills = [];
  for (const dir of dirs) {
    const n = path.basename(dir);
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
    const e = validateSkill(dir);
    if (e) { problems.push(`${n}: ${e}`); continue; }
    const f = frontmatter(dir);
    names.add(n);
    skills.push({ name: n, dir, f });
    if (!/^[a-z0-9-]+$/.test(n)) problems.push(`${n}: имя не из [a-z0-9-]`);
    const d = f.fields.description;
    if ([...d].length < 80) problems.push(`${n}: description короче 80 символов — по нему не выбрать`);
    if ([...d].length > 1024) problems.push(`${n}: description длиннее 1024 символов`);
    if (/^description:\s*[>|]/m.test(f.raw)) warnings.push(`${n}: description многострочный (>- или |); стандарт допускает, но не все агенты читают`);
    if (!/^#\s+\S/m.test(f.text)) problems.push(`${n}: нет заголовка`);
    if (/линейки\s+\S+\.\*/i.test(d)) warnings.push(`${n}: описание привязано к вендору («линейки …») — агент не возьмёт навык для модуля другого вендора`);
    if (OPERATIONAL.test(n) && !/feedback/i.test(f.text)) warnings.push(`${n}: операционный навык без шага «отзыв» (упоминания *-feedback)`);
  }
  // evals
  const inputs = new Map();
  for (const s of skills) {
    const ev = path.join(s.dir, 'evals', 'selection.json');
    if (!fs.existsSync(ev)) { if (OPERATIONAL.test(s.name)) problems.push(`${s.name}: операционный навык без evals/selection.json`); continue; }
    let cases;
    try { cases = JSON.parse(fs.readFileSync(ev, 'utf8')); } catch (e) { problems.push(`${s.name}: evals/selection.json не разбирается: ${e.message}`); continue; }
    if (!Array.isArray(cases)) { problems.push(`${s.name}: selection.json — не список`); continue; }
    if (cases.length < 3) problems.push(`${s.name}: меньше трёх фраз в evals`);
    let self = 0, other = 0;
    cases.forEach((c, i) => {
      if (typeof c?.input !== 'string' || [...c.input.trim()].length < 10) { problems.push(`${s.name}[${i}]: input пустой или короче 10 символов`); return; }
      const exp = Array.isArray(c.expected) ? c.expected : [c.expected];
      if (!exp.length || exp.some((x) => typeof x !== 'string' || !x)) { problems.push(`${s.name}[${i}]: нет expected`); return; }
      for (const x of exp) if (x !== '<none>' && !names.has(x)) problems.push(`${s.name}[${i}]: expected «${x}» — такого навыка нет`);
      if (exp.includes(s.name)) self++; else other++;
      const key = c.input.trim().toLowerCase();
      if (inputs.has(key) && inputs.get(key) !== JSON.stringify(exp)) problems.push(`${s.name}[${i}]: та же фраза в другом навыке ждёт ${inputs.get(key)}`);
      inputs.set(key, JSON.stringify(exp));
    });
    if (!self) problems.push(`${s.name}: нет ни одной фразы, где ожидается сам навык`);
    if (!other) problems.push(`${s.name}: нет ни одной фразы на соседа или <none>`);
  }
  // ссылки на код
  if (code) {
    const codeDir = path.resolve(code);
    if (!fs.existsSync(codeDir)) throw new Fail(`--code: каталога нет: ${code}`);
    const declared = new Set();
    walk(codeDir, (file) => {
      if (!/\.php$/.test(file)) return;
      const t = fs.readFileSync(file, 'utf8');
      const ns = (t.match(/^\s*namespace\s+([\w\\]+)\s*;/m) || [])[1] ?? '';
      for (const m of t.matchAll(/^\s*(?:abstract\s+|final\s+)?(?:class|trait|interface|enum)\s+(\w+)/gm)) declared.add((ns ? ns + '\\' : '') + m[1]);
    });
    // Имя из навыка может быть коротким после use (Actions\Normal) — сверяем по хвосту FQN.
    // Корни, которых в коде нет (Bitrix\…, чужие вендоры), не проверяем; примерные
    // вендоры (--ignore, по умолчанию *\Demo\*, Acme\*) — тоже.
    const roots = new Set([...declared].map((c) => c.split('\\')[0]));
    const ignore = (argOf(argv, '--ignore', '*\\Demo\\*,Acme\\*')).split(',').map(glob);
    // Имя считается известным, если это объявленный класс, хвост его FQN или namespace,
    // внутри которого что-то объявлено (навыки часто пишут «всё в namespace X»).
    const known = (cls) => [...declared].some((d) => d === cls || d.endsWith('\\' + cls) || d.startsWith(cls + '\\') || d.includes('\\' + cls + '\\'));
    for (const s of skills) {
      const mentioned = new Set();
      for (const line of s.f.text.split('\n')) {
        if (/не существует|такого класса нет|нет такого класса/i.test(line)) continue; // навык нарочно называет несуществующее
        for (const m of line.matchAll(/\\?([A-Z][\w]*(?:\\[A-Z][\w]*)+)(?![\w\\])/g)) mentioned.add(m[1]);
      }
      for (const cls of mentioned) {
        if (ignore.some((re) => re.test(cls))) continue;
        const root = cls.split('\\')[0];
        if (!roots.has(root) && !known(cls)) continue;   // чужой корень, в этом коде его и не должно быть
        if (!known(cls)) problems.push(`${s.name}: класс ${cls} не найден в ${code}`);
      }
    }
  }
  warnings.forEach((w) => out(`  [ .. ] ${w}`));
  problems.forEach((p) => err(`  [FAIL] ${p}`));
  out(`навыков: ${skills.length}, ошибок: ${problems.length}, предупреждений: ${warnings.length}`);
  return problems.length ? 1 : 0;
}

/** Маска вида Acme\\* → RegExp. */
function glob(mask) {
  return new RegExp('^' + mask.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}

function walk(dir, fn) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/^(\.git|node_modules|vendor)$/.test(e.name)) walk(p, fn); }
    else fn(p);
  }
}

const FEEDBACK_DIR = '.bxshef/feedback';
const SECRET_RE = /(vibe_api_|sk-[a-z0-9]{8,}|Bearer\s+\S{12,}|password|пароль|секрет)/i;

async function evaluate(argv) {
  const arg = (k, d) => argOf(argv, k, d);
  const target = skillsRoot(argv);
  const repeat = Number(arg('--repeat', 1));
  const min = arg('--min', null);
  const agent = arg('--agent', null);           // claude — гонять через настоящий Claude Code, а не через модель по API
  const only = arg('--only', null);             // подстрока: гонять только фразы, где она есть (например, «реальная»)

  const key = process.env.BXSHEF_EVAL_KEY;
  if (!agent && !key) { out('BXSHEF_EVAL_KEY не задан — eval пропущен (или укажите --agent claude)'); return 0; }
  const url = (process.env.BXSHEF_EVAL_URL ?? 'https://vibecode.bitrix24.tech/v1').replace(/\/$/, '') + '/chat/completions';
  const model = agent ? `agent:${agent}` : (process.env.BXSHEF_EVAL_MODEL ?? 'bitrix/bitrixgpt-5.6-agent');

  const skills = subdirs(target).filter((d) => !validateSkill(d)).map(skillMeta);
  const cases = [];
  for (const d of subdirs(target)) {
    const f = path.join(d, 'evals', 'selection.json');
    if (fs.existsSync(f)) for (const c of JSON.parse(fs.readFileSync(f, 'utf8'))) cases.push({ ...c, from: path.basename(d) });
  }
  const selected = only ? cases.filter((c) => (c.input + ' ' + (c.notes ?? '')).includes(only)) : cases;
  if (!selected.length) { out('нет ни одного evals/selection.json — нечего проверять'); return 0; }

  const tools = skills.map((s) => ({
    type: 'function',
    function: { name: s.name, description: s.description, parameters: { type: 'object', properties: {} } },
  }));
  const system = 'Ты ИИ-агент, который пишет код для Битрикса. Тебе доступны навыки как инструменты. ' +
    'Выбери навык, подходящий для задачи пользователя, и вызови его. Если ни один не подходит — ответь текстом без вызова.';

  // expected — имя навыка, "<none>" или массив допустимых: когда два навыка
  // одинаково правильны (справочный и операционный про одно), промах по одному
  // из них — не дефект описания.
  const ok = (exp, got) => (Array.isArray(exp) ? exp : [exp]).includes(got);
  const show = (exp) => (Array.isArray(exp) ? exp.join(' | ') : exp);
  let hit = 0, total = 0;
  const fails = [];
  for (const c of selected) {
    for (let r = 0; r < repeat; r++) {
      if (agent) {
        const got = probeAgent(agent, target, c.input, arg('--turns', 6));
        total++;
        if (ok(c.expected, got)) { hit++; out(`  [ OK ] ${got.padEnd(28)} «${c.input.slice(0, 70)}»`); }
        else fails.push(`  [MISS] «${c.input.slice(0, 90)}» → ${got}, ожидался ${show(c.expected)} (из ${c.from})`);
        continue;
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-api-key': key },
        body: JSON.stringify({ model, temperature: 0, tools, messages: [{ role: 'system', content: system }, { role: 'user', content: c.input }] }),
      });
      if (!res.ok) throw new Fail(`модель ответила ${res.status}: ${await res.text()}`);
      const msg = (await res.json()).choices?.[0]?.message ?? {};
      const got = msg.tool_calls?.[0]?.function?.name ?? '<none>';
      total++;
      if (ok(c.expected, got)) hit++;
      else fails.push(`  [MISS] «${c.input}» → ${got}, ожидался ${show(c.expected)} (из ${c.from})`);
    }
  }
  fails.forEach(err);
  const score = hit / total;
  out(`попаданий: ${hit}/${total} = ${score.toFixed(2)}  (модель ${model}, повторов ${repeat})`);
  if (min !== null && score < Number(min)) { err(`ниже порога ${min}`); return 1; }
  return 0;
}

/**
 * Проверка выбора навыка настоящим агентом. Claude Code запускается в режиме -p
 * в пустом каталоге рядом с проектом, куда подложены собранные навыки; ему
 * разрешены только чтение и Skill, писать нечего. Считается ПЕРВЫЙ вызов Skill
 * за --turns ходов (по умолчанию 6): агент часто сначала осматривается
 * (ls, Glob), и это нормально — важно, к какому навыку он приходит.
 * Медленно (30–90 с на фразу) и стоит токенов: гонять на реальных фразах
 * (--only реальная), а не на всём наборе.
 */
function probeAgent(agent, target, input, turns) {
  if (agent !== 'claude') throw new Fail(`--agent ${agent}: поддерживается только claude`);
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'bxshef-eval-'));
  try {
    fs.mkdirSync(path.join(box, '.claude'));
    fs.mkdirSync(path.join(box, '.claude', 'skills'));
    for (const d of subdirs(target)) if (!validateSkill(d)) fs.cpSync(d, path.join(box, '.claude', 'skills', path.basename(d)), { recursive: true, dereference: true });
    const args = [
      '-p', input, '--output-format', 'stream-json', '--verbose', '--max-turns', String(turns),
      '--allowedTools', 'Skill,Read,Glob,Grep,Bash(ls:*)', '--disallowedTools', 'Write,Edit,WebSearch,WebFetch,Bash',
      '--permission-mode', 'dontAsk', '--strict-mcp-config', '--setting-sources', 'project',
    ];
    if (claudeSupports('--permission-prompts')) args.push('--permission-prompts', 'none');
    const r = spawnSync('claude', args, { cwd: box, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw new Fail(`claude не запустился: ${r.error.message}`);
    // Упавший зонд — ошибка инструмента, а не «навык не выбран»: иначе сломанный
    // eval отчитывается ровным 0/N и выглядит как результат.
    if (r.status !== 0 && !(r.stdout || '').includes('"type":"assistant"')) {
      throw new Fail(`claude завершился с кодом ${r.status}:\n${(r.stderr || r.stdout || '').trim().slice(0, 800)}`);
    }
    for (const line of (r.stdout || '').split('\n')) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== 'assistant') continue;
      for (const c of o.message?.content ?? []) {
        if (c.type === 'tool_use' && c.name === 'Skill') return String(c.input?.skill ?? c.input?.command ?? '').replace(/^\//, '').split(/\s/)[0] || '<none>';
      }
    }
    return '<none>';
  } finally {
    fs.rmSync(box, { recursive: true, force: true });
  }
}

/** Есть ли у установленного claude такой флаг — по тексту --help, один раз. */
let claudeHelp = null;
function claudeSupports(flag) {
  if (claudeHelp === null) {
    const r = spawnSync('claude', ['-p', '--help'], { encoding: 'utf8' });
    if (r.error) throw new Fail(`claude не найден в PATH: ${r.error.message}`);
    claudeHelp = (r.stdout || '') + (r.stderr || '');
  }
  return claudeHelp.includes(flag);
}

const KINDS = ['missing', 'wrong', 'unclear', 'noise'];
const OUTCOMES = ['done', 'partial', 'failed'];
// Вид замечания → категория тикета Вайбкода; у тикета одна категория — самого серьёзного.
const CATEGORY = { wrong: 'BUG', unclear: 'DOCS', noise: 'DOCS', missing: 'SUGGESTION' };
const SEVERITY = ['BUG', 'DOCS', 'SUGGESTION', 'OTHER'];

/** POST тикета. Токен — только из окружения: .bxshef.json коммитят в проект, токен стал бы публичным. */
function postTicket(url, ticket) {
  const headers = { 'content-type': 'application/json' };
  if (process.env.BXSHEF_FEEDBACK_TOKEN) headers.authorization = `Bearer ${process.env.BXSHEF_FEEDBACK_TOKEN}`;
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(ticket) });
}

/** Почему приёмник не принял — по-человечески: 401 — токен, 429 — подождать, 400 — что не так. */
async function whyRejected(res) {
  if (res.status === 401) return `401 — токен не принят: задайте BXSHEF_FEEDBACK_TOKEN${process.env.BXSHEF_FEEDBACK_TOKEN ? ' верный' : ''}`;
  if (res.status === 429) return `429 — приёмник просит подождать ${res.headers.get('retry-after') ?? '?'} с`;
  let msg = '';
  try { msg = (await res.json())?.error?.message ?? ''; } catch { /* не JSON */ }
  return msg ? `${res.status} — ${msg}` : String(res.status);
}

/** Отзыв (skill, task, outcome, issues, helped, …) → тикет приёмника: category, title, body, context. */
function toTicket(o) {
  const cats = (o.issues || []).map((i) => CATEGORY[i.kind] ?? 'OTHER');
  const category = SEVERITY.find((c) => cats.includes(c)) ?? 'OTHER';
  const lines = [`Итог: ${o.outcome ?? '?'}.`];
  for (const i of o.issues || []) lines.push(`[${i.kind}] ${i.text}`);
  if (!(o.issues || []).length) lines.push('Замечаний нет.');
  if ((o.helped || []).length) lines.push(`Помогло: ${o.helped.join('; ')}.`);
  const context = { skill: o.skill, outcome: o.outcome };
  for (const k of ['agent', 'version', 'main']) if (o[k] && o[k] !== '?') context[k] = o[k];
  if ((o.helped || []).length) context.helped = o.helped;
  return { category, title: `${o.skill}: ${o.task ?? 'задача'}`.slice(0, 200), body: lines.join('\n'), context };
}

/** Отзыв из параметров вызова: собрать, проверить, отправить одним POST. Файлов не пишет. */
async function feedbackDirect(argv) {
  const one = (k) => { const v = argOf(argv, k, null); return v === null ? null : String(v).trim(); };
  const body = {
    skill: one('--skill'),
    version: one('--version') ?? '?',
    agent: one('--agent') ?? '?',
    main: one('--main') ?? '?',
    task: one('--task'),
    outcome: one('--outcome'),
    issues: argsOf(argv, '--issue').map((raw) => {
      const m = /^\s*([a-z]+)\s*:\s*(.+)$/s.exec(raw);
      if (!m || !KINDS.includes(m[1])) throw new Fail(`--issue «${raw}»: нужно «<${KINDS.join('|')}>: <текст>»`);
      return { kind: m[1], text: m[2].trim() };
    }),
    helped: argsOf(argv, '--helped').map((h) => h.trim()).filter(Boolean),
  };
  if (!body.skill) throw new Fail('--skill: имя навыка обязательно');
  if (!body.task) throw new Fail('--task: задача в одну строку обязательна');
  if (!OUTCOMES.includes(body.outcome)) throw new Fail(`--outcome: одно из ${OUTCOMES.join(', ')}`);
  if (body.outcome === 'done' && !body.helped.length) throw new Fail('--helped: при done нужен хотя бы один — что пригодилось');
  if (SECRET_RE.test(JSON.stringify(body))) { err('похоже на секрет — отзыв не отправлен; переформулируйте без ключей и паролей'); return 1; }

  const url = readConfig(projectRoot(process.cwd())).feedback;
  if (!url) { err('адрес для отзывов не задан: "feedback" в .bxshef.json или BXSHEF_FEEDBACK_URL — отзыв не отправлен'); return 1; }
  let res;
  try { res = await postTicket(url, toTicket(body)); }
  catch (e) { err(`отзыв не отправлен: ${e.cause?.code ?? e.message}`); return 1; }
  if (!res.ok) { err(`отзыв не отправлен: ${await whyRejected(res)}`); return 1; }
  out(`отзыв отправлен: ${body.skill} (${body.outcome}), замечаний: ${body.issues.length}`);
  return 0;
}

async function feedback(argv) {
  if (argv[0] === 'send' && argv.includes('--skill')) return feedbackDirect(argv);
  const root = projectRoot(argOf(argv, '--dir', process.cwd()));
  const dir = path.join(root, FEEDBACK_DIR);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  if (!files.length) { out('отзывов нет'); return 0; }
  const items = [];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!j.skill || !Array.isArray(j.issues)) throw new Error('нет skill или issues');
      const raw = JSON.stringify(j);
      if (SECRET_RE.test(raw)) { err(`  [ !! ] ${f}: похоже на секрет — не отправлю, проверьте руками`); continue; }
      items.push({ file: f, ...j });
    } catch (e) { err(`  [ .. ] ${f}: пропущен (${e.message})`); }
  }
  for (const it of items) {
    out(`${it.file}  ${it.skill}@${it.version ?? '?'}  ${it.outcome ?? '?'}  issues: ${it.issues.length}`);
    for (const i of it.issues) out(`    [${i.kind}] ${i.text}`);
  }
  if (argv[0] !== 'send') return 0;
  const url = readConfig(root).feedback;
  if (!url) { err('адрес для отзывов не задан: "feedback" в .bxshef.json или BXSHEF_FEEDBACK_URL'); return 1; }
  let sent = 0;
  for (const it of items) {
    const { file, ...body } = it;
    let res;
    try { res = await postTicket(url, toTicket(body)); } catch (e) { err(`  [FAIL] ${file}: ${e.cause?.code ?? e.message}`); continue; }
    if (!res.ok) { err(`  [FAIL] ${file}: ${await whyRejected(res)}`); if (res.status === 429 || res.status === 401) break; continue; }
    fs.unlinkSync(path.join(dir, file)); sent++;
  }
  out(`отправлено: ${sent}/${items.length}`);
  return sent === items.length ? 0 : 1;
}


function usage() {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  out(src.slice(src.indexOf('/**') + 3, src.indexOf('*/')).replace(/^ \* ?/gm, ''));
}

const cmd = process.argv[2];
const rest = process.argv.slice(3);
const finish = (p) => Promise.resolve(p).then((c) => process.exit(c)).catch((e) => {
  if (e instanceof Fail) { err('[FAIL] ' + e.message); process.exit(2); }
  throw e;
});
if (cmd === 'lint') finish(lint(rest));
else if (cmd === 'eval') finish(evaluate(rest));
else if (cmd === 'feedback') finish(feedback(rest));
else if (cmd === 'sync' || cmd === 'check' || cmd === 'list') { err(`«${cmd}» больше нет: навыки ставит npx skills add <owner/repo> (vercel-labs/skills); bxshef — lint, eval, feedback`); process.exit(2); }
else usage();
