const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

/**
 * Persistencia: SQLite (`node:sqlite`, integrado en Node) en `data/monitor.db`.
 *
 * Tablas: `samples` (stats por contenedor cada 30 s), `host_samples` (una por
 * pasada del watcher), `events` (historial de avisos, con `notified`),
 * `domain_checks`, `snort_alerts` y `push_subscriptions`. Modo WAL para que las
 * lecturas del panel no bloqueen al muestreador.
 *
 * Las series largas se devuelven agregadas por cubo (`bucketFor`) para que el
 * navegador no reciba 20k puntos. La retencion (`RETENTION_DAYS`) borra por
 * antiguedad una vez por hora; los eventos duran el doble.
 *
 * El esquema se crea con `CREATE TABLE IF NOT EXISTS` al importar el modulo;
 * no hay migraciones.
 */
fs.mkdirSync(config.dataDir, { recursive: true });

const db = new DatabaseSync(path.join(config.dataDir, 'monitor.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS samples (
    ts           INTEGER NOT NULL,
    container_id TEXT    NOT NULL,
    name         TEXT    NOT NULL,
    cpu_pct      REAL,
    mem_bytes    INTEGER,
    mem_limit    INTEGER,
    net_rx       INTEGER,
    net_tx       INTEGER,
    blk_r        INTEGER,
    blk_w        INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_samples_id_ts ON samples (container_id, ts);
  CREATE INDEX IF NOT EXISTS idx_samples_ts    ON samples (ts);

  CREATE TABLE IF NOT EXISTS host_samples (
    ts        INTEGER NOT NULL,
    cpu_pct   REAL,
    load1     REAL,
    mem_used  INTEGER,
    mem_total INTEGER,
    swap_used INTEGER,
    swap_total INTEGER,
    disk_pct  REAL
  );
  CREATE INDEX IF NOT EXISTS idx_host_ts ON host_samples (ts);

  CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    container_id TEXT,
    name         TEXT,
    kind         TEXT    NOT NULL,
    severity     TEXT    NOT NULL DEFAULT 'warn',
    from_state   TEXT,
    to_state     TEXT,
    detail       TEXT,
    notified     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);

  CREATE TABLE IF NOT EXISTS domain_checks (
    ts         INTEGER NOT NULL,
    domain     TEXT    NOT NULL,
    ok         INTEGER NOT NULL,
    status     INTEGER,
    latency_ms INTEGER,
    cert_days  INTEGER,
    error      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_domain_ts ON domain_checks (domain, ts);

  CREATE TABLE IF NOT EXISTS snort_alerts (
    ts             INTEGER NOT NULL,
    sid            TEXT    NOT NULL,
    msg            TEXT,
    classification TEXT,
    priority       INTEGER,
    proto          TEXT,
    src            TEXT,
    src_port       INTEGER,
    dst            TEXT,
    dst_port       INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_snort_ts  ON snort_alerts (ts);
  CREATE INDEX IF NOT EXISTS idx_snort_src ON snort_alerts (src, ts);

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint   TEXT PRIMARY KEY,
    keys_json  TEXT    NOT NULL,
    user_agent TEXT,
    created_at INTEGER NOT NULL,
    last_ok_at INTEGER,
    failures   INTEGER NOT NULL DEFAULT 0
  );
`);

const stmts = {
  insertSample: db.prepare(
    `INSERT INTO samples (ts, container_id, name, cpu_pct, mem_bytes, mem_limit, net_rx, net_tx, blk_r, blk_w)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  insertHostSample: db.prepare(
    `INSERT INTO host_samples (ts, cpu_pct, load1, mem_used, mem_total, swap_used, swap_total, disk_pct)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  insertEvent: db.prepare(
    `INSERT INTO events (ts, container_id, name, kind, severity, from_state, to_state, detail, notified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  insertDomainCheck: db.prepare(
    `INSERT INTO domain_checks (ts, domain, ok, status, latency_ms, cert_days, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ),
  insertSnortAlert: db.prepare(
    `INSERT INTO snort_alerts (ts, sid, msg, classification, priority, proto, src, src_port, dst, dst_port)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ),

  historyRaw: db.prepare(
    `SELECT ts, cpu_pct, mem_bytes, mem_limit, net_rx, net_tx
       FROM samples
      WHERE container_id = ? AND ts >= ?
      ORDER BY ts ASC`,
  ),
  // Media por cubo para rangos largos: 7 dias a 30 s son 20k puntos por
  // contenedor; el navegador no necesita mas de unos cientos.
  // `CAST(?1 AS INTEGER)`: node:sqlite enlaza los numeros de JS como REAL, y
  // con division real cada fila cae en su propio cubo (no se agrupa nada).
  historyBucketed: db.prepare(
    `SELECT (ts / CAST(?1 AS INTEGER)) * CAST(?1 AS INTEGER) AS ts,
            AVG(cpu_pct)   AS cpu_pct,
            AVG(mem_bytes) AS mem_bytes,
            MAX(mem_limit) AS mem_limit,
            MAX(net_rx)    AS net_rx,
            MAX(net_tx)    AS net_tx
       FROM samples
      WHERE container_id = ?2 AND ts >= ?3
      GROUP BY 1
      ORDER BY 1 ASC`,
  ),
  hostRaw: db.prepare(`SELECT * FROM host_samples WHERE ts >= ? ORDER BY ts ASC`),
  hostBucketed: db.prepare(
    `SELECT (ts / CAST(?1 AS INTEGER)) * CAST(?1 AS INTEGER) AS ts,
            AVG(cpu_pct)    AS cpu_pct,
            AVG(load1)      AS load1,
            AVG(mem_used)   AS mem_used,
            MAX(mem_total)  AS mem_total,
            AVG(swap_used)  AS swap_used,
            MAX(swap_total) AS swap_total,
            AVG(disk_pct)   AS disk_pct
       FROM host_samples
      WHERE ts >= ?2
      GROUP BY 1
      ORDER BY 1 ASC`,
  ),
  hostPeaks: db.prepare(
    `SELECT MAX(cpu_pct) AS cpu_pct, MAX(load1) AS load1,
            MAX(mem_used * 100.0 / NULLIF(mem_total, 0)) AS mem_pct,
            MAX(swap_used * 100.0 / NULLIF(swap_total, 0)) AS swap_pct,
            MAX(disk_pct) AS disk_pct,
            AVG(cpu_pct) AS cpu_avg
       FROM host_samples WHERE ts >= ?`,
  ),

  recentEvents: db.prepare(`SELECT * FROM events ORDER BY ts DESC LIMIT ?`),
  eventsFor: db.prepare(`SELECT * FROM events WHERE container_id = ? ORDER BY ts DESC LIMIT ?`),
  eventsSince: db.prepare(`SELECT * FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT ?`),
  eventsAfter: db.prepare(`SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?`),
  markNotified: db.prepare(`UPDATE events SET notified = ? WHERE id = ?`),
  eventCountsSince: db.prepare(
    `SELECT severity, COUNT(*) AS n, SUM(notified) AS notified FROM events WHERE ts >= ? GROUP BY severity`,
  ),
  eventKindsSince: db.prepare(
    `SELECT kind, name, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY kind, name ORDER BY n DESC`,
  ),

  latestDomainChecks: db.prepare(
    `SELECT d.* FROM domain_checks d
      JOIN (SELECT domain, MAX(ts) AS ts FROM domain_checks GROUP BY domain) last
        ON d.domain = last.domain AND d.ts = last.ts
      ORDER BY d.domain`,
  ),
  domainHistory: db.prepare(
    `SELECT ts, ok, status, latency_ms, cert_days, error FROM domain_checks
      WHERE domain = ? AND ts >= ? ORDER BY ts ASC`,
  ),
  domainFailuresSince: db.prepare(
    `SELECT domain, COUNT(*) AS n FROM domain_checks WHERE ts >= ? AND ok = 0 GROUP BY domain`,
  ),

  recentSnort: db.prepare(`SELECT * FROM snort_alerts ORDER BY ts DESC LIMIT ?`),
  snortCountSince: db.prepare(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT src) AS sources FROM snort_alerts WHERE ts >= ?`,
  ),
  snortTopSources: db.prepare(
    `SELECT src, COUNT(*) AS n, MAX(ts) AS last_ts, MIN(priority) AS priority,
            (SELECT msg FROM snort_alerts s2 WHERE s2.src = s.src AND s2.ts >= ?1 ORDER BY ts DESC LIMIT 1) AS last_msg
       FROM snort_alerts s WHERE ts >= ?1 GROUP BY src ORDER BY n DESC LIMIT ?2`,
  ),
  snortTopRules: db.prepare(
    `SELECT sid, msg, COUNT(*) AS n, MIN(priority) AS priority FROM snort_alerts
      WHERE ts >= ? GROUP BY sid ORDER BY n DESC LIMIT ?`,
  ),

  upsertPush: db.prepare(
    `INSERT INTO push_subscriptions (endpoint, keys_json, user_agent, created_at, last_ok_at, failures)
     VALUES (?, ?, ?, ?, NULL, 0)
     ON CONFLICT(endpoint) DO UPDATE SET keys_json = excluded.keys_json, user_agent = excluded.user_agent, failures = 0`,
  ),
  deletePush: db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`),
  listPush: db.prepare(`SELECT * FROM push_subscriptions`),
  countPush: db.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions`),
  pushOk: db.prepare(`UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE endpoint = ?`),
  pushFail: db.prepare(`UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?`),

  tableStats: db.prepare(
    `SELECT (SELECT COUNT(*) FROM samples) AS samples,
            (SELECT COUNT(*) FROM host_samples) AS host_samples,
            (SELECT COUNT(*) FROM events) AS events,
            (SELECT COUNT(*) FROM snort_alerts) AS snort_alerts,
            (SELECT COUNT(*) FROM push_subscriptions) AS push_subscriptions`,
  ),
};

function insertSample(ts, containerId, name, s) {
  stmts.insertSample.run(
    ts, containerId, name,
    s.cpuPct, s.memBytes, s.memLimit, s.netRx, s.netTx, s.blkRead, s.blkWrite,
  );
}

function insertHostSample(ts, h) {
  stmts.insertHostSample.run(
    ts, h.cpuPct, h.load1, h.memUsed, h.memTotal, h.swapUsed, h.swapTotal, h.diskPct,
  );
}

function insertEvent(event) {
  const info = stmts.insertEvent.run(
    event.ts,
    event.containerId || null,
    event.name || null,
    event.kind,
    event.severity || 'warn',
    event.from || null,
    event.to || null,
    event.detail || null,
    event.notified ? 1 : 0,
  );
  return info.lastInsertRowid;
}

function insertDomainCheck(ts, check) {
  stmts.insertDomainCheck.run(
    ts, check.domain, check.ok ? 1 : 0,
    check.status ?? null, check.latencyMs ?? null, check.certDays ?? null, check.error ?? null,
  );
}

function insertSnortAlert(a) {
  stmts.insertSnortAlert.run(
    a.ts, String(a.sid), a.msg || null, a.classification || null, a.priority ?? null,
    a.proto || null, a.src || null, a.srcPort ?? null, a.dst || null, a.dstPort ?? null,
  );
}

/**
 * Elige el cubo para que un rango devuelva como mucho ~`maxPoints` puntos.
 * Devuelve 0 (sin agrupar) cuando el rango cabe entero.
 */
function bucketFor(sinceTs, sampleMs, maxPoints = 400) {
  const span = Date.now() - sinceTs;
  const raw = span / sampleMs;
  if (raw <= maxPoints) return 0;
  const bucket = Math.ceil(raw / maxPoints) * sampleMs;
  return Math.max(bucket, sampleMs);
}

function historyFor(containerId, sinceTs) {
  const bucket = bucketFor(sinceTs, config.stats.intervalMs);
  if (!bucket) return stmts.historyRaw.all(containerId, sinceTs);
  return stmts.historyBucketed.all(bucket, containerId, sinceTs);
}

function hostHistory(sinceTs) {
  const bucket = bucketFor(sinceTs, config.watch.intervalMs);
  if (!bucket) return stmts.hostRaw.all(sinceTs);
  return stmts.hostBucketed.all(bucket, sinceTs);
}

const hostPeaks = (sinceTs) => stmts.hostPeaks.get(sinceTs);
const recentEvents = (limit) => stmts.recentEvents.all(limit);
const eventsFor = (containerId, limit) => stmts.eventsFor.all(containerId, limit);
const eventsSince = (sinceTs, limit) => stmts.eventsSince.all(sinceTs, limit);
/** Eventos posteriores a un id, del mas viejo al mas nuevo: para que otra app los lea sin perder ni repetir. */
const eventsAfter = (afterId, limit) => stmts.eventsAfter.all(afterId, limit);

/**
 * Eventos con los filtros (severidad, solo enviados) dentro de la consulta,
 * para que el LIMIT se aplique DESPUES de filtrar: `severity=crit&limit=100`
 * son los 100 ultimos criticos, no los criticos entre los 100 ultimos.
 */
const eventQueries = new Map();
function queryEvents({ since = 0, limit = 100, severity = null, notified = false } = {}) {
  const key = `${severity ? 's' : '-'}${notified ? 'n' : '-'}`;
  if (!eventQueries.has(key)) {
    const where = ['ts >= ?'];
    if (severity) where.push('severity = ?');
    if (notified) where.push('notified = 1');
    eventQueries.set(key, db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`));
  }
  const params = severity ? [since, severity, limit] : [since, limit];
  return eventQueries.get(key).all(...params);
}

/** `notified` se escribe al registrar el evento y se corrige si ningun canal lo entrego. */
const markNotified = (id, notified) => stmts.markNotified.run(notified ? 1 : 0, id);
const eventCountsSince = (sinceTs) => stmts.eventCountsSince.all(sinceTs);
const eventKindsSince = (sinceTs) => stmts.eventKindsSince.all(sinceTs);
const latestDomainChecks = () => stmts.latestDomainChecks.all();
const domainHistory = (domain, sinceTs) => stmts.domainHistory.all(domain, sinceTs);
const domainFailuresSince = (sinceTs) => stmts.domainFailuresSince.all(sinceTs);
const recentSnort = (limit) => stmts.recentSnort.all(limit);
const snortCountSince = (sinceTs) => stmts.snortCountSince.get(sinceTs);
const snortTopSources = (sinceTs, limit) => stmts.snortTopSources.all(sinceTs, limit);
const snortTopRules = (sinceTs, limit) => stmts.snortTopRules.all(sinceTs, limit);

const upsertPush = (sub, userAgent) =>
  stmts.upsertPush.run(sub.endpoint, JSON.stringify(sub.keys || {}), userAgent || null, Date.now());
const deletePush = (endpoint) => stmts.deletePush.run(endpoint);
const listPush = () =>
  stmts.listPush.all().map((row) => ({ ...row, keys: JSON.parse(row.keys_json || '{}') }));
const countPush = () => stmts.countPush.get().n;
const pushOk = (endpoint) => stmts.pushOk.run(Date.now(), endpoint);
const pushFail = (endpoint) => stmts.pushFail.run(endpoint);

function dbStats() {
  let bytes = 0;
  try {
    bytes = fs.statSync(path.join(config.dataDir, 'monitor.db')).size;
  } catch {
    /* ignore */
  }
  return { ...stmts.tableStats.get(), bytes };
}

/** Retencion por antiguedad; se llama una vez por hora. */
function prune() {
  const cutoff = Date.now() - config.stats.retentionDays * 86400000;
  db.prepare('DELETE FROM samples WHERE ts < ?').run(cutoff);
  db.prepare('DELETE FROM host_samples WHERE ts < ?').run(cutoff);
  db.prepare('DELETE FROM domain_checks WHERE ts < ?').run(cutoff);
  db.prepare('DELETE FROM snort_alerts WHERE ts < ?').run(cutoff);
  // Los eventos duran el doble: son pocos y es lo que se consulta a posteriori.
  db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff - config.stats.retentionDays * 86400000);
}

function startPruning() {
  prune();
  const timer = setInterval(prune, 3600000);
  timer.unref();
  return timer;
}

module.exports = {
  db,
  insertSample,
  insertHostSample,
  insertEvent,
  insertDomainCheck,
  insertSnortAlert,
  historyFor,
  hostHistory,
  hostPeaks,
  recentEvents,
  eventsFor,
  eventsSince,
  eventsAfter,
  queryEvents,
  markNotified,
  eventCountsSince,
  eventKindsSince,
  latestDomainChecks,
  domainHistory,
  domainFailuresSince,
  recentSnort,
  snortCountSince,
  snortTopSources,
  snortTopRules,
  upsertPush,
  deletePush,
  listPush,
  countPush,
  pushOk,
  pushFail,
  dbStats,
  prune,
  startPruning,
};
