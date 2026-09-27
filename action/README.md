# bx-shef/skills-action

Проверка репозитория навыков для ИИ-агентов на Битриксе. Один и тот же Action в официальных
репозиториях и у энтузиастов — зелёный бейдж значит одно и то же везде.

```yaml
# .github/workflows/skills.yml
name: skills
on: [push, pull_request]
jobs:
  skills:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: bx-shef/skills-standard/action@v1
        with:
          code: .                                     # репозиторий модуля: проверять классы из навыков по коду
          eval-key: ${{ secrets.BXSHEF_EVAL_KEY }}  # необязательно
```

Бейдж в README: `![skills](https://github.com/<owner>/<repo>/actions/workflows/skills.yml/badge.svg)`.

Что проверяется — см. [bxshef](https://www.npmjs.com/package/bxshef): `lint` (оформление, evals, ссылки на код)
и `eval` (выбор навыка по фразе, порог `min-selection`, по умолчанию 0.9 при 3 повторах).
Без секрета `BXSHEF_EVAL_KEY` шаг `eval` пропускается — репозиторий энтузиаста проходит `lint`, а `eval`
ему прогонит модератор перед включением в каталог.
