# Навыки <ваш вендор> для ИИ-агентов на Битриксе

![skills](https://github.com/<owner>/<repo>/actions/workflows/skills.yml/badge.svg)

Установить в проект: `npx skills add <owner>/<repo>`.

Навыки лежат в `skills/<имя>/SKILL.md` по стандарту [Agent Skills](https://agentskills.io) — раскладка
из [STANDARD п. 12](https://github.com/bx-shef/skills-standard/blob/main/STANDARD.md); в проект `npx skills add`
всё равно ставит их в `.agents/skills/`.
Правила — [STANDARD.md](https://github.com/bx-shef/skills-standard/blob/main/STANDARD.md). Проверка — `npx bxshef lint`, `npx bxshef eval`.

## Что положить в репозиторий модуля

Навыков в модуле нет — только ссылки на этот репозиторий: раздел «Для ИИ-агентов» в
`README.md`, абзац в `CLAUDE.md`/`AGENTS.md`, `suggest` в `composer.json` и CI
[`module/skills.yml`](module/skills.yml), который проверяет, что навыки не разошлись с кодом
модуля. Подробно — [STANDARD п. 11](https://github.com/bx-shef/skills-standard/blob/main/STANDARD.md).
