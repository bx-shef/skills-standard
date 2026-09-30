# Приёмник отзывов bxshef. Один Makefile на два места: каталог feedback/ в репозитории и
# /home/bitrix/skills-feedback/ на сервере, где лежат только docker-compose.prod.yml, этот
# Makefile и .env (README.md, раздел «Сервер»). Схема — как у остальных приложений bx-shef
# (эталон client-bank-alfa-by): общий nginx-proxy + acme-companion и Watchtower на хосте.
#
# Внешние REF и CONFIRM берутся только из командной строки make и как текст ($(value …)):
# их вставляют из чужих сообщений, и `$(shell …)` в значении не должен выполниться.

.DEFAULT_GOAL := help
.PHONY: help build-local prod-up prod-down prod-pull prod-redeploy logs ps health read doctor \
        backup compose-update self-update vibe-deploy vibe-read vibe-logs vibe-status

override cli = $(if $(filter command line,$(origin $(1))),$(value $(1)),$(2))
unexport REF CONFIRM SKILL JSON

# Прод-переменные — только из .env: чужой экспортированный DOMAIN на общем хосте не должен
# подменить домен приёмника.
# COMPOSE_PROJECT_NAME / COMPOSE_FILE из окружения хоста тоже снимаем: иначе compose взял бы чужое
# имя проекта — и другой том с отзывами.
override COMPOSE_ENV = env -u DOMAIN -u LETSENCRYPT_EMAIL -u FEEDBACK_TOKEN -u FEEDBACK_READ_TOKEN \
	-u FEEDBACK_READ_REMOTE -u FEEDBACK_RATE -u FEEDBACK_RATE_TOTAL -u FEEDBACK_AUTH_FAILS \
	-u FEEDBACK_RETENTION_DAYS -u FEEDBACK_MAX_FILES -u FEEDBACK_MAX_MB -u TRUST_PROXY \
	-u COMPOSE_PROJECT_NAME -u COMPOSE_FILE docker compose
override COMPOSE = $(COMPOSE_ENV) -f docker-compose.prod.yml
override CONTAINER := skills-feedback
override RAW := https://raw.githubusercontent.com/bx-shef/skills-standard
override IMAGE_SOURCE := https://github.com/bx-shef/skills-standard

override CHECK_REF = printf '%s' "$$U_REF" | grep -Eqx '[A-Za-z0-9][A-Za-z0-9._/-]{0,199}' \
	&& ! printf '%s' "$$U_REF" | grep -qF '..' \
	|| { echo "[make] REF — имя ветки или тега (буквы, цифры, . _ / -): '$$U_REF'"; exit 1; }

# ─── Локально (в каталоге feedback/ репозитория) ─────────────────────

## Собрать из исходников и запустить на 127.0.0.1:8787 на переднем плане (токен чтения — dev)
build-local:
	docker compose up --build

# ─── Прод (на сервере) ───────────────────────────────────────────────

## Запустить / обновить контейнер
prod-up:
	$(COMPOSE) up -d

## Остановить (том с отзывами остаётся)
prod-down:
	$(COMPOSE) down

## Скачать свежий образ, не перезапуская контейнер
prod-pull:
	$(COMPOSE) pull

## Обновить прямо сейчас, не дожидаясь Watchtower (чистит только свои старые образы)
prod-redeploy:
	$(COMPOSE) pull && $(COMPOSE) up -d && \
	docker image prune -f --filter "label=org.opencontainers.image.source=$(IMAGE_SOURCE)"

## Живой лог (Ctrl+C — выйти)
logs:
	$(COMPOSE) logs -f feedback

## Состояние контейнера и healthcheck
ps:
	$(COMPOSE) ps

## GET /health изнутри контейнера
health:
	$(COMPOSE) exec -T feedback node -e "fetch('http://127.0.0.1:8787/health').then(r => r.text()).then(console.log)"

## Сводка отзывов (make read JSON=1 — все отзывы JSON, SKILL=<имя> — по одному навыку)
#
# Изнутри контейнера: чтение открыто только с 127.0.0.1, токен берётся из окружения контейнера и
# в командную строку хоста не попадает. SKILL — только из командной строки и проверяется по формату.
read: export R_SKILL = $(call cli,SKILL,)
read: export R_JSON = $(call cli,JSON,)
read:
	@[ -z "$$R_SKILL" ] || printf '%s' "$$R_SKILL" | grep -Eqx '[A-Za-z0-9._-]{1,100}' \
	  || { echo "[make] SKILL — имя навыка: '$$R_SKILL'"; exit 1; }; \
	if [ -n "$$R_SKILL" ]; then u="/feedback?skill=$$R_SKILL"; elif [ "$$R_JSON" = 1 ]; then u=/feedback; else u=/feedback.md; fi; \
	$(COMPOSE) exec -T -e U="$$u" feedback node -e "fetch('http://127.0.0.1:8787' + process.env.U, { headers: { authorization: 'Bearer ' + process.env.FEEDBACK_READ_TOKEN } }).then(async (r) => { console.log(await r.text()); process.exit(r.ok ? 0 : 1) }, (e) => { console.error(e.message); process.exit(1) })"

## Проверить выкат: контейнер, прокси, сертификат, https снаружи, чтение закрыто, Watchtower, диск
#
# Только читает. ✓ — в порядке, ✗ — ошибка (после «→» — что делать; make завершится с ошибкой),
# ⚠ — проверить нечем или необязательное не задано.
doctor:
	@bad=0; warn=0; \
	ok()   { echo "  ✓ $$1"; }; \
	fail() { echo "  ✗ $$1"; bad=$$((bad+1)); }; \
	note() { echo "  ⚠ $$1"; warn=$$((warn+1)); }; \
	img()  { docker ps -q 2>/dev/null | xargs -r docker inspect -f '{{.Config.Image}}' 2>/dev/null | grep -Eq "(^|/)$$1(:|@|$$)"; }; \
	st=$$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' $(CONTAINER) 2>/dev/null); \
	case "$$st" in \
	  "running healthy") ok "контейнер $(CONTAINER): running, healthy" ;; \
	  "running starting") note "контейнер $(CONTAINER): запускается — повторить через минуту" ;; \
	  running*) fail "контейнер $(CONTAINER): $$st → make logs" ;; \
	  *) fail "контейнер $(CONTAINER) не запущен → make prod-up" ;; \
	esac; \
	d=$$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $(CONTAINER) 2>/dev/null | sed -n 's/^VIRTUAL_HOST=//p'); \
	docker network inspect proxy-net >/dev/null 2>&1 && ok "сеть proxy-net есть" \
	  || fail "нет сети proxy-net → поставить общий прокси (README.md, «Один раз на хост»)"; \
	img nginx-proxy && ok "nginx-proxy запущен" || fail "nginx-proxy не запущен → README.md, «Один раз на хост»"; \
	img acme-companion && ok "acme-companion запущен" || fail "acme-companion не запущен → README.md, «Один раз на хост»"; \
	img watchtower && ok "Watchtower запущен" || note "Watchtower не запущен — обновлять руками: make prod-redeploy"; \
	if [ -z "$$d" ]; then fail "у контейнера нет VIRTUAL_HOST → DOMAIN в .env, make prod-up"; \
	elif ! command -v curl >/dev/null; then note "нет curl — https снаружи не проверить"; \
	else \
	  code=$$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$$d/health"); \
	  [ "$$code" = 200 ] && ok "https://$$d/health → 200, сертификат доверенный" \
	    || fail "https://$$d/health → $${code:-нет ответа} → DNS A-запись на сервер? логи acme-companion"; \
	  code=$$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$$d/feedback.md"); \
	  case "$$code" in \
	    403) ok "чтение снаружи закрыто (403) — читать: make read" ;; \
	    401) ok "чтение снаружи — только с токеном (FEEDBACK_READ_REMOTE=1)" ;; \
	    *) fail "GET /feedback.md без токена → $${code:-нет ответа}, ожидалось 403 → ответил не приёмник? make logs, логи nginx-proxy" ;; \
	  esac; \
	  if ! command -v openssl >/dev/null; then note "нет openssl — срок сертификата не проверить"; \
	  else \
	    crt=$$(echo | timeout 10 openssl s_client -connect "$$d:443" -servername "$$d" 2>/dev/null | openssl x509 2>/dev/null); \
	    end=$$(printf '%s\n' "$$crt" | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2); \
	    if [ -z "$$end" ]; then fail "сертификат не прочитать → логи acme-companion"; \
	    elif printf '%s\n' "$$crt" | openssl x509 -noout -checkend 1209600 >/dev/null 2>&1; \
	    then ok "сертификат действует до $$end"; \
	    else fail "сертификат истекает в ближайшие 14 дней ($$end) → логи acme-companion"; fi; \
	  fi; \
	fi; \
	root=$$(docker info -f '{{.DockerRootDir}}' 2>/dev/null); [ -d "$$root" ] || root=/; \
	use=$$(df -P "$$root" 2>/dev/null | awk 'NR==2 {sub(/%/, "", $$5); print $$5}'); \
	if [ -z "$$use" ]; then note "занятость диска не прочитать"; \
	elif [ "$$use" -lt 90 ]; then ok "диск docker ($$root) занят на $$use%"; \
	else fail "диск docker ($$root) занят на $$use% → docker system df"; fi; \
	if [ "$$bad" -gt 0 ]; then echo "[make] проблем: $$bad"; exit 1; \
	elif [ "$$warn" -gt 0 ]; then echo "[make] ошибок нет, предупреждений: $$warn"; \
	else echo "[make] всё в порядке"; fi

## Копия отзывов в ./backups
backup:
	@umask 077; mkdir -p backups && f="backups/feedback-$$(date +%Y%m%d-%H%M%S).tgz" \
	  && { $(COMPOSE) exec -T feedback tar czf - -C /data . > "$$f" || { rm -f "$$f"; exit 1; }; } \
	  && echo "[make] копия: $$f ($$(du -h "$$f" | cut -f1))"

## Обновить docker-compose.prod.yml из репозитория: показать разницу, заменить — подтвердив sha256
#
#   make compose-update                       # скачать из main, показать разницу и sha256
#   make compose-update CONFIRM=<sha256>      # заменить, если скачанное совпало с показанным
#   make compose-update REF=<ветка> …         # из ветки или тега
compose-update: export U_REF = $(call cli,REF,main)
compose-update: export U_CONFIRM = $(call cli,CONFIRM,)
compose-update:
	@$(CHECK_REF); \
	[ -z "$$U_CONFIRM" ] || printf '%s' "$$U_CONFIRM" | grep -Eqx '[0-9a-f]{64}' \
	  || { echo "[make] CONFIRM — sha256 из предыдущего вывода (64 шестнадцатеричных символа)"; exit 1; }; \
	t=$$(mktemp ./.compose.XXXXXX) || exit 1; \
	trap 'rm -f "$$t"' EXIT; trap 'rm -f "$$t"; exit 130' INT TERM; \
	{ curl -fsSL -o "$$t" "$(RAW)/$$U_REF/feedback/docker-compose.prod.yml" \
	  && $(COMPOSE_ENV) -f "$$t" config -q; } \
	  || { echo "[make] docker-compose.prod.yml из $$U_REF не скачался или не прошёл docker compose config — рабочий не тронут"; exit 1; }; \
	sum=$$(sha256sum "$$t" | cut -d' ' -f1); \
	if cmp -s "$$t" docker-compose.prod.yml; then echo "[make] уже совпадает с $$U_REF"; exit 0; fi; \
	if [ -z "$$U_CONFIRM" ]; then \
	  diff -u docker-compose.prod.yml "$$t"; \
	  echo "[make] заменить: make compose-update REF=$$U_REF CONFIRM=$$sum"; exit 0; \
	fi; \
	[ "$$U_CONFIRM" = "$$sum" ] || { echo "[make] файл в $$U_REF изменился после показа — посмотрите разницу заново: make compose-update REF=$$U_REF"; exit 1; }; \
	b="./docker-compose.prod.yml.bak-$$(date +%Y%m%d-%H%M%S)"; \
	cp -p docker-compose.prod.yml "$$b" && chmod --reference=docker-compose.prod.yml "$$t" \
	  && mv "$$t" docker-compose.prod.yml \
	  && echo "[make] обновлён из $$U_REF, копия прежнего: $$b. Теперь make prod-up"

## Обновить сам этот Makefile из репозитория (новые цели попадают на сервер только так)
self-update: export U_REF = $(call cli,REF,main)
self-update:
	@$(CHECK_REF); \
	t=$$(mktemp ./.Makefile.XXXXXX) || exit 1; \
	trap 'rm -f "$$t"' EXIT; trap 'rm -f "$$t"; exit 130' INT TERM; \
	{ curl -fsSL -o "$$t" "$(RAW)/$$U_REF/feedback/Makefile" && grep -q '^\.PHONY:' "$$t" \
	  && make -n -f "$$t" prod-redeploy >/dev/null 2>&1; } \
	  || { echo "[make] Makefile из $$U_REF не скачался или не прошёл проверку — рабочий не тронут"; exit 1; }; \
	b="./Makefile.bak-$$(date +%Y%m%d-%H%M%S)"; \
	cp -p Makefile "$$b" && chmod --reference=Makefile "$$t" && mv "$$t" Makefile \
	  && echo "[make] Makefile обновлён из $$U_REF, копия прежнего: $$b" && make --no-print-directory help

# ─── Вайбкод Black Hole (из каталога feedback/ репозитория; VIBECODE.md) ────
# VIBE_KEY — из окружения оператора; ENV_JSON для vibe-deploy — тоже.

## Выложить server.js на Вайбкод (VIBE_CREATE=1 — создать сервер, платно)
vibe-deploy:
	./vibecode.sh deploy

## Сводка отзывов с Вайбкода (JSON=1, SKILL=<имя> — как у make read)
vibe-read: export V_SKILL = $(call cli,SKILL,)
vibe-read: export V_JSON = $(call cli,JSON,)
vibe-read:
	@r=; [ "$$V_JSON" = 1 ] && r=json; SKILL="$$V_SKILL" READ="$$r" ./vibecode.sh read

## Журнал приложения на Вайбкоде
vibe-logs:
	./vibecode.sh logs

## Состояние сервера на Вайбкоде: статус, адрес, доступ, авто-сон
vibe-status:
	./vibecode.sh status

## Список целей
help:
	@awk '/^## /{d=substr($$0,4)} \
	      /^[A-Za-z0-9_][A-Za-z0-9_.-]*:/{if(d!=""){printf "  %-15s %s\n", substr($$1,1,length($$1)-1), d; d=""}}' \
	      $(MAKEFILE_LIST)
