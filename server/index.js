require('dotenv').config({ quiet: true });

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const config = require('./config');
const settings = require('./settings');
const db = require('./db');
const watcher = require('./watcher');
const stats = require('./stats');
const snort = require('./snort');
const domains = require('./domains');
const events = require('./events');
const digest = require('./digest');
const notify = require('./notify');
const push = require('./push');
const {
  listContainers,
  streamLogs,
  readLogs,
  demuxDockerLogs,
  inspectSummary,
  isValidContainerId,
  getInfo,
  docker,
} = require('./docker');

/**
 * Punto de entrada del monitor.
 *
 * Aqui conviven: la API REST (Express), los estaticos de la PWA, el WebSocket
 * de logs con limites por IP, el agregado de salud (`/api/health`), el watchdog
 * que sale del proceso si el bucle principal se cuelga, y el arranque y parada
 * ordenados de los modulos. Escucha el puerto al cargarse: no se puede importar
 * desde un test (la prueba de humo lo arranca como proceso aparte).
 */

// Una sola fuente de version: package.json (llega a la imagen con el Dockerfile).
const VERSION = require('../package.json').version;
const app = express();

// Sin CORS: la SPA se sirve del mismo origen y la app no se publica en internet.
app.use(express.json({ limit: '64kb' }));
app.disable('x-powered-by');

// ---------------------------------------------------------------- Salud

/**
 * El healthcheck de Docker pregunta aqui. Si el bucle principal lleva mas de
 * tres intervalos sin pasar, algo esta colgado y se responde 503: Docker marca
 * el contenedor como unhealthy (no lo reinicia; de eso se encarga el watchdog
 * de mas abajo).
 */
function monitorHealth() {
  const now = Date.now();
  const w = watcher.getHealth();
  const staleAfter = config.watch.intervalMs * 3;
  const reference = w.lastTickAt ?? w.startedAt;
  const watcherStale = now - reference > staleAfter;

  const ev = events.getState();
  const sn = snort.getHealth();
  const problems = [];
  if (watcherStale) problems.push('watcher parado');
  if (w.dockerDown) problems.push('docker no responde');
  if (ev.enabled && !ev.connected && now - w.startedAt > 30000) problems.push('stream de eventos desconectado');
  if (sn.enabled && !sn.following && now - w.startedAt > 30000) problems.push('snort: log no legible');

  return {
    ok: !watcherStale,
    problems,
    version: VERSION,
    uptimeSec: Math.floor((now - w.startedAt) / 1000),
    components: {
      watcher: w,
      stats: stats.getHealth(),
      events: ev,
      domains: domains.getHealth(),
      snort: sn,
      telegram: notify.getHealth(),
      push: push.getHealth(),
      digest: digest.getHealth(),
      db: db.dbStats(),
    },
  };
}

app.get('/api/health', (_req, res) => {
  const h = monitorHealth();
  res.status(h.ok ? 200 : 503).json({ ...h, service: 'container-monitor' });
});

// ---------------------------------------------------------------- API

function withStats(containers) {
  return containers.map((c) => ({ ...c, stats: stats.getLatest(c.id) }));
}

const clampHours = (value, fallback = 6) =>
  Math.min(Math.max(Number(value) || fallback, 1), 24 * config.stats.retentionDays);

/** Todo lo que necesita la portada en una sola llamada. */
app.get('/api/overview', async (_req, res) => {
  try {
    const snapshot = watcher.getSnapshot();
    const containers = snapshot.length ? snapshot : await listContainers();
    const health = monitorHealth();
    let info = null;
    try {
      info = await getInfo();
    } catch {
      /* el nombre del host es decorativo */
    }
    res.json({
      containers: withStats(containers),
      host: watcher.getHost(),
      hostAlerts: watcher.getHostAlerts(),
      domains: domains.getLatest(),
      domainState: domains.getState(),
      monitor: {
        ok: health.ok,
        problems: health.problems,
        version: VERSION,
        uptimeSec: health.uptimeSec,
        eventsConnected: health.components.events.connected,
        snortFollowing: health.components.snort.following,
        telegram: notify.enabled,
        push: push.enabled,
        pushSubscribers: health.components.push.subscribers,
        dockerDown: health.components.watcher.dockerDown,
        // El panel pinta con los mismos umbrales e intervalos que usa el servidor.
        config: {
          thresholds: config.thresholds,
          containerMemPct: config.containers.memPct,
          certWarnDays: config.domains.certWarnDays,
          domainIntervalMs: config.domains.intervalMs,
          watchIntervalMs: config.watch.intervalMs,
        },
        info,
      },
    });
  } catch (err) {
    console.error('overview failed', err);
    res.status(500).json({ error: err.message || 'overview failed' });
  }
});

app.get('/api/containers', async (_req, res) => {
  try {
    // El watcher ya mantiene un snapshot fresco con reinicios y salud real.
    const snapshot = watcher.getSnapshot();
    const containers = snapshot.length ? snapshot : await listContainers();
    res.json({ containers: withStats(containers), host: watcher.getHost() });
  } catch (err) {
    console.error('listContainers failed', err);
    res.status(500).json({ error: err.message || 'Failed to list containers' });
  }
});

app.get('/api/containers/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidContainerId(id)) return res.status(400).json({ error: 'invalid container id' });

  try {
    const summary = watcher.getSnapshot().find((c) => c.id === id) || null;
    const detail = await inspectSummary(id);
    res.json({ container: summary, detail, stats: stats.getLatest(id) });
  } catch (err) {
    res.status(404).json({ error: err.message || 'not found' });
  }
});

/**
 * Logs ya escritos, en texto: `since` (segundos unix) y `tail` (lineas, hasta `ws.tailMax`).
 * Es la version sin WebSocket del visor, para que otra app (la Oficina) cuente errores.
 */
app.get('/api/containers/:id/logs', async (req, res) => {
  const { id } = req.params;
  if (!isValidContainerId(id)) return res.status(400).json({ error: 'invalid container id' });

  const query = new URL(req.originalUrl, 'http://localhost').searchParams;
  const since = Math.max(Math.trunc(Number(query.get('since'))) || 0, 0);
  try {
    res.json({ id, since, lines: await readLogs(id, { since, tail: parseTail(query) }) });
  } catch (err) {
    res.status(err.statusCode === 404 ? 404 : 502).json({ error: err.message || 'Failed to read logs' });
  }
});

app.get('/api/history/:id', (req, res) => {
  const { id } = req.params;
  if (!isValidContainerId(id)) return res.status(400).json({ error: 'invalid container id' });

  const hours = clampHours(req.query.hours, 6);
  const since = Date.now() - hours * 3600000;
  res.json({ hours, samples: db.historyFor(id, since), events: db.eventsFor(id, 50) });
});

app.get('/api/host', (req, res) => {
  const hours = clampHours(req.query.hours, 6);
  const since = Date.now() - hours * 3600000;
  res.json({
    hours,
    current: watcher.getHost(),
    alerts: watcher.getHostAlerts(),
    thresholds: config.thresholds,
    samples: db.hostHistory(since),
    peaks: db.hostPeaks(since),
  });
});

app.get('/api/events', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  // `after=<id>`: lo que paso despues de ese evento, en orden. Lo usan otras apps (la Oficina) como cursor.
  if (req.query.after !== undefined) {
    const after = Number(req.query.after);
    if (!Number.isInteger(after) || after < 0) return res.status(400).json({ error: 'invalid after' });
    return res.json({ events: db.eventsAfter(after, limit) });
  }
  const hours = req.query.hours ? clampHours(req.query.hours, 24) : null;
  const severity = String(req.query.severity || '');

  const rows = db.queryEvents({
    since: hours ? Date.now() - hours * 3600000 : 0,
    limit,
    severity: ['crit', 'warn', 'info'].includes(severity) ? severity : null,
    notified: req.query.notified === '1',
  });

  res.json({ events: rows });
});

app.get('/api/domains', (_req, res) => {
  res.json({ domains: db.latestDomainChecks(), live: domains.getLatest(), state: domains.getState() });
});

app.get('/api/domains/:domain/history', (req, res) => {
  const domain = String(req.params.domain || '');
  if (!/^[a-z0-9.-]{1,253}$/i.test(domain)) return res.status(400).json({ error: 'invalid domain' });
  const hours = clampHours(req.query.hours, 24);
  res.json({ hours, samples: db.domainHistory(domain, Date.now() - hours * 3600000) });
});

app.get('/api/snort', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  res.json({ alerts: snort.getRecent(limit), health: snort.getHealth() });
});

app.get('/api/snort/summary', (req, res) => {
  const hours = clampHours(req.query.hours, 24);
  res.json(snort.getSummary(hours));
});

/** Vista previa del resumen diario, sin enviarlo. */
app.get('/api/digest', async (_req, res) => {
  try {
    res.json({ text: await digest.build(), health: digest.getHealth() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------- Push

app.get('/api/push/public-key', (_req, res) => {
  res.json({ enabled: push.enabled, key: push.publicKey(), minSeverity: config.push.minSeverity });
});

app.post('/api/push/subscribe', samePanel, (req, res) => {
  try {
    push.subscribe(req.body?.subscription || req.body, req.headers['user-agent']);
    res.status(201).json({ ok: true, subscribers: db.countPush() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/push/unsubscribe', samePanel, (req, res) => {
  push.unsubscribe(req.body?.endpoint);
  res.json({ ok: true, subscribers: db.countPush() });
});

app.post('/api/push/test', samePanel, async (req, res) => {
  try {
    const ok = await push.sendTest(req.body?.endpoint);
    res.json({ ok });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------- Ajustes

/**
 * Las escrituras (ajustes, reinicio, push) solo se aceptan desde el propio
 * panel: JSON (un formulario de otra web no puede mandarlo sin preflight, y no
 * hay CORS) y con un Origin presente e igual al host servido. Un `curl` sin
 * cabecera Origin recibe 403. Esto frena el CSRF y los scripts descuidados; no
 * es autenticacion: quien llega al puerto por Tailscale puede falsificar Origin.
 */
function samePanel(req, res, next) {
  if (!req.is('application/json')) return res.status(415).json({ error: 'se espera JSON' });
  if (!req.headers.origin || !originAllowed(req)) {
    return res.status(403).json({ error: 'origen no permitido: las escrituras solo se aceptan desde el panel' });
  }
  next();
}

app.get('/api/settings', (_req, res) => {
  res.json(settings.describe());
});

app.put('/api/settings', samePanel, (req, res) => {
  const result = settings.save(req.body?.changes);
  if (!result.ok) return res.status(400).json({ error: 'hay valores no válidos', errors: result.errors });

  if (result.changed.length) {
    const detail = `Ajustes cambiados desde el panel (${clientIp(req)}): ${result.changed
      .map(settings.describeChange)
      .join('; ')}`;
    console.log(`[settings] ${detail}`);
    db.insertEvent({
      ts: Date.now(), containerId: null, name: 'monitor', kind: 'config_changed', severity: 'info',
      detail: detail.slice(0, 2000), notified: false,
    });
  }
  res.json({
    ok: true,
    changed: result.changed.map((c) => c.field.key),
    restartRequired: result.restartRequired,
    settings: settings.describe(),
  });
});

/** Docker lo vuelve a levantar (`restart: unless-stopped`) con los ajustes nuevos. */
app.post('/api/settings/restart', samePanel, (req, res) => {
  console.log(`[settings] reinicio pedido desde el panel (${clientIp(req)})`);
  res.status(202).json({ ok: true });
  setTimeout(() => shutdown('reinicio desde el panel'), 300);
});

app.post('/api/settings/telegram-test', samePanel, async (req, res) => {
  const token = String(req.body?.token || '').trim() || settings.saved('telegram.token');
  const chatId = String(req.body?.chatId || '').trim() || settings.saved('telegram.chatId');
  // El token va en la ruta de la URL de Telegram: nada que no tenga su forma.
  if (token && !/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(token)) {
    return res.json({ ok: false, error: 'el token no tiene el formato 123456:ABC…' });
  }
  if (chatId && !/^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/.test(chatId)) {
    return res.json({ ok: false, error: 'el chat ID no tiene un formato válido' });
  }
  res.json(await notify.sendTest(token, chatId));
});

// ------------------------------------------------------------- Estaticos

const publicDir = path.join(__dirname, '..', 'public');

app.use(
  express.static(publicDir, {
    setHeaders(res, filePath) {
      // El service worker y la portada no se cachean: asi una version nueva del
      // panel llega al movil en la siguiente apertura, no una semana despues.
      if (/(?:^|[\\/])(?:sw\.js|index\.html|manifest\.webmanifest)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }),
);

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api/')) return next();
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ------------------------------------------------------------ WebSocket

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

const connectionsByIp = new Map();
let totalConnections = 0;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Detras de `tailscale serve` todas las conexiones llegan desde loopback con
 * el origen real en X-Forwarded-For. Solo se confia en esa cabecera cuando el
 * socket viene de loopback: un cliente directo no puede falsificarla.
 */
function clientIp(req) {
  const remote = req.socket.remoteAddress || 'unknown';
  if (LOOPBACK.has(remote)) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return remote;
}

/** Origin igual al host servido. Sin Origin se acepta; `samePanel` lo exige aparte. */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // clientes no-navegador (curl, wscat)
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function refuse(socket, code, message) {
  socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  // Lo que puede lanzar (un Host raro, un `%ZZ` en la ruta) va dentro del try:
  // una excepcion en este listener tumbaria el proceso entero.
  let url;
  let containerId;
  try {
    url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const match = url.pathname.match(/^\/api\/logs\/([^/]+)$/);
    if (!match) return refuse(socket, 404, 'Not Found');
    containerId = decodeURIComponent(match[1]);
  } catch {
    return refuse(socket, 400, 'Bad Request');
  }
  if (!isValidContainerId(containerId)) return refuse(socket, 400, 'Bad Request');

  if (!originAllowed(req)) return refuse(socket, 403, 'Forbidden');

  const ip = clientIp(req);
  if (totalConnections >= config.ws.maxTotal) return refuse(socket, 503, 'Too Many Connections');
  if ((connectionsByIp.get(ip) || 0) >= config.ws.maxPerIp) {
    return refuse(socket, 429, 'Too Many Requests');
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, containerId, url.searchParams);
  });
});

/**
 * `tail` ausente o ilegible usa el valor por defecto; el resto se acota a
 * [1, tailMax]. La ausencia se mira antes de `Number()`, porque `Number(null)` es 0.
 */
function parseTail(searchParams) {
  const value = searchParams.get('tail');
  if (value === null || value.trim() === '') return config.ws.tailDefault;
  const raw = Number(value);
  if (!Number.isFinite(raw)) return config.ws.tailDefault;
  return Math.min(Math.max(Math.trunc(raw), 1), config.ws.tailMax);
}

wss.on('connection', async (ws, req, containerId, searchParams) => {
  const ip = clientIp(req);
  totalConnections += 1;
  connectionsByIp.set(ip, (connectionsByIp.get(ip) || 0) + 1);

  const tail = parseTail(searchParams);
  let logStream = null;
  let leftover = Buffer.alloc(0);
  let closed = false;

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  const cleanup = () => {
    if (closed) return;
    closed = true;

    totalConnections = Math.max(0, totalConnections - 1);
    const left = (connectionsByIp.get(ip) || 1) - 1;
    if (left <= 0) connectionsByIp.delete(ip);
    else connectionsByIp.set(ip, left);

    if (logStream) {
      try {
        logStream.destroy();
      } catch {
        /* ignore */
      }
      logStream = null;
    }
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);

  try {
    const info = await docker.getContainer(containerId).inspect();
    if (closed) return; // el cliente cerro mientras esperabamos a Docker
    const isTty = Boolean(info.Config?.Tty);

    const stream = await streamLogs(containerId, { tail, follow: true });
    if (closed) {
      // `cleanup` ya paso y no vio ningun stream: si no se destruye aqui,
      // queda una conexion `follow` a Docker abierta para siempre.
      stream.destroy();
      return;
    }
    logStream = stream;

    logStream.on('data', (chunk) => {
      if (closed || ws.readyState !== ws.OPEN) return;

      if (isTty) {
        ws.send(JSON.stringify({ type: 'log', stream: 'stdout', text: chunk.toString('utf8') }));
        return;
      }

      leftover = Buffer.concat([leftover, chunk]);
      leftover = demuxDockerLogs(leftover, ({ stream, text }) => {
        if (closed || ws.readyState !== ws.OPEN) return;
        ws.send(JSON.stringify({ type: 'log', stream, text }));
      });
    });

    logStream.on('error', (err) => {
      if (closed || ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
      ws.close();
    });

    logStream.on('end', () => {
      if (closed || ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ type: 'end' }));
      ws.close();
    });

    ws.send(JSON.stringify({ type: 'ready', containerId, name: info.Name?.replace(/^\//, ''), tail }));
  } catch (err) {
    console.error('log stream failed', err);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: err.message || 'Failed to stream logs' }));
      ws.close();
    }
    cleanup();
  }
});

// Latido: Traefik o cualquier NAT corta los sockets inactivos sin avisar.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, config.ws.heartbeatMs);
heartbeat.unref();

// Watchdog: Docker NO reinicia un contenedor por estar unhealthy (solo lo
// marca), asi que si el bucle principal se queda colgado hay que salir desde
// dentro; `restart: unless-stopped` vuelve a levantar el proceso. El margen es
// ancho a proposito: una pasada puede tardar mas de un minuto si Telegram no
// responde (tres intentos de 10 s por mensaje).
const WATCHDOG_MS = Math.max(config.watch.intervalMs * 10, 5 * 60000);
const watchdog = setInterval(() => {
  const w = watcher.getHealth();
  const idle = Date.now() - (w.lastTickAt ?? w.startedAt);
  if (idle > WATCHDOG_MS) {
    console.error(`[server] watchdog: ${Math.round(idle / 1000)} s sin pasada del watcher; saliendo para que Docker reinicie`);
    shutdown('watchdog', 1);
  }
}, 30000);
watchdog.unref();

// ------------------------------------------------------------- Arranque

server.listen(config.port, '0.0.0.0', () => {
  // El bind publico real lo decide `ports:` del compose (solo Tailscale).
  console.log(`container-monitor ${VERSION} listening on :${config.port}`);

  db.startPruning();
  watcher.start();
  stats.start();
  domains.start();
  events.start();
  digest.start();
  snort.start().catch((err) => console.error('[snort] no arranco:', err.message));
});

let shuttingDown = false;

function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${reason}: cerrando`);
  clearInterval(heartbeat);
  clearInterval(watchdog);
  for (const ws of wss.clients) ws.terminate();
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Un fallo no controlado sale con codigo 1 y Docker vuelve a levantar el
// proceso. Seguir a medias (con un timer muerto o un stream roto) seria peor.
process.on('uncaughtException', (err) => {
  console.error('[server] excepcion no controlada:', err);
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (err) => {
  console.error('[server] promesa rechazada sin catch:', err);
  shutdown('unhandledRejection', 1);
});
