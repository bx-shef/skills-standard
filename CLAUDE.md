# Памятка агенту: bx-shef/skills-standard

Здесь методология и инструменты проверки навыков, не сами навыки. Четыре
части: `STANDARD.md` (правила), `bxshef/` (CLI, npm), `action/` (GitHub
Action), `template/` (заготовка репозитория навыков), `stand/` + `METHOD.md`
(проверка на стенде).

Правило правок: новое правило в STANDARD.md появляется только из провала на
стенде или из отзыва агента — с указанием, что именно провалилось. Правило
без провала — не правило.

Проверка перед сдачей:

```bash
cd bxshef && npm pack && cd ..
npm i --no-save ./bxshef/bxshef-*.tgz
npx bxshef lint --dir template/.agents/skills          # заготовка проходит свой же lint
```

Если меняется `bxshef` — версия в `bxshef/package.json`, запись в
`bxshef/CHANGELOG.md`, и `action/action.yml` должен работать с новой версией.
Слово «bitrix» в собственных именах не используется: инструмент — `bxshef`,
переменные — `BXSHEF_*`, каталог — `.bxshef/`.
