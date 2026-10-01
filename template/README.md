# Навыки <ваш вендор> для ИИ-агентов на Битриксе

![skills](https://github.com/<owner>/<repo>/actions/workflows/skills.yml/badge.svg)

Установить в проект: `npx skills add <owner>/<repo>`.

Навыки лежат в `skills/<имя>/SKILL.md` по стандарту [Agent Skills](https://agentskills.io) — раскладка
из [STANDARD п. 12](https://github.com/bx-shef/skills-standard/blob/main/STANDARD.md); в проект `npx skills add`
всё равно ставит их в `.agents/skills/`.
Правила — [STANDARD.md](https://github.com/bx-shef/skills-standard/blob/main/STANDARD.md). Проверка — `npx bxshef lint`, `npx bxshef eval`.
