#!/usr/bin/env bash
# Copia de seguridad de los DATOS del monitor (no del código), sin pararlo.
#
#   bash scripts/backup.sh                       → /root/backups/monitor-data-<fecha>/
#   bash scripts/backup.sh /ruta/monitor /ruta/destino
#
# Guarda: monitor.db (copia consistente con VACUUM INTO: la base está en modo WAL
# y copiar el archivo a pelo puede dar una base corrupta), vapid.json (sin él hay
# que reactivar las alertas en cada móvil), settings.json(.prev) y .env.
# KEEP=N conserva las N copias más recientes (10 por defecto; 0 = no borrar nada).
set -euo pipefail

SRC=${1:-/opt/monitoring/container-monitor}
DEST_ROOT=${2:-/root/backups}
KEEP=${KEEP:-10}
STAMP=$(date -u +%Y%m%d-%H%M%S)
DEST="$DEST_ROOT/monitor-data-$STAMP"

[ -f "$SRC/data/monitor.db" ] || { echo "no existe $SRC/data/monitor.db" >&2; exit 1; }
mkdir -p "$DEST"
chmod 700 "$DEST"

# Copia consistente de la base. Preferimos sqlite3 del host; si no está, usamos el
# node:sqlite del propio contenedor (escribe en data/ y luego se mueve fuera).
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$SRC/data/monitor.db" "VACUUM INTO '$DEST/monitor.db'"
  CHECK=$(sqlite3 "$DEST/monitor.db" 'PRAGMA integrity_check')
else
  TMP="backup-$STAMP.db"
  CHECK=$(docker exec container-monitor node -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('/app/data/monitor.db', { readOnly: true });
    db.exec(\"VACUUM INTO '/app/data/$TMP'\");
    const copy = new DatabaseSync('/app/data/$TMP', { readOnly: true });
    process.stdout.write(copy.prepare('PRAGMA integrity_check').get().integrity_check);
  ")
  mv "$SRC/data/$TMP" "$DEST/monitor.db"
fi
[ "$CHECK" = "ok" ] || { echo "integrity_check devolvió: $CHECK" >&2; exit 1; }

for f in vapid.json settings.json settings.json.prev; do
  [ -f "$SRC/data/$f" ] && cp -p "$SRC/data/$f" "$DEST/"
done
[ -f "$SRC/.env" ] && cp -p "$SRC/.env" "$DEST/env"
chmod 600 "$DEST"/*

echo "copia en $DEST ($(du -sh "$DEST" | cut -f1)), integrity_check ok"

if [ "$KEEP" -gt 0 ]; then
  ls -1dt "$DEST_ROOT"/monitor-data-* 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    echo "borrando copia antigua $old"
    rm -rf "$old"
  done
fi
