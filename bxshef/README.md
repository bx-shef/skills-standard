# bxshef — проверка навыков для ИИ-агентов (bx-shef)

Навыки (стандарт [Agent Skills](https://agentskills.io)) для коробочного Битрикс24 и БУС живут в git-репозиториях —
официальных и от энтузиастов. **Ставит их не bxshef**, а общий инструмент экосистемы:

```bash
npx skills add bx-shef/options          # навыки модуля shef.options — в .agents/skills / .claude/skills
npx skills add bx-shef/skills           # навыки базы и облака
npx skills check                        # есть ли обновления (skills-lock.json)
```

`bxshef` отвечает за **качество** навыков — в репозитории навыков (через GitHub Action) и у разработчика:

| команда | что делает | код 1, если |
|---|---|---|
| `npx bxshef lint [--dir …] [--code …]` | оформление по стандарту и по правилам из прогонов на стенде | есть ошибки |
| `npx bxshef eval [--repeat 3] [--min 0.9] [--only …] [--agent claude]` | выбирает ли модель нужный навык по фразе | ниже порога |
| `npx bxshef feedback [send]` | отзывы ИИ-агента о навыках; `send` — отправить на адрес из `.bxshef.json` | отправка не удалась |

Где искать навыки, если `--dir` не задан: `.agents/skills`, затем `.claude/skills` от текущего каталога вверх;
либо текущий каталог, если это репозиторий навыков (папки с `SKILL.md`).

## lint

- `SKILL.md` есть; `name` = имя папки, из `[a-z0-9-]`; `description` 80–1024 символов; есть заголовок.
- У операционных навыков (имя содержит `-new-`, `-use-`, `-add-`, `-make-`) есть `evals/selection.json`,
  в нём ≥ 3 фраз, есть фраза «на себя» и фраза на соседа или `<none>`, `expected` ссылается на существующий навык.
- Предупреждения: описание привязано к вендору («линейки shef.\*» — в прогоне агент не брал такой навык для
  модуля другого вендора); операционный навык без шага «отзыв».
- `--code <путь>`: каждый класс вида `Vendor\Ns\Class` из текста навыка объявлен в коде (по хвосту FQN или как
  namespace). `Bitrix\*` и корни, которых в коде нет, не проверяются; примерные вендоры — `--ignore '*\Demo\*,Acme\*'`.
  Строки со словами «не существует» пропускаются — навык вправе назвать неверный класс, чтобы предостеречь.

## eval

`evals/selection.json` у навыка:

```json
[
  { "input": "сделай агент импорта прайса раз в час", "expected": "shef-new-agent" },
  { "input": "добавь вторую вкладку в настройки", "expected": ["shef-new-option", "shef-options-settings"], "notes": "оба верны" },
  { "input": "поправь опечатку в lang-файле", "expected": "<none>" }
]
```

По умолчанию — модель по API: описания всех навыков отдаются как инструменты, считается первый выбор.
BitrixGPT через AI Router Вайбкода (`BXSHEF_EVAL_KEY`, `BXSHEF_EVAL_URL`, `BXSHEF_EVAL_MODEL`); любой
OpenAI-совместимый endpoint подходит. Без ключа — пропуск с кодом 0.

`--agent claude` — настоящий Claude Code: для каждой фразы поднимается пустой каталог с навыками, `claude -p`
с правами только на чтение и `Skill`, засчитывается первый вызванный навык за `--turns` ходов. 30–90 с на фразу;
гонять с `--only` на реальных фразах. Нужна обычная авторизация Claude Code, ключ API не нужен. Ставьте
`--repeat 3`: выбор стохастичен.

## feedback

Навык `shef-feedback` велит ИИ-агенту после задачи положить JSON в `.bxshef/feedback/`:
навык, версия, что помогло (`helped`), что не так (`issues`: `missing` / `wrong` / `unclear` / `noise`).
Без кода проекта, путей, клиентов, секретов. Отправляет человек или CI; строки, похожие на секрет, не уходят.
Адрес — `{"feedback": "https://…"}` в `.bxshef.json` корня проекта; без него `send` завершается с кодом 1.

## В репозитории навыков

```yaml
# .github/workflows/skills.yml
on: [push, pull_request]
jobs:
  skills:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: bx-shef/skills-action@v1
        with:
          eval-key: ${{ secrets.BXSHEF_EVAL_KEY }}   # без ключа шаг eval пропускается
          min-selection: 0.9
```

Action делает `lint --code .`, `eval --repeat 3 --min 0.9`. Зелёный бейдж — условие попадания в каталог.
