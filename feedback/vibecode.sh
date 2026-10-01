#!/usr/bin/env bash
# Приёмник отзывов на сервере Битрикс24 Вайбкод Black Hole (VIBECODE.md). Та же схема, что у
# соседних приложений bx-shef (client-bank-alfa-by, smart-links: deploy/vibecode-deploy.sh),
# но без сборки: приёмник — один server.js без зависимостей.
#
#   ./vibecode.sh deploy   выложить server.js (сервер ищется по APP_NAME)
#   ./vibecode.sh read     сводка отзывов; READ=json — все JSON, SKILL=<имя> — по навыку
#   ./vibecode.sh logs     последние строки журнала приложения (LINES, по умолчанию 100)
#   ./vibecode.sh status   состояние сервера: статус, туннель, адрес, доступ, авто-сон
#
# Окружение:
#   VIBE_KEY      vibe_api_… — личный ключ, владеет сервером и оплатой. Только из окружения.
#   APP_NAME      имя сервера, по умолчанию skills-feedback
#   ENV_JSON      для deploy: JSON с окружением приёмника; FEEDBACK_READ_TOKEN обязателен
#   VIBE_CREATE=1 для deploy: создать сервер, если его нет (это платно — поэтому только явно)
#   VIBE_PLAN     тариф нового сервера, по умолчанию bc-micro (на демо-доступе — только он)
#   VIBE_REGION   по умолчанию ru-central1-b
#   VIBE_RUNTIME  по умолчанию node20 (список — GET /v1/infra/runtimes)
#   VIBE_BASE     по умолчанию https://vibecode.bitrix24.tech/v1
#
# Уровень доступа («Публичный» — чтобы агенты могли отправлять отзывы без входа в Битрикс24) и
# авто-сон скрипт НЕ меняет: оба — решения владельца, в кабинете или вызовом из VIBECODE.md.

set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="${APP_NAME:-skills-feedback}"
BASE="${VIBE_BASE:-https://vibecode.bitrix24.tech/v1}"
# Данные — вне /opt/app: чистый деплой стирает его целиком, а каталоги из dataDirs переживают
# любое число выкладок и принадлежат учётной записи приложения.
DATA_DIR=/var/lib/skills-feedback/data

api() { curl -fsS --connect-timeout 15 -H "X-Api-Key: $VIBE_KEY" "$@"; }
py() { python3 -c "$1"; }

server_id() {
  APP_NAME="$APP_NAME" py '
import sys, json, os
d = json.load(sys.stdin)
print(next((s["id"] for s in d.get("data", []) if s.get("name") == os.environ["APP_NAME"]), ""))
' < <(api "$BASE/infra/servers")
}

need_server() {
  sid="$(server_id)"
  [ -n "$sid" ] || { echo "сервер '$APP_NAME' не найден — deploy с VIBE_CREATE=1 создаст его" >&2; exit 1; }
}

# Выполнить команду на сервере (от root) и вернуть её stdout; спящий сервер exec будит сам.
run() {
  local body out
  body="$(CMD="$1" py 'import json, os; print(json.dumps({"command": os.environ["CMD"], "timeout": 60}))')"
  out="$(api -X POST "$BASE/infra/servers/$sid/exec" -H 'Content-Type: application/json' -d "$body")"
  printf '%s' "$out" | py '
import sys, json
d = json.load(sys.stdin).get("data", {})
sys.stdout.write(d.get("stdout", ""))
sys.stderr.write(d.get("stderr", ""))
sys.exit(d.get("exitCode", 1))
'
}

cmd_status() {
  need_server
  api "$BASE/infra/servers/$sid" | py '
import sys, json
d = json.load(sys.stdin)["data"]
for k in ("name", "status", "blackholeStatus", "appUrl", "accessPolicy", "sleepAfterMinutes", "plan"):
    print(f"{k:18} {d.get(k)}")
'
}

cmd_logs() {
  need_server
  api "$BASE/infra/servers/$sid/logs?service=app&lines=${LINES:-100}" \
    | py 'import sys, json; print("\n".join(json.load(sys.stdin)["data"].get("logs", [])))'
}

# Читает изнутри сервера: запрос с 127.0.0.1 без заголовков шлюза — «свой», токен берётся из
# .env приложения и наружу не выходит. Поэтому FEEDBACK_READ_REMOTE включать не нужно.
cmd_read() {
  local path=/feedback.md
  if [ -n "${SKILL:-}" ]; then
    printf '%s' "$SKILL" | grep -Eqx '[A-Za-z0-9._-]{1,100}' || { echo "SKILL — имя навыка: '$SKILL'" >&2; exit 1; }
    path="/feedback?skill=$SKILL"
  elif [ "${READ:-}" = json ]; then path=/feedback; fi
  need_server
  run "set -a; . /opt/app/.env; set +a; U='$path' node -e \"fetch('http://127.0.0.1:3000' + process.env.U, { headers: { authorization: 'Bearer ' + process.env.FEEDBACK_READ_TOKEN } }).then(async (r) => { console.log(await r.text()); process.exit(r.ok ? 0 : 1) }, (e) => { console.error(e.message); process.exit(1) })\""
}

cmd_deploy() {
  : "${ENV_JSON:?задайте ENV_JSON (JSON с FEEDBACK_READ_TOKEN)}"
  # Без токена чтения приёмник закрыт для всех, включая владельца, — выкладывать такое незачем.
  ENV_JSON="$ENV_JSON" py '
import json, os, sys
e = json.loads(os.environ["ENV_JSON"])
if not isinstance(e, dict) or not str(e.get("FEEDBACK_READ_TOKEN", "")).strip():
    sys.exit("в ENV_JSON нет FEEDBACK_READ_TOKEN — не выкладываю")
'
  sid="$(server_id)"
  if [ -z "$sid" ]; then
    [ "${VIBE_CREATE:-}" = 1 ] || { echo "сервер '$APP_NAME' не найден; создать (платно): VIBE_CREATE=1" >&2; exit 1; }
    echo "==> создаю сервер $APP_NAME (${VIBE_PLAN:-bc-micro}, ${VIBE_REGION:-ru-central1-b})"
    sid="$(api -X POST "$BASE/infra/servers" -H 'Content-Type: application/json' \
      -d "{\"provider\":\"bitrix-cloud\",\"name\":\"$APP_NAME\",\"plan\":\"${VIBE_PLAN:-bc-micro}\",\"region\":\"${VIBE_REGION:-ru-central1-b}\"}" \
      | py 'import sys, json; print(json.load(sys.stdin)["data"]["id"])')"
  fi
  echo "==> сервер $sid"

  # Новый сервер поднимается несколько минут. Спящий ждать не нужно: deploy будит его сам.
  local st="" bh=""
  for _ in $(seq 1 90); do
    read -r st bh < <(api "$BASE/infra/servers/$sid" \
      | py 'import sys, json; d = json.load(sys.stdin)["data"]; print(d.get("status"), d.get("blackholeStatus"))' 2>/dev/null || true) || true
    [ "$st" = sleeping ] && break
    [ "$st" = running ] && [ "$bh" = CONNECTED ] && break
    [ "$st" = error ] && { echo "сервер в состоянии error" >&2; exit 1; }
    echo "    status=${st:-?} blackhole=${bh:-?}"; sleep 10
  done
  { [ "$st" = sleeping ] || { [ "$st" = running ] && [ "$bh" = CONNECTED ]; }; } \
    || { echo "не дождался running+CONNECTED (status=${st:-?} blackhole=${bh:-?})" >&2; exit 1; }

  # Архив собирается здесь, из рабочей копии, и уходит в теле запроса: ни публичный URL, ни
  # раскладка архива GitHub (папка верхнего уровня) не нужны.
  TGZ="$(mktemp)"; trap 'rm -f "$TGZ"' EXIT
  tar -czf "$TGZ" server.js
  local body
  body="$(TGZ="$TGZ" DATA_DIR="$DATA_DIR" RUNTIME="${VIBE_RUNTIME:-node20}" ENV_JSON="$ENV_JSON" py '
import base64, json, os
env = json.loads(os.environ["ENV_JSON"])
env["DATA_DIR"] = os.environ["DATA_DIR"]
env.pop("PORT", None)  # PORT задаёт платформа (всегда 3000)
print(json.dumps({
    "source": {"content": base64.b64encode(open(os.environ["TGZ"], "rb").read()).decode()},
    "runtime": os.environ["RUNTIME"],
    "start": "cd /opt/app && exec node server.js",
    "port": 3000,
    "env": {k: str(v) for k, v in env.items()},
    "dataDirs": [os.environ["DATA_DIR"]],
    "healthPath": "/health",
    "displayName": "bxshef: приёмник отзывов",
    "description": "Принимает отзывы ИИ-агентов о навыках.",
}))
')"
  echo "==> выкладываю"
  api -X POST "$BASE/infra/servers/$sid/deploy" -H 'Content-Type: application/json' \
    -H 'X-Skip-Source-Snapshot: CI deploy of feedback/server.js' --data-binary @- <<<"$body" \
    | py 'import sys, json; d = json.load(sys.stdin).get("data", {}); print("==> адрес:", d.get("appUrl", "?"))'
  echo "==> проверить: ./vibecode.sh status (accessPolicy — PUBLIC), ./vibecode.sh read"
}

case "${1:-}" in deploy|read|logs|status) : "${VIBE_KEY:?задайте VIBE_KEY (vibe_api_…)}" ;; esac
case "${1:-}" in
  deploy) cmd_deploy ;;
  read) cmd_read ;;
  logs) cmd_logs ;;
  status) cmd_status ;;
  *) sed -n '6,9p' "$0" | sed 's/^# //'; exit 2 ;;
esac
