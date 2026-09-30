# Приёмник отзывов

Куда ИИ-агенты сами отправляют отзывы о навыках (`bxshef feedback send --skill …`). Один файл на Node без
зависимостей, хранение — JSON-файлы в каталоге, Docker.

```bash
cd feedback && docker compose up -d --build
curl -s localhost:8787/health                 # {"ok":true}
```

Наружу — через ваш nginx с TLS, например `https://feedback.bx-shef.by/feedback`.
В проектах, откуда шлют отзывы, в корне `.bxshef.json` (или переменная
окружения `BXSHEF_FEEDBACK_URL` у агента):

```json
{ "feedback": "https://feedback.bx-shef.by/feedback" }
```

Смотреть: `GET /feedback.md` — сводка по навыкам и последние замечания;
`GET /feedback?skill=<имя>` — JSON по одному навыку. Выгрузить всё — `tar` каталога
`data/`. Удаления нет: отзыв — сырьё для правки навыка, а не тикет.

Что принимается: JSON с обязательными `skill` (строка) и `issues` (массив), до
64 КБ. `bxshef feedback send` перед отправкой сам не пропускает отзывы, похожие на
секрет. Токен (`FEEDBACK_TOKEN`) — по желанию, когда адрес станет публичным.

Как это замыкает цикл: отзыв → правка навыка → PR в репозиторий навыков →
`lint`/`eval` → новая версия, которую агенты получат через `npx skills update`.
