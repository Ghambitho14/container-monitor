# Historial de cambios

Fechas en UTC.

## 2.4.0 — 2026-10-14

- **`GET /api/containers/:id/logs?since=&tail=`:** logs ya escritos en texto, sin WebSocket. La Oficina
  los usa para contar errores de cada app cuando no corre en el mismo servidor.
- **Avisos sin emojis:** Telegram y push empiezan por una etiqueta de texto del tipo de evento
  (`[CAÍDO]`, `[RECUPERADO]`, `[MEMORIA]`…). `notify.iconFor` / `ICONS` pasan a `labelFor` / `LABELS`.
- **Panel:** los iconos del carril y el chevron de los grupos son SVG en línea en vez de caracteres.
- **Sin datos del servidor en el repo:**
  - `docker-compose.yml` lee la IP de Tailscale de `MONITOR_BIND_IP`, que pasa a ser obligatoria en `.env`;
  - `deploy.mjs` y `dev-proxy.mjs` exigen `MONITOR_SSH` / `MONITOR_URL`, del entorno o de `.env.deploy`;
  - los tests usan IPs y dominios de ejemplo.
- **Documentación:**
  - README en inglés y en español;
  - la guía de operación pasa a `docs/operacion.md`;
  - `npm run check` revisa las rutas de la API en los dos README.
- Comentarios del código revisados: fuera los que solo contaban la historia del proyecto.

## 2.3.1 — 2026-10-13

- README reescrito:
  - `tailscale serve` escucha en **8443**;
  - `docker compose restart` no relee el `.env`;
  - el 503 de `/api/health` no reinicia el contenedor: eso lo hace el watchdog;
  - secciones nuevas: modelo de confianza, glosario de estados y colores, desarrollo y despliegue, copias de seguridad y restauración;
  - parámetros `hours` de la API.
- Este CHANGELOG. `.env.example` completo (`DOCKER_EVENTS_DEBOUNCE_MS`, variables de desarrollo).
- `npm run check` comprueba además que `.env.example` documente todas las variables del catálogo
  y que el README mencione todas las rutas de la API.
- Cabeceras de módulo en `db.js`, `index.js` y `notify.js`.
- Panel: la ayuda de formato ya no repite «formato: formato».

## 2.3.0 — 2026-10-13 (interfaz más clara, sin rediseño)

- **Cabecera honesta:**
  - «Actualizado hace X s» en todas las pestañas;
  - si el sondeo falla, una línea de conexión propia muestra la hora de los datos y el próximo reintento, y desaparece sola al recuperarse;
  - con 0 contenedores distingue «Docker no responde» de «cargando».
- **Umbrales e intervalos desde la API** (`/api/overview`, campo `monitor.config`): CPU caliente,
  barra de memoria, aviso de certificado, «cada N min», «sondeo cada N s». El panel usa los mismos
  valores que el servidor.
- **Vocabulario en español:**
  - estados de Docker traducidos, con el término original en el tooltip (En marcha, Parado, Sin salud, Reiniciando…);
  - estado traducido en la banda roja: «Parado (código 137) hace 2 h»;
  - política de reinicio explicada;
  - «regla» en vez de `sid` y «Prioridad (1 es la más grave)».
- **Eventos:**
  - severidad en texto (Crítico / Aviso / Info) y «Enviado» / «Historial»;
  - una lista vacía se distingue de un error;
  - autorrefresco mientras la pestaña está a la vista;
  - Dominios y Seguridad comprueban la respuesta HTTP;
  - la tabla de alertas de Snort respeta el rango elegido.
- **Ajustes:**
  - confirmación antes de reiniciar o descartar;
  - el reinicio se da por bueno por el uptime del proceso nuevo;
  - «no se pudo guardar» se distingue de «no se pudo reiniciar»;
  - etiqueta «requiere reinicio» visible y origen del valor solo cuando no es el de serie;
  - ayuda de formato (`itemHelp` / `patternHelp` en `/api/settings`).
- **Accesibilidad:**
  - `aria-label` en buscadores, `aria-pressed` en chips y `aria-expanded` en grupos;
  - iconos ocultos al lector de pantalla y logs sin `aria-live`;
  - toast como `role=status` y contraste suficiente en «Historial».
- `scripts/dev-proxy.mjs`: panel local contra la API real para probar la interfaz sin desplegar.

## 2.2.1 — 2026-10-13 (robustez del backend)

- El upgrade del WebSocket de logs responde 400 ante una URL o un `Host` malformados, en vez de
  tumbar el proceso.
- Handlers de `uncaughtException` / `unhandledRejection` que salen con código 1 para que Docker relance.
- **Watchdog interno:** si el watcher lleva más de 5 min sin pasada, el proceso sale. Docker no
  reinicia contenedores *unhealthy*, solo los marca.
- Arreglada una fuga del stream de logs cuando el cliente cerraba durante los `await`.
- Escrituras (`settings`, `restart`, `push/*`) exigen cabecera `Origin` presente e igual al host:
  un `curl` sin cabecera recibe 403. No es autenticación.
- `/api/events` filtra severidad y `notified` en SQL antes del `LIMIT` (`db.queryEvents`).
- `notified` se corrige a 0 si ningún canal entregó el aviso (`db.markNotified`).
- `stats`: guardia contra pasadas solapadas. `snort`: `following` solo tras abrir el archivo.
- `Dockerfile`: `NODE_ENV=production`. Versión única leída de `package.json`, que también va en el
  User-Agent de las sondas.
- Tests de `db.queryEvents` / `markNotified` y prueba de humo del servidor entero (28 en total).

## 2.2.0 — 2026-10-11

- Pestaña **Ajustes**:
  - catálogo único en `server/settings.js`;
  - precedencia: valor de serie, `.env`, `data/settings.json`;
  - ajustes en caliente o con «Guardar y reiniciar».
- Red de seguridad, sin cambios de comportamiento:
  - repositorio git;
  - `.gitignore` / `.dockerignore` / `.gitattributes`, para que el build de Docker no envíe `data/` como contexto;
  - 22 pruebas de funciones puras;
  - `scripts/deploy.mjs` (huella MD5, copia previa, subida, rebuild, espera de salud y vuelta atrás automática);
  - `scripts/backup.sh` (copia consistente de la base con `VACUUM INTO`).

## 2.1.0 y anteriores

Sin registro.
