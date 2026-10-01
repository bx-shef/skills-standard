# Приёмник отзывов

Куда ИИ-агенты сами отправляют отзывы о навыках — обычным HTTP POST с JSON по адресу из навыка
отзыва (`<префикс>-feedback`), без bxshef и конфигов. Один файл на Node без
зависимостей, хранение — JSON-файлы в каталоге, Docker.

```bash
cd feedback && make build-local               # на переднем плане: 127.0.0.1:8787, токен чтения — dev
curl -s localhost:8787/health                 # в другом терминале: {"ok":true}
```

`make` без цели печатает список целей. Образ собирает CI (`.github/workflows/feedback-image.yml`)
и публикует в `ghcr.io/bx-shef/skills-standard-feedback:latest` при каждом изменении `feedback/` в main.

## Сервер

Схема та же, что у остальных приложений bx-shef (эталон — `client-bank-alfa-by`): на хосте общий
nginx-proxy + acme-companion (TLS Let's Encrypt) в docker-сети `proxy-net` и общий Watchtower.
Приёмник отдаёт прокси `VIRTUAL_HOST` / `LETSENCRYPT_HOST` — сертификат выпускается и
продлевается сам, своего nginx и certbot нет.

Второй вариант — без своего сервера, на Битрикс24 Вайбкод Black Hole: [VIBECODE.md](VIBECODE.md).

### Один раз на хост

Если на сервере уже есть client-bank, invoice-from-tasks или currency-converter — всё стоит:

```bash
docker network ls | grep proxy-net
docker ps --format '{{.Names}}\t{{.Image}}' | grep -E 'nginx-proxy|acme-companion|watchtower'
```

Чего-то нет — поставить по разделу «Если nginx-proxy / Watchtower ещё не стоят» в
[`client-bank-alfa-by/docs/DEPLOY.md`](https://github.com/bx-shef/client-bank-alfa-by/blob/main/docs/DEPLOY.md):
сеть `proxy-net`, прокси из `currency-converter/docker-compose.nginxproxy.yml`, Watchtower с
`--label-enable`. Второй Watchtower не поднимать.

Пакет `skills-standard-feedback` в GHCR — публичный (Package settings → Change visibility), тогда
серверу и Watchtower не нужен `docker login`.

### Развёртывание

DNS A-запись домена — на сервер **до** `make prod-up`, иначе сертификат не выпустится.
Репозиторий на сервер не нужен: два файла и `.env`.

```bash
mkdir -p /home/bitrix/skills-feedback && cd /home/bitrix/skills-feedback
curl -fsSL -O https://raw.githubusercontent.com/bx-shef/skills-standard/main/feedback/docker-compose.prod.yml
curl -fsSL -O https://raw.githubusercontent.com/bx-shef/skills-standard/main/feedback/Makefile
curl -fsSL -o .env https://raw.githubusercontent.com/bx-shef/skills-standard/main/feedback/.env.example
openssl rand -hex 32             # это значение — в FEEDBACK_READ_TOKEN (.env не выполняет команды)
chmod 600 .env && nano .env      # DOMAIN, LETSENCRYPT_EMAIL, FEEDBACK_READ_TOKEN; остальное — по умолчанию
make prod-up
make doctor                      # контейнер, прокси, https, сертификат, чтение закрыто, диск
make read                        # сводка отзывов
```

Дальше обновления приходят сами: CI публикует образ, Watchtower его подхватывает. Сразу —
`make prod-redeploy`. Новые версии compose-файла и Makefile — `make compose-update`,
`make self-update`. Копия отзывов — `make backup` (в `./backups`), читать — `make read`.

## Подключить навыки

Адрес приёмника — `https://<DOMAIN>/feedback`. Его вписывают **в сам навык отзыва** набора
(раздел «Отправить» в `template/skills/acme-feedback/SKILL.md` — заменить
`feedback.example.org`). Навыки ставятся штатно (`npx skills add <owner/repo>`), и агент
отправляет отзыв сам — одной командой `curl --data-urlencode …`; в проектах ничего ставить и
настраивать не нужно.

Тикет — поля ниже, формой (так шлёт навык) или JSON; ответ
`201 {"success": true, "data": {"id", "category", "title", "status": "NEW", "createdAt"}}`, ошибки
`{"success": false, "error": {"code", "message"}}` (`VALIDATION_ERROR` перечисляет поля).

| Поле | Обяз. | Что |
|---|:-:|---|
| `category` | да | `BUG`, `SUGGESTION`, `DOCS`, `CHAT`, `BOTS`, `OTHER` (регистр не важен) |
| `title` | да | 3–200 символов |
| `body` | да | 10–20000 символов |
| `context` | да | объект до 10 КБ; `skill` — обязательно (имя навыка) |
| `context.outcome` | нет | `done`, `partial`, `failed` |
| `context.helped` | нет | массив строк — что пригодилось (до 20) |
| `context.agent`, `.version`, `.main` | нет | короткие строки |

Тот же тикет принимается **формой** (`application/x-www-form-urlencoded`) — так шлёт навык:
`category`, `title`, `body`, `skill`, `outcome`, `agent`, `version`, `main` плоско, `helped` —
повторяется (`--data-urlencode helped=… --data-urlencode helped=…`). Зачем: JSON в самой команде
(`{"…`) проверки оболочки у агентов не пропускают — Claude Code отклоняет такую команду, — а
форма проходит без файла и без heredoc.

Прочие поля тела и `context` отбрасываются. Для навыков категории значат: `BUG` — навык
расходится с кодом, `DOCS` — неясно или лишнее, `SUGGESTION` — не хватило, `OTHER` — замечаний нет.

**Чистка.** Агенту велено не писать в отзыв проект и секреты, но приёмник на слово не верит: в
`title`, `body` и `helped` до записи на диск заменяются пометкой `[скрыто: …]` ключи и токены
(`vibe_api_…`, `sk-…`, `ghp_…`, JWT, `Bearer …`, AWS, приватные ключи, `password=…`/`token: …`,
длинные hex/base64), адреса (URL), домены, почта, IP, пути (`/home/…`, `C:\…`) и телефоны.
Число замен — в поле `redacted` отзыва. Имена классов, методов, событий и файлы вида
`lang/ru/install.php` остаются.

`bxshef feedback send` шлёт тот же тикет (адрес — `.bxshef.json` или `BXSHEF_FEEDBACK_URL`),
но навыку он не нужен.

## Кто читает

Отзывы читает автор навыков, и только он. Два замка:

- **токен** `FEEDBACK_READ_TOKEN` (в `.env`). Не задан — чтение закрыто совсем (403);
- **откуда**: по умолчанию только с самого сервера — `make read`. Снаружи, через
  `https://<DOMAIN>/feedback.md`, — 403 даже с верным токеном, пока в `.env` не
  `FEEDBACK_READ_REMOTE=1`. Так утёкший токен сам по себе отзывы не открывает.

```bash
make read                      # сводка: навыки и последние замечания
make read SKILL=acme-feedback  # JSON по одному навыку
make read JSON=1               # все отзывы JSON
```

С `FEEDBACK_READ_REMOTE=1` — снаружи с токеном:

```bash
curl -s -H "Authorization: Bearer $FEEDBACK_READ_TOKEN" https://feedback.example.org/feedback.md
```

Подбор токена: после `FEEDBACK_AUTH_FAILS` (5) неверных попыток в минуту с одного адреса —
429 до конца минуты, даже с верным токеном. Сводка экранирует разметку и управляющие символы
из отзывов: `make read` печатает её в терминал, и чужой текст не должен им управлять.

## Лимиты и хранение

- **Отправка**: не больше `FEEDBACK_RATE` (20) в минуту с одного адреса и
  `FEEDBACK_RATE_TOTAL` (300) в минуту всего; сверх — 429 с `Retry-After`. Адрес клиента
  за nginx-proxy — последний в `X-Forwarded-For`, держится только в памяти для счётчика и на
  диск не пишется. `TRUST_PROXY=1` верит заголовку от всей частной сети; строже —
  `TRUST_PROXY=<имя контейнера nginx-proxy>`: тогда соседи по `proxy-net` не подделают адрес.
- **Что принимается**: тикет до 64 КБ (поля — «Подключить навыки»). Сохраняются только
  известные поля, вычищенные, и время приёма — ни IP, ни заголовков, ни посторонних полей.
- **Место**: не больше `FEEDBACK_MAX_FILES` (20000) отзывов и `FEEDBACK_MAX_MB` (200);
  сверх — 507, пока старые не уйдут по сроку. Диск сервера общий — приёмник его не забьёт.
- **Срок**: отзывы старше `FEEDBACK_RETENTION_DAYS` (3) дней удаляются — при старте и раз в
  час; `0` — не удалять. Отзыв — сырьё для правки навыка: за три дня его читают, остальное
  копируйте `make backup`.
- **Токен на отправку** (`FEEDBACK_TOKEN`) — по желанию, для приёмника, куда шлют только свои
  люди и CI: `bxshef feedback send` подставит его из переменной окружения
  `BXSHEF_FEEDBACK_TOKEN` (в `.bxshef.json` не класть — файл коммитят). Навыкам он не
  подходит: адрес и запрос в навыке публичны, токен в нём перестал бы быть секретом — с
  токеном отзывы агентов получат 401.

Как это замыкает цикл: отзыв → правка навыка → PR в репозиторий навыков →
`lint`/`eval` → новая версия, которую агенты получат через `npx skills update`.
