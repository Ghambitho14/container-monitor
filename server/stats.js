const config = require('./config');
const db = require('./db');
const { sampleStats } = require('./docker');
const watcher = require('./watcher');

/**
 * Muestreo periodico de `stats` por contenedor.
 *
 * Una llamada `stats` por contenedor a la vez castiga al daemon en una maquina
 * pequena, asi que van en tandas de `STATS_CONCURRENCY`.
 *
 * Ademas vigila la memoria de cada contenedor respecto a SU limite (solo los que
 * tienen uno): al pasar de `ALERT_CONTAINER_MEM_PCT` durante N muestras seguidas
 * se avisa, y al bajar se avisa de la recuperacion.
 */

const latest = new Map();
const memHigh = new Map(); // id -> muestras seguidas por encima del umbral
const memAlerted = new Set();
const health = { lastRunAt: null, lastOkAt: null, sampled: 0, failed: 0 };

async function mapWithLimit(items, limit, fn) {
  const results = [];
  let index = 0;

  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (index < items.length) {
      const i = index;
      index += 1;
      try {
        results[i] = await fn(items[i]);
      } catch {
        results[i] = null;
      }
    }
  });

  await Promise.all(workers);
  return results;
}

/** El limite "real" es menor que la RAM del host; si no, es que no hay limite. */
function effectiveLimit(sample) {
  const hostTotal = watcher.getHost()?.memTotal || 0;
  const limit = sample.memLimit || 0;
  if (!limit) return 0;
  if (hostTotal && limit >= hostTotal * 0.98) return 0;
  return limit;
}

function fmtBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

async function checkMemory(ts, c, sample) {
  const limit = effectiveLimit(sample);
  if (!limit) {
    memHigh.delete(c.id);
    return;
  }

  const pct = (sample.memBytes / limit) * 100;
  const threshold = config.containers.memPct;
  const name = c.displayName || c.name;

  if (pct >= threshold) {
    const n = (memHigh.get(c.id) || 0) + 1;
    memHigh.set(c.id, n);
    if (n >= config.containers.memSamples && !memAlerted.has(c.id)) {
      memAlerted.add(c.id);
      await watcher.emitExternal({
        ts, containerId: c.id, name, kind: 'container_mem', severity: 'warn',
        detail: `Memoria al ${Math.round(pct)}% de su limite (${fmtBytes(sample.memBytes)} de ${fmtBytes(limit)})`,
      });
    }
  } else if (pct < threshold - config.thresholds.hysteresisPct) {
    memHigh.delete(c.id);
    if (memAlerted.delete(c.id)) {
      await watcher.emitExternal({
        ts, containerId: c.id, name, kind: 'container_mem_ok', severity: 'info',
        detail: `Memoria vuelve al ${Math.round(pct)}% de su limite`,
      });
    }
  }
}

// El intervalo de 30 s no espera a la pasada anterior: con pocas tandas y
// muchos contenedores, dos pasadas solapadas duplican muestras y cuentan dos
// veces la memoria alta. Misma guardia que usa domains.js.
let sampling = false;

async function tick() {
  if (sampling) return;
  sampling = true;
  try {
    await sampleAll();
  } finally {
    sampling = false;
  }
}

async function sampleAll() {
  health.lastRunAt = Date.now();
  const running = watcher.getSnapshot().filter((c) => c.state === 'running');

  // Un contenedor que se para deja de muestrearse: si no se limpia, el panel
  // sigue enseñando su ultima medida como si fuera actual.
  const alive = new Set(running.map((c) => c.id));
  for (const id of latest.keys()) {
    if (!alive.has(id)) {
      latest.delete(id);
      memHigh.delete(id);
      memAlerted.delete(id);
    }
  }

  if (!running.length) return;

  const ts = Date.now();

  await mapWithLimit(running, config.stats.concurrency, async (c) => {
    try {
      const sample = await sampleStats(c.id);
      db.insertSample(ts, c.id, c.displayName || c.name, sample);
      latest.set(c.id, { ts, ...sample });
      health.sampled += 1;
      health.lastOkAt = Date.now();
      await checkMemory(ts, c, sample);
      return sample;
    } catch (err) {
      health.failed += 1;
      throw err;
    }
  });
}

function start() {
  // Primera muestra ya, sin esperar el intervalo: si no, el panel arranca vacio
  // de metricas durante los primeros 30 s.
  tick().catch((err) => console.error('[stats] primer muestreo fallo:', err.message));
  const timer = setInterval(() => {
    tick().catch((err) => console.error('[stats] fallo el muestreo:', err.message));
  }, config.stats.intervalMs);
  timer.unref();
  return timer;
}

const getLatest = (containerId) => latest.get(containerId) || null;
const getAllLatest = () => Object.fromEntries(latest);
const getHealth = () => ({ ...health, memAlerts: [...memAlerted] });

module.exports = { start, getLatest, getAllLatest, getHealth };
