# bxshef — методология и проверка навыков ИИ-агентов для Битрикса

Навык — папка со `SKILL.md` по открытому стандарту
[Agent Skills](https://agentskills.io): ИИ-агент (Claude Code, Codex, Cursor
и другие) читает описание, сам берёт нужный навык под задачу и делает по
канону модуля. Здесь — не навыки, а **как их писать и как проверять, что им
можно верить**. Правила выведены из трёх прогонов на стенде и записаны с
провалами, которые их породили.

```
STANDARD.md   правила навыка — 11 пунктов
METHOD.md     методология проверки: lint → eval → стенд; что измерено
bxshef/       CLI: lint · eval · feedback (npm: bxshef)
action/       GitHub Action: тот же lint + eval в любом репозитории навыков
template/     заготовка репозитория навыков для вашего модуля
stand/        обвязка стенда (bx.php) и образец задач с чек-листами
```

## Быстрый старт для автора модуля

```bash
# 1. репозиторий навыков из заготовки
cp -r template/ ../acme-skills && cd ../acme-skills
#    переименовать acme-* в свой префикс, написать первый навык по STANDARD.md

# 2. проверить локально
npx bxshef lint --dir .agents/skills --code ../acme.module
BXSHEF_EVAL_KEY=… npx bxshef eval --dir .agents/skills --repeat 3

# 3. в CI — уже есть: .github/workflows/skills.yml зовёт bx-shef/skills-standard/action@v1
```

Пользователь ставит ваши навыки командой `npx skills add <owner>/acme-skills`
([skills](https://github.com/vercel-labs/skills) от Vercel) — своего
установщика здесь нет и не будет.

## Эталон

[bx-shef/skills](https://github.com/bx-shef/skills) — 16 навыков к модулям
shef.options, shef.problems, shef.insync, собранные по этому стандарту. На них
стандарт и проверялся.

## Что проверяет `bxshef`

| команда | что | падает |
|---|---|---|
| `bxshef lint [--dir] [--code] [--ignore]` | frontmatter, длина описания, evals у операционных, противоречия в evals, классы из навыка существуют в коде | есть ошибки |
| `bxshef eval [--repeat 3] [--min 0.9] [--only …] [--agent claude]` | по фразе задачи модель или настоящий Claude Code выбирает нужный навык | доля попаданий ниже порога |
| `bxshef feedback [send]` | отзывы ИИ-агента из `.bxshef/feedback/`; `send` — на адрес из `.bxshef.json` | отправка не удалась |

Ключ модели для `eval` — только из окружения (`BXSHEF_EVAL_KEY`), в файлы не
пишется. По умолчанию — BitrixGPT через AI Router Вайбкода
(`BXSHEF_EVAL_URL`, `BXSHEF_EVAL_MODEL` переопределяют).

## Лицензия

MIT. Ограничений на использование методологии нет — цель в том, чтобы её
взяли.
