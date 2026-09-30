# Приёмник отзывов

Куда ИИ-агенты сами отправляют отзывы о навыках (`bxshef feedback send --skill …`). Один файл на Node без
зависимостей, хранение — JSON-файлы в каталоге, Docker.

```bash
cd feedback && make build-local               # 127.0.0.1:8787, токен чтения — dev
curl -s localhost:8787/health                 # {"ok":true}
```

`make` без цели печатает список целей. Образ собирает CI (`.github/workflows/feedback-image.yml`)
и публикует в `ghcr.io/bx-shef/skills-standard-feedback:latest` при каждом изменении `feedback/` в main.

## Сервер

Схема та же, что у остальных приложений bx-shef (эталон — `client-bank-alfa-by`): на хосте общий
nginx-proxy + acme-companion (TLS Let's Encrypt) в docker-сети `proxy-net` и общий Watchtower.
Приёмник отдаёт прокси `VIRTUAL_HOST` / `LETSENCRYPT_HOST` — сертификат выпускается и
продлевается сам, своего nginx и certbot нет.

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
chmod 600 .env && nano .env      # DOMAIN, LETSENCRYPT_EMAIL, FEEDBACK_READ_TOKEN=$(openssl rand -hex 32)
                                 # остальное — лимиты и срок хранения, значения по умолчанию годятся
make prod-up
make doctor                      # контейнер, прокси, https, сертификат, чтение закрыто, диск
make read                        # сводка отзывов
```

Дальше обновления приходят сами: CI публикует образ, Watchtower его подхватывает. Сразу —
`make prod-redeploy`. Новые версии compose-файла и Makefile — `make compose-update`,
`make self-update`. Копия отзывов — `make backup` (в `./backups`), читать — `make read`.

## Проекты

Адрес приёмника — `https://<DOMAIN>/feedback`, например `https://feedback.example.org/feedback`.
В проектах, откуда шлют отзывы, в корне `.bxshef.json` (или переменная
окружения `BXSHEF_FEEDBACK_URL` у агента):

```json
{ "feedback": "https://feedback.example.org/feedback" }
```

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
429 до конца минуты, даже с верным токеном.

## Лимиты и хранение

- **Отправка**: не больше `FEEDBACK_RATE` (20) в минуту с одного адреса и
  `FEEDBACK_RATE_TOTAL` (300) в минуту всего; сверх — 429 с `Retry-After`. Адрес клиента
  за nginx-proxy — из `X-Forwarded-For` (`TRUST_PROXY=1` в прод-compose), держится только в
  памяти для счётчика и на диск не пишется.
- **Что принимается**: JSON с обязательными `skill` (строка) и `issues` (массив), до 64 КБ.
  `bxshef feedback send` сам не пропускает отзывы, похожие на секрет. Хранится только тело
  отзыва и время приёма — ни IP, ни заголовков.
- **Срок**: отзывы старше `FEEDBACK_RETENTION_DAYS` (3) дней удаляются — при старте и раз в
  час; `0` — не удалять. Отзыв — сырьё для правки навыка: за три дня его читают, остальное
  копируйте `make backup`.
- **Токен на отправку** (`FEEDBACK_TOKEN`) — по желанию; `bxshef` его пока не отправляет,
  так что с ним `send` получит 401.

Как это замыкает цикл: отзыв → правка навыка → PR в репозиторий навыков →
`lint`/`eval` → новая версия, которую агенты получат через `npx skills update`.
