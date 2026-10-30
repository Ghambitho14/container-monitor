# Guía de operación

Cómo desplegar, mantener y recuperar el monitor en el servidor. Los ejemplos usan
`/opt/monitoring/container-monitor` como carpeta del servidor y `100.64.0.1` como su IP de
Tailscale: cámbialos por los tuyos.

Volver al [README](../README.es.md).

## Dónde vive cada cosa

El código de referencia es **el repositorio git**. El servidor solo recibe copias con
`npm run deploy` y **no se edita a mano**: el despliegue detecta los cambios hechos directamente
allí y se niega a sobrescribirlos.

## Desarrollo y despliegue

Los scripts que hablan con el servidor leen sus datos del entorno o de `.env.deploy`, en la raíz
del repo. Git ignora ese archivo:

```bash
# .env.deploy
MONITOR_SSH=root@100.64.0.1
MONITOR_URL=http://100.64.0.1:3000
# MONITOR_REMOTE_DIR=/opt/monitoring/container-monitor   (valor de serie)
```

```bash
npm ci                     # una vez
npm test                   # pruebas (node --test, sin dependencias extra)
npm run check              # sintaxis de server/ y coherencia de .env.example y los README con el código
node scripts/dev-proxy.mjs # panel LOCAL (http://127.0.0.1:3100) contra la API REAL del servidor
```

`dev-proxy` sirve `public/` desde el disco y reenvía `/api/*` al servidor: sirve para ver cambios
de interfaz sin desplegar. Ojo: las escrituras llegan al servidor de verdad, y los logs en vivo
(WebSocket) no se reenvían.

**Desplegar** (`npm run deploy`, `scripts/deploy.mjs`):

1. Ejecuta `check` y `test`.
2. Compara la huella MD5 del servidor con `deploy/last-deployed.md5`. Si alguien editó allí a
   mano, aborta. `--force` sobrescribe igualmente.
3. Copia lo que hay en el servidor a `/root/backups/container-monitor-<fecha>/`.
4. Sube un tar con `server/`, `public/`, `scripts/`, `Dockerfile`, `.dockerignore`,
   `docker-compose.yml`, `package*.json`, `README.md`, `.env.example` y `setup-telegram.sh`.
   **Nunca** sube `.env` ni `data/`.
5. Ejecuta `docker compose up -d --build monitor` y espera a que `/api/health` responda con la
   versión nueva (90 s, ajustable con `--wait=N`). Si no vuelve, **restaura la copia** del paso 3.
6. Guarda la huella nueva en `deploy/last-deployed.md5`. Hay que hacer commit de ese archivo.

`npm run deploy -- --dry-run` enseña qué cambiaría sin tocar nada. Cada despliegue deja el
monitor unos 40 s sin vigilar.

> **Al pasar a la v2.4.0:** `docker-compose.yml` lee la IP de Tailscale de `MONITOR_BIND_IP`.
> Antes de desplegar, añade esa línea al `.env` del servidor. Si falta, `docker compose` se
> niega a arrancar y el despliegue vuelve a la versión anterior.

## Configuración en detalle

- **Precedencia:** valor de serie, luego `.env`, luego `data/settings.json`. Lo que se guarda en el
  panel va a `data/settings.json`, con modo 600 y copia anterior en `settings.json.prev`. El `.env`
  no se toca nunca. Borrar `settings.json` y reiniciar devuelve todo a lo que diga el `.env`.
- **Catálogo único:** cada ajuste (variable, valor de serie, límites, texto del panel) se define
  una sola vez en `server/settings.js`. `config.js` construye el objeto de configuración a partir
  de ahí.
- **En caliente o con reinicio:** umbrales, avisos, Snort (umbral y ventana), push y retención se
  aplican al guardar. Los intervalos de sondeo, Telegram, la hora del resumen, las IPs y SIDs
  ignorados de Snort y activar o desactivar módulos piden reinicio. El panel los marca como
  «requiere reinicio» y ofrece «Guardar y reiniciar»: el proceso sale y Docker lo levanta por
  `restart: unless-stopped`.
- Cada cambio queda en *Eventos* como `config_changed`, sin valores secretos. El token de Telegram
  nunca se devuelve al navegador; el botón «Enviar prueba» lo valida.
- Un cambio en el `.env` **no** se aplica con `docker compose restart`, que no relee el archivo.
  Hay que usar `docker compose up -d monitor`.

## Copias de seguridad y restauración

**Datos** (`data/`):

- `monitor.db`: SQLite en modo WAL.
- `vapid.json`: las claves push. Sin él hay que reactivar las alertas en cada móvil.
- `settings.json`: lo guardado desde el panel.

Además, el `.env`.

```bash
# En el servidor (o desde el PC: ssh root@100.64.0.1 'bash -s' < scripts/backup.sh)
bash scripts/backup.sh            # copia en /root/backups/monitor-data-<fecha>/, con integrity_check
KEEP=0 bash scripts/backup.sh     # sin rotación (de serie conserva las 10 últimas)
```

La base se copia con `VACUUM INTO`, que da una copia consistente sin parar el monitor. Copiar
`monitor.db` tal cual con el monitor en marcha puede dar una base corrupta.

**Restaurar datos:**

```bash
cd /opt/monitoring/container-monitor
docker compose stop monitor
cp /root/backups/monitor-data-<fecha>/monitor.db data/monitor.db
rm -f data/monitor.db-wal data/monitor.db-shm
cp /root/backups/monitor-data-<fecha>/vapid.json data/        # si hace falta
cp /root/backups/monitor-data-<fecha>/settings.json data/     # si hace falta
docker compose up -d monitor
```

**Restaurar código** (vuelta a una versión anterior):

```bash
cd /opt/monitoring/container-monitor
rm -rf server public && cp -a /root/backups/container-monitor-<fecha>/. . && docker compose up -d --build monitor
```

Después, en local, `npm run deploy:baseline` para que la huella vuelva a coincidir.

## Operación

```bash
docker compose logs -f monitor              # qué está haciendo
docker compose up -d monitor                # aplicar un cambio del .env (restart NO lo relee)
docker compose up -d --build monitor        # tras cambiar código (lo hace npm run deploy)
tailscale serve status                      # el HTTPS de la tailnet
curl -s http://127.0.0.1:3000/api/health | jq .problems
```

La base vive en `./data/monitor.db` (bind mount, sobrevive a los rebuilds), junto con
`./data/vapid.json` y `./data/settings.json`. Antes de tocar `data/` a mano, para el monitor.

## Glosario de estados y colores

**Contenedores.** El badge traduce el estado de Docker; el nombre original va en el tooltip.

| Badge | Docker | Qué significa |
|---|---|---|
| En marcha | `running` | Arrancado |
| Parado | `exited` | Terminó; el código de salida sale en la banda roja: `Parado (código 137) hace 2 h` |
| Creado | `created` | Creado, pero nunca arrancado |
| En pausa / Muerto / Reiniciando | `paused` / `dead` / `restarting` | Lo que dice |
| Sin salud / Arrancando | healthcheck `unhealthy` / `starting` | Solo en contenedores con healthcheck |

**Qué es un «problema».** Todo contenedor que no esté *En marcha* o cuyo healthcheck falle. Va a
la banda roja de arriba («N cosas necesitan atención») junto con los umbrales del host superados,
los dominios caídos y los fallos del propio monitor. Un contenedor parado a propósito también
cuenta: la banda no distingue intención.

**Eventos.** Cada uno lleva su severidad en texto:

| Severidad | Ejemplos | Canales |
|---|---|---|
| Crítico | caída, healthcheck en rojo, bucle de reinicio, OOM, dominio caído, disco lleno | Telegram + push |
| Aviso | reinicio, contenedor desaparecido, memoria al límite, carga alta, certificado | Telegram + push |
| Info | recuperaciones, contenedor nuevo, ajustes cambiados | Telegram silencioso; push solo si `PUSH_MIN_SEVERITY=info` |

En la lista de eventos:

- «Enviado» quiere decir que algún canal lo entregó.
- «Historial» quiere decir que no se envió, por una de estas razones:
  - el antirrebote (`ALERT_DEDUPE_MINUTES`);
  - no había ningún canal configurado;
  - fallaron los tres intentos de Telegram.

Los mensajes de Telegram y los títulos de push empiezan por una etiqueta del tipo de evento:
`[CAÍDO]`, `[RECUPERADO]`, `[REINICIO]`, `[MEMORIA]`, `[DOMINIO]`, `[OK]`, etc.

**Cabecera.** «Actualizado hace X s» es la última respuesta del monitor. Si el sondeo falla aparece
una línea roja con la hora de los datos que se están viendo y el próximo reintento; desaparece sola.

**Ajustes.**

- «desde .env» y «desde el panel» dicen de dónde sale el valor. Sin etiqueta, es el valor de serie.
- «requiere reinicio» quiere decir que el valor se guarda, pero el proceso solo lo usa después de reiniciar.
- «pendiente de reinicio» quiere decir que ya está guardado y todavía no se ha aplicado.

## El filtro de Snort no es opcional

Unas reglas locales típicas alertan ante **cualquier** SYN al puerto 22 y ante cualquier ping. Sin
la allowlist de `100.64.0.0/10`, cada conexión SSH legítima por Tailscale dispara una alerta, y el
canal de Telegram queda inservible en un día.

El filtro se aplica al leer el log, no en Snort: el registro completo sigue en disco.

## Preguntas frecuentes

### ¿Qué detecta solo y qué hay que configurar?

**Lo detecta solo, sin configurar nada:**

- **Contenedores:** todos los que haya en Docker. Una app nueva de Coolify entra sola en la vigilancia.
- **Dominios:** salen de las labels de Traefik que Coolify pone a cada app.
- **El servidor:** disco, RAM, swap, CPU y carga.
- **Snort:** las alertas del archivo de log.

**Se ajusta en la pestaña Ajustes:**

- Los umbrales de cada aviso.
- Cuánto esperar antes de repetir un aviso.
- Telegram.
- Qué avisos llegan al móvil.
- Los dominios extra.
- Las redes que Snort ignora.
- La hora del resumen diario.

**Fijo en el código:**

- Qué tipos de aviso existen.
- Cómo se ven los mensajes.
- El panel.

Para añadir un tipo de aviso nuevo hay que tocar `server/*.js`.

### ¿Qué es VAPID y qué es el «Contacto VAPID»?

El monitor no le manda el aviso directamente al teléfono. Se lo entrega al servicio de push de
Google, Apple o Mozilla, y ese servicio lo reenvía al móvil aunque la app esté cerrada y el móvil
esté fuera de Tailscale.

Para que esos servicios acepten los avisos, el servidor se identifica con un par de claves, las
**claves VAPID**. Viven en `data/vapid.json`. Si se borran, se generan unas nuevas y hay que volver
a pulsar «Alertas» en cada dispositivo.

El **Contacto VAPID** (`PUSH_VAPID_SUBJECT`) es solo un dato de contacto que viaja con cada envío,
por si el servicio de push tiene que avisar a quien maneja el servidor (por ejemplo, si envía
demasiados avisos). No se usa para nada más.

- El valor de serie es de relleno. Lo correcto es poner `mailto:` con un correo propio.
- Cambiarlo pide reiniciar el monitor, pero **no** rompe las alertas ya activadas en los móviles:
  esas dependen de las claves, no del contacto.

### ¿De dónde salen los dominios? ¿Para qué es «Dominios extra»?

Los dominios **se descubren solos**: el monitor lee las reglas `Host(...)` que Traefik (y Coolify)
ponen en cada contenedor. Si publicas un dominio nuevo, entra en la vigilancia sin hacer nada. Los
hostnames `*.sslip.io`, que Coolify usa internamente, se ignoran.

Cada 15 min (`DOMAIN_INTERVAL_MS`) se revisa por HTTPS cada dominio y los días que le quedan al
certificado. La lista completa, con latencias, está en la pestaña **Dominios**.

**«Dominios extra»** (`DOMAIN_EXTRA`) sirve para dos cosas:

1. Añadir dominios que no salen solos.
2. Cambiar la **ruta** que se revisa cuando la portada `/` no refleja si el servicio está sano.

Ejemplo: en Supabase autoalojado, la raíz de `api.example.com` (Kong) responde 404 aunque todo
funcione. Con `api.example.com/auth/v1/.well-known/jwks.json` se revisa una ruta que solo
responde 200 si funcionan Traefik, Kong y Auth. `/auth/v1/health` no sirve, porque las versiones
recientes de Kong la protegen y responden 401.

El formato es `host` o `host/ruta`, sin `https://`:

- en el panel, uno por línea;
- en el `.env`, separados por comas.

Lo que se pone a mano **manda** sobre lo detectado: si el host ya existía, se usa la ruta escrita aquí.

### ¿Dónde se guarda lo que cambio en Ajustes?

En `data/settings.json`, dentro del servidor. Se aplica por encima del `.env`, y el `.env`
**no se modifica nunca**.

- **Volver todo al `.env`:** borrar ese archivo y reiniciar el monitor.
- **Ver la versión anterior:** está en `data/settings.json.prev`.
- **Volver a una versión anterior del código:** hay una copia por despliegue en
  `/root/backups/container-monitor-<fecha>/`.
