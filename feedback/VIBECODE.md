# Приёмник на Вайбкод Black Hole

Второй таргет рядом с сервером за nginx-proxy (`README.md`, «Сервер»). Black Hole — закрытая
виртуальная машина Битрикс24 Вайбкод: без SSH и публичного IP, управление по REST, приложение
слушает `:3000` и отдаётся по `https://app-<id>.vibecode.bitrix24.tech`. Своих nginx, certbot и
Docker не нужно — HTTPS даёт платформа. Схема та же, что у соседних приложений bx-shef
(`client-bank-alfa-by`, `smart-links`: `deploy/vibecode-deploy.sh`), только проще: приёмник —
один `server.js` без зависимостей и без сборки.

Документация платформы: `https://vibecode.bitrix24.tech/llms-full.txt` (раздел `infra`).

## Что делает `vibecode.sh`

| Команда | Что | Make |
|---|---|---|
| `./vibecode.sh deploy` | архив с `server.js` → `POST /v1/infra/servers/:id/deploy` | `make vibe-deploy` |
| `./vibecode.sh read` | сводка отзывов изнутри сервера через `exec` | `make vibe-read` |
| `./vibecode.sh logs` | журнал приложения | `make vibe-logs` |
| `./vibecode.sh status` | статус, туннель, адрес, уровень доступа, авто-сон | `make vibe-status` |

Выкладка:
- архив собирается из рабочей копии и уходит в теле запроса (`source.content`) — ни публичный
  URL, ни раскладка архива GitHub не нужны;
- рантайм `node20`, запуск `cd /opt/app && exec node server.js`, проверка `GET /health`;
- отзывы — в `/var/lib/skills-feedback/data` (`dataDirs`): чистый деплой стирает `/opt/app`
  целиком, а этот каталог переживает любое число выкладок, сон и перезапуски;
- без `FEEDBACK_READ_TOKEN` в `ENV_JSON` выкладка отказывается: такой приёмник не прочитать.

## Первая выкладка — руками

```bash
cd feedback
export VIBE_KEY=vibe_api_…                     # не коммитить; только окружение
export ENV_JSON='{"FEEDBACK_READ_TOKEN":"<вывод openssl rand -hex 32>"}'
VIBE_CREATE=1 make vibe-deploy                 # создаст сервер skills-feedback (платно) и выложит
make vibe-status                               # appUrl, accessPolicy, sleepAfterMinutes
```

Сервер создаётся только с `VIBE_CREATE=1`: это платное действие. Тариф — `VIBE_PLAN`
(по умолчанию `bc-micro`: 600 вайбов в месяц, во сне 130; на демо-доступе разрешён только он).

### Уровень доступа — «Публичный»

Агенты шлют отзывы из CLI без входа в Битрикс24, а не-публичный сервер отвечает им
`401 BH_LOGIN_REQUIRED`. Нужен «Публичный». Это решение владельца, скрипт его не меняет —
в кабинете или вызовом:

```bash
curl -fsS -X PATCH -H "X-Api-Key: $VIBE_KEY" -H 'Content-Type: application/json' \
  -d '{"accessPolicy":"PUBLIC"}' https://vibecode.bitrix24.tech/v1/infra/servers/<id>/access-policy
```

«Публичный» открывает сеть, не отзывы: чтение по-прежнему закрыто токеном и местом (ниже).

### Авто-сон

По умолчанию сервер засыпает через 60 минут без входящих запросов. POST, который будит спящий
сервер, до приёмника **не доходит** — шлюз отвечает `503 BH_SERVER_WAKING` с `Retry-After`.
Навык отзыва велит агенту подождать (до 90 с) и повторить один раз; машина просыпается «от
минуты», так что изредка отзыв всё же теряется. Надёжно — выключить сон (дороже: полная цена
вместо цены сна): `PATCH /v1/infra/servers/<id>/sleep` с `{"sleepAfterMinutes": null}`.

`deploy`, `read`, `logs` будят сервер сами и ждут до 6,5 минуты.

## Кто читает

Как и на nginx-сервере — только владелец:
- туннель шлюза приходит к приложению с `127.0.0.1`, но всегда с заголовком
  `X-Vibe-Request-Id` — приёмник считает такой запрос внешним и отвечает 403 даже с токеном
  (пока не `FEEDBACK_READ_REMOTE=1`);
- `make vibe-read` выполняет чтение на самой машине через `exec` (ключ `VIBE_KEY` у владельца):
  запрос с `127.0.0.1` без заголовков шлюза, токен берётся из `.env` приложения и наружу не
  выходит.

```bash
make vibe-read                   # сводка
make vibe-read SKILL=acme-x      # JSON по навыку
make vibe-read JSON=1            # все отзывы JSON
```

## Лимиты за шлюзом

Адреса клиента шлюз не передаёт: для приёмника все запросы приходят с одного адреса. Поэтому
«в минуту с адреса» здесь — общий лимит, а блокировка подбора токена — общая на минуту. Разумно
поднять `FEEDBACK_RATE` до уровня `FEEDBACK_RATE_TOTAL`, например
`{"FEEDBACK_READ_TOKEN":"…","FEEDBACK_RATE":"60","FEEDBACK_RATE_TOTAL":"60"}`. Остальное —
срок хранения 3 дня, предел хранилища, 64 КБ на отзыв — как на nginx-сервере (`README.md`).

## Выкладка из CI

`.github/workflows/feedback-vibecode.yml` — на push в main, когда меняются `feedback/server.js`
или `feedback/vibecode.sh`, и вручную. **Opt-in**: джоба идёт, только когда переменная
репозитория `VIBECODE_DEPLOY` = `true`. Settings → Secrets and variables → Actions:

| Тип | Имя | Значение |
|---|---|---|
| Secret | `VIBE_KEY` | `vibe_api_…` |
| Secret | `FEEDBACK_VIBE_ENV` | JSON окружения, как `ENV_JSON` выше |
| Variable | `VIBECODE_DEPLOY` | `true` — включатель |
| Variable | `VIBECODE_APP_NAME` | имя сервера, если не `skills-feedback` |

Сервер CI не создаёт — только выкладывает на уже созданный. Лимит платформы — 10 выкладок в
минуту на сервер.

## Адрес в навыке

После выкладки впишите `https://app-<id>.vibecode.bitrix24.tech/feedback` в раздел «Отправить»
навыка отзыва набора (`README.md`, «Подключить навыки»). Если сервер спит, первый запрос
получает `503` с `Retry-After` — навык велит агенту подождать и повторить один раз, так что
отзыв не теряется, если сервер проснулся за это время.
