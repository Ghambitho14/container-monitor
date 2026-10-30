const config = require('./config');
const watcher = require('./watcher');
const { docker } = require('./docker');

/**
 * Stream de eventos de Docker (`GET /events`).
 *
 * El sondeo cada 20 s sigue siendo la fuente de verdad; este modulo solo lo
 * adelanta cuando Docker anuncia algo (`die`, `oom`, `health_status`, ...)
 * para que una caida se detecte en un segundo y no en veinte. El proxy de solo
 * lectura permite `/events` (`EVENTS=1`, el valor por defecto de
 * `tecnativa/docker-socket-proxy`).
 *
 * `oom` es el unico evento que se avisa directamente: un contenedor puede
 * reiniciarse tan rapido tras un OOM que el sondeo solo veria "reinicios +1",
 * y el motivo es lo que importa.
 */

const TRIGGERS = new Set([
  'create', 'start', 'restart', 'stop', 'kill', 'die', 'destroy', 'oom',
  'pause', 'unpause', 'rename', 'update',
]);

const state = {
  connected: false,
  attempts: 0,
  lastEventAt: null,
  connectedAt: null,
  received: 0,
};

let stream = null;
let retryTimer = null;

function nameFor(ev) {
  const id = ev.Actor?.ID || ev.id || '';
  const raw = ev.Actor?.Attributes?.name || id.slice(0, 12);
  const known = watcher.getSnapshot().find((c) => c.id === id);
  return { id, name: known?.displayName || raw };
}

function handle(ev) {
  state.lastEventAt = Date.now();
  state.received += 1;

  const action = String(ev.Action || '');
  // `exec_start: /bin/sh -c ...` llega con cada healthcheck: no interesa.
  if (action.startsWith('exec_')) return;

  const base = action.split(':')[0].trim();

  if (base === 'oom') {
    const { id, name } = nameFor(ev);
    watcher
      .emitExternal({
        ts: Date.now(), containerId: id, name, kind: 'container_oom', severity: 'crit',
        detail: 'El kernel mato un proceso del contenedor por falta de memoria (OOM)',
      })
      .catch((err) => console.error('[events] fallo al notificar OOM:', err.message));
  }

  if (TRIGGERS.has(base) || base === 'health_status') {
    watcher.requestTick({ inspect: true });
  }
}

function scheduleReconnect() {
  state.connected = false;
  stream = null;
  state.attempts += 1;
  const delay = Math.min(2000 * 2 ** Math.min(state.attempts - 1, 5), 60000);
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, delay);
  retryTimer.unref();
}

async function connect() {
  try {
    stream = await docker.getEvents({ filters: JSON.stringify({ type: ['container'] }) });
  } catch (err) {
    console.error('[events] no se pudo abrir el stream:', err.message);
    scheduleReconnect();
    return;
  }

  state.connected = true;
  state.connectedAt = Date.now();
  state.attempts = 0;
  console.log('[events] escuchando eventos de Docker');

  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      try {
        handle(ev);
      } catch (err) {
        console.error('[events] fallo procesando evento:', err.message);
      }
    }
  });

  const onEnd = (err) => {
    if (!state.connected) return;
    console.warn('[events] stream cerrado' + (err ? `: ${err.message}` : '') + '; reconectando');
    scheduleReconnect();
  };
  stream.on('error', onEnd);
  stream.on('end', () => onEnd());
  stream.on('close', () => onEnd());
}

function start() {
  if (!config.events.enabled) {
    console.log('[events] desactivado por configuracion');
    return;
  }
  connect();
}

const getState = () => ({ ...state, enabled: config.events.enabled });

module.exports = { start, getState };
