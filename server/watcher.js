const config = require('./config');
const db = require('./db');
const notify = require('./notify');
const push = require('./push');
const { listContainers, inspectSummary } = require('./docker');
const { sampleHost, cpuCount } = require('./host');

/**
 * Compara el estado actual contra el anterior y avisa en las transiciones.
 *
 * Cuatro reglas evitan que los avisos se vuelvan ruido:
 *
 *  1. Gracia de arranque: la primera pasada solo siembra el estado.
 *  2. Antirrebote: no se repite el mismo (objeto, tipo) dentro de la ventana.
 *  3. Agrupacion: muchos cambios a la vez viajan como un unico resumen.
 *  4. Estado, no muestras: los umbrales del host avisan una vez al superarse y
 *     otra al recuperarse, con histeresis.
 *
 * El sondeo periodico sigue siendo la fuente de verdad; `events.js` solo lo
 * adelanta (`requestTick`) cuando Docker anuncia un cambio, para que una caida
 * se detecte en un segundo y no en veinte.
 */

const DOWN_STATES = new Set(['exited', 'dead']);

let prev = new Map();
let seeded = false;
let lastSnapshot = [];
let lastHost = null;
const dedupe = new Map();

const health = {
  startedAt: Date.now(),
  lastTickAt: null,
  lastOkAt: null,
  dockerFailures: 0,
  dockerDown: false,
  ticks: 0,
};

// ------------------------------------------------------------ antirrebote

/**
 * Sin contenedor, el nombre (dominio, origen de Snort) forma parte de la clave:
 * cinco dominios caidos a la vez son cinco avisos, no uno.
 */
function dedupeKey(event) {
  return `${event.containerId || event.name || 'host'}:${event.kind}`;
}

function shouldEmit(key, ts) {
  const windowMs = config.watch.dedupeMinutes * 60000;
  const last = dedupe.get(key);
  if (last && ts - last < windowMs) return false;
  dedupe.set(key, ts);
  return true;
}

function pruneDedupe(ts) {
  const windowMs = config.watch.dedupeMinutes * 60000;
  for (const [key, at] of dedupe) {
    if (ts - at > windowMs) dedupe.delete(key);
  }
}

function record(events, event) {
  // El historial se guarda siempre; el antirrebote solo decide si se notifica.
  const passes = shouldEmit(dedupeKey(event), event.ts);
  // `notified` se da por bueno de entrada si hay algun canal; si luego ninguno
  // lo entrega, `flush` lo vuelve a poner a 0.
  const channels = notify.enabled || push.hasSubscribers();
  event.id = db.insertEvent({ ...event, notified: passes && channels });
  if (passes) events.push(event);
}

/** Ningun canal lo entrego: que el historial no diga que si. */
function markUnsent(event) {
  if (event.id == null) return;
  try {
    db.markNotified(event.id, false);
  } catch (err) {
    console.error('[watcher] no se pudo corregir notified:', err.message);
  }
}

// ------------------------------------------------------------ contenedores

const restartLog = new Map(); // id -> timestamps de reinicios recientes

function noteRestarts(events, ts, c, delta) {
  const windowMs = config.containers.restartLoopMinutes * 60000;
  const log = restartLog.get(c.id) || [];
  for (let i = 0; i < delta; i += 1) log.push(ts);
  while (log.length && ts - log[0] > windowMs) log.shift();
  restartLog.set(c.id, log);

  if (log.length >= config.containers.restartLoopCount) {
    record(events, {
      ts, containerId: c.id, name: c.displayName || c.name,
      kind: 'container_restart_loop', severity: 'crit',
      detail: `Bucle de reinicio: ${log.length} reinicios en ${config.containers.restartLoopMinutes} min` +
        (c.exitCode ? ` (ultimo exit ${c.exitCode})` : '') +
        (c.oomKilled ? ' — matado por falta de memoria (OOM)' : ''),
    });
  }
}

function diffContainer(events, ts, before, after) {
  const name = after.displayName || after.name;
  const oom = after.oomKilled ? ' — matado por falta de memoria (OOM)' : '';

  if (!before) {
    record(events, {
      ts, containerId: after.id, name, kind: 'container_new',
      severity: 'info', to: after.state,
      detail: `Contenedor nuevo (${after.state})`,
    });
    return;
  }

  if (before.state !== after.state) {
    if (DOWN_STATES.has(after.state)) {
      record(events, {
        ts, containerId: after.id, name, kind: 'container_down',
        severity: 'crit', from: before.state, to: after.state,
        detail: `Cayo: ${before.state} → ${after.state}. ${after.status}${oom}`,
      });
    } else if (after.state === 'running' && DOWN_STATES.has(before.state)) {
      record(events, {
        ts, containerId: after.id, name, kind: 'container_up',
        severity: 'info', from: before.state, to: after.state,
        detail: 'Recuperado, vuelve a correr',
      });
    } else if (after.state === 'paused' || before.state === 'paused') {
      record(events, {
        ts, containerId: after.id, name,
        kind: after.state === 'paused' ? 'container_paused' : 'container_unpaused',
        severity: after.state === 'paused' ? 'warn' : 'info',
        from: before.state, to: after.state,
        detail: after.state === 'paused' ? 'Contenedor pausado' : 'Contenedor reanudado',
      });
    }
  }

  // Solo cuenta el healthcheck de un contenedor en marcha: uno parado conserva
  // en el inspect su ultima salud, y su caida ya la avisa `container_down`.
  if (after.state === 'running' && before.health !== after.health) {
    if (after.health === 'unhealthy') {
      record(events, {
        ts, containerId: after.id, name, kind: 'container_unhealthy',
        severity: 'crit', from: before.health, to: after.health,
        detail: 'El healthcheck falla',
      });
    } else if (after.health === 'healthy' && before.health === 'unhealthy') {
      record(events, {
        ts, containerId: after.id, name, kind: 'container_healthy',
        severity: 'info', from: before.health, to: after.health,
        detail: 'Healthcheck en verde otra vez',
      });
    }
  }

  if (
    typeof before.restartCount === 'number' &&
    typeof after.restartCount === 'number' &&
    after.restartCount > before.restartCount
  ) {
    const delta = after.restartCount - before.restartCount;
    record(events, {
      ts, containerId: after.id, name, kind: 'container_restarted',
      severity: 'warn',
      detail: `Reinicios: ${before.restartCount} → ${after.restartCount}` +
        (after.exitCode ? ` (exit ${after.exitCode})` : '') + oom,
    });
    noteRestarts(events, ts, after, delta);
  }
}

async function enrichWithInspect(containers) {
  const results = await Promise.allSettled(
    containers.map(async (c) => {
      const extra = await inspectSummary(c.id);
      return { id: c.id, extra };
    }),
  );

  const byId = new Map();
  for (const r of results) {
    if (r.status === 'fulfilled') byId.set(r.value.id, r.value.extra);
  }

  for (const c of containers) {
    const extra = byId.get(c.id);
    if (!extra) continue;
    c.restartCount = extra.restartCount;
    c.restartPolicy = extra.restartPolicy;
    c.exitCode = extra.exitCode;
    c.oomKilled = extra.oomKilled;
    c.startedAt = extra.startedAt;
    c.memLimit = extra.memLimit;
    // El inspect trae la salud autentica; el listado solo la adivina del texto.
    // Un contenedor parado conserva congelada la ultima salud que tuvo, asi que
    // se descarta: fuera de `running` la salud no significa nada.
    c.health = c.state === 'running' ? extra.health || c.health : null;
  }

  return containers;
}

/** Arrastra lo que solo trae el inspect cuando este turno no lo ejecuta. */
function carryOver(containers) {
  for (const c of containers) {
    const before = prev.get(c.id);
    if (!before) continue;
    if (typeof before.restartCount === 'number') {
      c.restartCount = before.restartCount;
      c.restartPolicy = before.restartPolicy;
      c.exitCode = before.exitCode;
      c.oomKilled = before.oomKilled;
      c.startedAt = before.startedAt;
      c.memLimit = before.memLimit;
    }
    // La salud tambien se arrastra: el listado la deduce del texto de `Status`
    // y da null si el contenedor no corre. La fuente fiable es el inspect.
    c.health = before.health;
  }
}

// ------------------------------------------------------------ host

const hostState = new Map(); // kind -> true mientras el umbral siga superado
const sustained = new Map(); // kind -> muestras dentro de la ventana

/**
 * Media movil de los ultimos `sustainMinutes`. Devuelve null hasta que la
 * ventana esta razonablemente llena: no se avisa de "CPU sostenida" con dos
 * muestras.
 */
function sustainedAvg(kind, ts, value) {
  const windowMs = config.thresholds.sustainMinutes * 60000;
  const arr = sustained.get(kind) || [];
  arr.push({ ts, value });
  while (arr.length && ts - arr[0].ts > windowMs) arr.shift();
  sustained.set(kind, arr);
  if (!arr.length || ts - arr[0].ts < windowMs * 0.8) return null;
  return arr.reduce((a, b) => a + b.value, 0) / arr.length;
}

function hostRules(sample, ts) {
  const t = config.thresholds;
  const cpus = sample.cpus || cpuCount();
  const cpuAvg = sample.cpuPct === null ? null : sustainedAvg('host_cpu', ts, sample.cpuPct);
  const loadAvg = sustainedAvg('host_load', ts, sample.load1);
  return [
    { kind: 'host_disk', severity: 'crit', label: 'Disco', value: sample.diskPct, threshold: t.diskPct, unit: '%' },
    { kind: 'host_mem', severity: 'warn', label: 'RAM', value: sample.memPct, threshold: t.memPct, unit: '%' },
    { kind: 'host_swap', severity: 'warn', label: 'Swap', value: sample.swapPct, threshold: t.swapPct, unit: '%' },
    {
      kind: 'host_cpu', severity: 'warn', label: `CPU (media ${t.sustainMinutes} min)`,
      value: cpuAvg, threshold: t.cpuPct, unit: '%',
    },
    {
      kind: 'host_load', severity: 'warn', label: `Carga (media ${t.sustainMinutes} min)`,
      value: loadAvg, threshold: t.loadPerCpu * cpus, unit: '', hysteresis: 0.5 * cpus,
    },
  ];
}

function checkHostThresholds(events, ts, sample) {
  for (const rule of hostRules(sample, ts)) {
    if (rule.value === null || rule.value === undefined) continue;
    const was = hostState.get(rule.kind) || false;
    const hyst = rule.hysteresis ?? config.thresholds.hysteresisPct;
    const fmt = (v) => `${Math.round(v * 10) / 10}${rule.unit}`;

    if (!was && rule.value >= rule.threshold) {
      hostState.set(rule.kind, true);
      record(events, {
        ts, containerId: null, name: 'host', kind: rule.kind, severity: rule.severity,
        detail: `${rule.label} al ${fmt(rule.value)} (umbral ${fmt(rule.threshold)})`,
      });
    } else if (was && rule.value < rule.threshold - hyst) {
      hostState.set(rule.kind, false);
      record(events, {
        ts, containerId: null, name: 'host', kind: `${rule.kind}_ok`, severity: 'info',
        detail: `${rule.label} vuelve a ${fmt(rule.value)}`,
      });
    }
  }
}

async function checkHost(events, ts) {
  const sample = await sampleHost();
  lastHost = sample;
  db.insertHostSample(ts, sample);
  checkHostThresholds(events, ts, sample);
}

// ------------------------------------------------------------ docker

function dockerFailed(events, ts, err) {
  health.dockerFailures += 1;
  console.error(`[watcher] fallo al listar contenedores (${health.dockerFailures}):`, err.message);
  if (!health.dockerDown && health.dockerFailures >= config.monitor.dockerFailures) {
    health.dockerDown = true;
    record(events, {
      ts, containerId: null, name: 'monitor', kind: 'monitor_docker_unreachable', severity: 'crit',
      detail: `Docker no responde tras ${health.dockerFailures} intentos: ${err.message}`,
    });
  }
}

function dockerRecovered(events, ts) {
  if (health.dockerDown) {
    health.dockerDown = false;
    record(events, {
      ts, containerId: null, name: 'monitor', kind: 'monitor_docker_ok', severity: 'info',
      detail: 'Docker vuelve a responder',
    });
  }
  health.dockerFailures = 0;
  health.lastOkAt = ts;
}

// ------------------------------------------------------------ envio

async function flush(events) {
  if (!events.length) return;

  if (events.length >= config.watch.groupThreshold) {
    const sent = await notify.send(notify.formatSummary(events));
    const pushed = await push.broadcast(push.fromSummary(events));
    if (!sent && !pushed) events.forEach(markUnsent);
    return;
  }

  for (const event of events) {
    // Las recuperaciones llegan sin sonido: informan, no despiertan.
    const sent = await notify.send(notify.formatEvent(event), { silent: event.severity === 'info' });
    const pushed = await push.broadcast(push.fromEvent(event));
    if (!sent && !pushed) markUnsent(event);
  }
}

// ------------------------------------------------------------ ciclo

let inspectDue = 0;
let running = false;
let queued = false;
let debounceTimer = null;

async function runTick() {
  const ts = Date.now();
  const events = [];
  health.lastTickAt = ts;
  health.ticks += 1;

  try {
    const containers = await listContainers();

    // El inspect (reinicios, salud real) va a una cadencia mas lenta que el listado.
    if (ts >= inspectDue) {
      inspectDue = ts + config.watch.inspectIntervalMs;
      await enrichWithInspect(containers);
    } else {
      carryOver(containers);
    }

    lastSnapshot = containers;
    const next = new Map(containers.map((c) => [c.id, c]));

    if (!seeded) {
      // Gracia de arranque: sembrar sin avisar de nada.
      prev = next;
      seeded = true;
      console.log(`[watcher] estado inicial sembrado con ${next.size} contenedores`);
    } else {
      for (const c of containers) {
        diffContainer(events, ts, prev.get(c.id), c);
      }
      for (const [id, before] of prev) {
        if (!next.has(id)) {
          record(events, {
            ts, containerId: id, name: before.displayName || before.name,
            kind: 'container_gone', severity: 'warn', from: before.state,
            detail: 'El contenedor ya no existe',
          });
          restartLog.delete(id);
        }
      }
      prev = next;
    }
    dockerRecovered(events, ts);
  } catch (err) {
    dockerFailed(events, ts, err);
  }

  try {
    await checkHost(events, ts);
  } catch (err) {
    console.error('[watcher] fallo al muestrear el host:', err.message);
  }

  pruneDedupe(ts);

  try {
    await flush(events);
  } catch (err) {
    console.error('[watcher] fallo al notificar:', err.message);
  }
}

/** Nunca hay dos pasadas a la vez: si llega una peticion en medio, se encola. */
async function tick() {
  if (running) {
    queued = true;
    return;
  }
  running = true;
  try {
    await runTick();
  } finally {
    running = false;
    if (queued) {
      queued = false;
      setImmediate(() => tick().catch((err) => console.error('[watcher] tick:', err.message)));
    }
  }
}

/**
 * Adelanta la siguiente pasada (con inspect completo). Lo usa el stream de
 * eventos de Docker; el debounce agrupa la rafaga de eventos de un `compose up`.
 */
function requestTick({ inspect = true } = {}) {
  if (inspect) inspectDue = 0;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    tick().catch((err) => console.error('[watcher] tick:', err.message));
  }, config.events.debounceMs);
  debounceTimer.unref();
}

function start() {
  tick().catch((err) => console.error('[watcher] tick:', err.message));
  const timer = setInterval(() => {
    tick().catch((err) => console.error('[watcher] tick:', err.message));
  }, config.watch.intervalMs);
  timer.unref();
  return timer;
}

/** Permite que otros modulos (snort, dominios, stats) usen el mismo antirrebote y canal. */
async function emitExternal(event) {
  const events = [];
  record(events, event);
  await flush(events);
}

const getSnapshot = () => lastSnapshot;
const getHost = () => lastHost;
const getHostAlerts = () => [...hostState].filter(([, on]) => on).map(([kind]) => kind);
const getHealth = () => ({ ...health, hostAlerts: getHostAlerts() });

module.exports = { start, tick, requestTick, emitExternal, getSnapshot, getHost, getHostAlerts, getHealth };
