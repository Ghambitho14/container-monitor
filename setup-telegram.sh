#!/usr/bin/env bash
# Configura las credenciales de Telegram para container-monitor.
# El token se lee por stdin oculto: no queda en el historial del shell.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/monitoring/container-monitor}"
ENV_FILE="$APP_DIR/.env"
API=https://api.telegram.org
mask() { sed -E 's#bot[0-9]+:[A-Za-z0-9_-]+#bot***#g'; }

[[ -f "$ENV_FILE" ]] || { echo "ERROR: no existe $ENV_FILE"; exit 1; }

read -rsp "TELEGRAM_BOT_TOKEN (no se mostrara al escribir): " TOKEN; echo
TOKEN="$(tr -d '[:space:]' <<<"$TOKEN")"
[[ -n "$TOKEN" ]] || { echo "ERROR: token vacio."; exit 1; }

echo "==> Validando el token contra getMe..."
ME="$(curl -sS --max-time 15 "$API/bot$TOKEN/getMe")"
grep -q '"ok":true' <<<"$ME" || { echo "ERROR: Telegram rechazo el token:"; mask <<<"$ME"; exit 1; }
BOT="$(sed -nE 's/.*"username":"([^"]+)".*/\1/p' <<<"$ME")"
echo "    OK -> @$BOT"

CHAT_ID="${1:-}"
if [[ -z "$CHAT_ID" ]]; then
  echo "==> Buscando chat_id en getUpdates..."
  UPD="$(curl -sS --max-time 15 "$API/bot$TOKEN/getUpdates")"
  mapfile -t FOUND < <(grep -oE '"chat":\{"id":-?[0-9]+' <<<"$UPD" | grep -oE -- '-?[0-9]+$' | sort -u)
  if (( ${#FOUND[@]} == 1 )); then
    CHAT_ID="${FOUND[0]}"; echo "    encontrado: $CHAT_ID"
  elif (( ${#FOUND[@]} > 1 )); then
    echo "    hay varios chats: ${FOUND[*]}"
    read -rp "    cual uso? " CHAT_ID
  else
    echo "    Sin mensajes recientes. Abre Telegram, envia /start a @$BOT"
    echo "    y vuelve a ejecutar. O pasa el id a mano:  $0 <chat_id>"
    exit 1
  fi
fi

echo "==> Enviando mensaje de prueba a $CHAT_ID..."
RES="$(curl -sS --max-time 15 -X POST "$API/bot$TOKEN/sendMessage" \
  -H 'content-type: application/json' \
  -d "{\"chat_id\":\"$CHAT_ID\",\"text\":\"<b>container-monitor</b> conectado\",\"parse_mode\":\"HTML\"}")"
grep -q '"ok":true' <<<"$RES" || { echo "ERROR: no se pudo enviar:"; mask <<<"$RES"; echo "Nada escrito en .env."; exit 1; }
echo "    OK: revisa el chat, deberia haber llegado."

echo "==> Escribiendo .env (backup incluido)..."
cp -a "$ENV_FILE" "$ENV_FILE.bak-$(date +%Y%m%d-%H%M%S)"
TMP="$(mktemp)"
TOKEN="$TOKEN" CHAT_ID="$CHAT_ID" awk '
  /^TELEGRAM_BOT_TOKEN=/ { print "TELEGRAM_BOT_TOKEN=" ENVIRON["TOKEN"]; found_t=1; next }
  /^TELEGRAM_CHAT_ID=/   { print "TELEGRAM_CHAT_ID=" ENVIRON["CHAT_ID"]; found_c=1; next }
  { print }
  END {
    if (!found_t) print "TELEGRAM_BOT_TOKEN=" ENVIRON["TOKEN"]
    if (!found_c) print "TELEGRAM_CHAT_ID=" ENVIRON["CHAT_ID"]
  }
' "$ENV_FILE" >"$TMP"
cat "$TMP" >"$ENV_FILE"; rm -f "$TMP"
chmod 600 "$ENV_FILE"
echo "    listo; .env queda con permisos 600."

echo "==> Recreando el contenedor para que relea env_file..."
cd "$APP_DIR"
docker compose up -d --force-recreate monitor

echo "==> Verificando..."
for i in $(seq 1 20); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' container-monitor 2>/dev/null)" == healthy ]] && break
  sleep 2
done
docker inspect -f 'estado: {{.State.Health.Status}}  reinicios: {{.RestartCount}}' container-monitor
if docker logs --since 3m container-monitor 2>&1 | grep -q 'sin TELEGRAM_BOT_TOKEN'; then
  echo "AVISO: el contenedor sigue diciendo que faltan credenciales."
  exit 1
fi
echo
echo "OK: notify.js arranco con credenciales. Log reciente:"
docker logs --tail 12 container-monitor 2>&1 | mask
