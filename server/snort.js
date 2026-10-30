const fs = require('fs');
const fsp = require('fs/promises');
const config = require('./config');
const db = require('./db');
const watcher = require('./watcher');

/**
 * Lector de `/var/log/snort/snort.alert.fast`.
 *
 * Formato de cada linea:
 *   09/07-18:30:22.845888  [**] [1:1000003:1] FUERZA BRUTA SSH [**] [Priority: 0] {TCP} 1.2.3.4:62328 -> 100.100.100.100:22
 *
 * El filtro de origen NO es opcional. Las reglas locales alertan ante cualquier
 * SYN al puerto 22 y ante cualquier ping, asi que sin allowlist cada conexion
 * legitima por Tailscale genera una alerta y el canal queda inservible en un dia.
 * El filtro vive aqui, no en Snort, para no perder el registro completo en disco.
 *
 * Las alertas que pasan el filtro se guardan en SQLite y sobreviven a los reinicios.
 */

const LINE_RE =
  /^(\d{2})\/(\d{2})-(\d{2}):(\d{2}):(\d{2})\.\d+\s+\[\*\*\]\s+\[(\d+):(\d+):(\d+)\]\s+(.*?)\s+\[\*\*\]\s+(?:\[Classification:\s*([^\]]*)\]\s*)?\[Priority:\s*(\d+)\]\s+\{(\w+)\}\s+(\S+?)(?::(\d+))?\s+->\s+(\S+?)(?::(\d+))?$/;

function ipToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

function parseCidr(cidr) {
  const [base, bitsRaw] = cidr.split('/');
  const baseInt = ipToInt(base);
  const bits = Number(bitsRaw);
  if (baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (baseInt & mask) >>> 0, mask };
}

const IGNORED_NETS = config.snort.ignoreCidrs.map(parseCidr).filter(Boolean);
const IGNORED_SIDS = new Set(config.snort.ignoreSids.map(String));

function isIgnoredSource(ip) {
  const value = ipToInt(ip);
  if (value === null) return false; // IPv6 u origen raro: no se filtra
  return IGNORED_NETS.some((net) => ((value & net.mask) >>> 0) === net.base);
}

function parseLine(line) {
  const m = LINE_RE.exec(line.trim());
  if (!m) return null;

  const [, month, day, hh, mm, ss, gid, sid, rev, msg, classification, priority, proto, src, srcPort, dst, dstPort] = m;

  // El log no lleva año; se asume el actual y se corrige si cae en el futuro.
  const now = new Date();
  let ts = new Date(now.getFullYear(), Number(month) - 1, Number(day), Number(hh), Number(mm), Number(ss));
  if (ts.getTime() > now.getTime() + 86400000) ts = new Date(ts.setFullYear(now.getFullYear() - 1));

  return {
    ts: ts.getTime(),
    gid, sid, rev,
    msg,
    classification: classification || null,
    priority: Number(priority),
    proto,
    src, srcPort: srcPort ? Number(srcPort) : null,
    dst, dstPort: dstPort ? Number(dstPort) : null,
  };
}

/** Agregacion por ventana: un aviso por (sid, origen), no uno por paquete. */
const buckets = new Map();
const health = {
  following: false,
  file: config.snort.fastLog,
  lastLineAt: null,
  lastReadAt: null,
  parsed: 0,
  ignored: 0,
  unparsed: 0,
};

function bucketKey(alert) {
  return `${alert.sid}:${alert.src}`;
}

function handleAlert(alert) {
  if (IGNORED_SIDS.has(String(alert.sid)) || isIgnoredSource(alert.src)) {
    health.ignored += 1;
    return;
  }

  health.parsed += 1;
  health.lastLineAt = Date.now();
  try {
    db.insertSnortAlert(alert);
  } catch (err) {
    console.error('[snort] no se pudo guardar la alerta:', err.message);
  }

  const key = bucketKey(alert);
  const now = Date.now();
  const windowMs = config.snort.windowMinutes * 60000;

  let bucket = buckets.get(key);
  if (!bucket || now - bucket.first > windowMs) {
    bucket = { first: now, count: 0, alerted: false, sample: alert };
    buckets.set(key, bucket);
  }

  bucket.count += 1;
  bucket.last = now;
  bucket.sample = alert;

  if (bucket.count >= config.snort.minCount && !bucket.alerted) {
    bucket.alerted = true;
    watcher
      .emitExternal({
        ts: now,
        containerId: null,
        name: 'snort',
        kind: 'snort',
        severity: alert.priority <= 1 ? 'crit' : 'warn',
        detail: `${alert.msg} — ${bucket.count} alertas desde ${alert.src} en ${config.snort.windowMinutes} min (sid ${alert.sid})`,
      })
      .catch((err) => console.error('[snort] fallo al notificar:', err.message));
  }
}

function pruneBuckets() {
  const windowMs = config.snort.windowMinutes * 60000;
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.first > windowMs * 2) buckets.delete(key);
  }
}

/** `tail -F` en Node: sigue el archivo y detecta la rotacion diaria por inodo. */
async function follow(filePath, onLine) {
  let position = 0;
  let inode = null;
  let buffer = '';
  // El intervalo dispara cada 5 s sin esperar a la lectura anterior. Si una se
  // alarga (un aluvion de alertas, disco cargado), dos pasadas concurrentes
  // pisan `position` y las mismas lineas se procesan dos veces.
  let reading = false;

  const readNew = async () => {
    if (reading) return;
    reading = true;
    try {
      await readNewOnce();
    } finally {
      reading = false;
    }
  };

  const readNewOnce = async () => {
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      health.following = false;
      return; // el archivo puede desaparecer un instante durante la rotacion
    }
    health.lastReadAt = Date.now();

    if (inode !== null && (stat.ino !== inode || stat.size < position)) {
      // Rotado o truncado: volver al principio del archivo nuevo.
      position = 0;
      buffer = '';
    }
    inode = stat.ino;

    if (stat.size <= position) return;

    // `following` solo se da por bueno cuando el archivo se ha podido ABRIR: un
    // stat correcto no garantiza permiso de lectura.
    let handle;
    try {
      handle = await fsp.open(filePath, 'r');
    } catch (err) {
      health.following = false;
      throw err;
    }
    health.following = true;
    try {
      const length = stat.size - position;
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, position);
      position = stat.size;

      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) onLine(line);
      }
    } finally {
      await handle.close();
    }
  };

  // Arrancar al final: solo interesa lo que pase de ahora en adelante.
  try {
    const stat = await fsp.stat(filePath);
    const probe = await fsp.open(filePath, 'r'); // comprobar permisos, no solo que exista
    await probe.close();
    position = stat.size;
    inode = stat.ino;
    health.following = true;
  } catch (err) {
    health.following = false;
    console.warn(`[snort] no se puede leer ${filePath}: ${err.message}`);
  }

  const timer = setInterval(() => {
    readNew().catch((err) => console.error('[snort] fallo la lectura:', err.message));
  }, 5000);
  timer.unref();
  return timer;
}

async function start() {
  if (!config.snort.enabled) {
    console.log('[snort] desactivado por configuracion');
    return null;
  }

  if (!fs.existsSync(config.snort.fastLog)) {
    console.warn(`[snort] ${config.snort.fastLog} no existe: lector no arrancado`);
    return null;
  }

  console.log(`[snort] siguiendo ${config.snort.fastLog}`);
  const pruner = setInterval(pruneBuckets, 60000);
  pruner.unref();

  return follow(config.snort.fastLog, (line) => {
    const alert = parseLine(line);
    if (alert) handleAlert(alert);
    else health.unparsed += 1;
  });
}

const getRecent = (limit = 50) =>
  db.recentSnort(limit).map((r) => ({
    ts: r.ts, sid: r.sid, msg: r.msg, classification: r.classification, priority: r.priority,
    proto: r.proto, src: r.src, srcPort: r.src_port, dst: r.dst, dstPort: r.dst_port,
  }));

function getSummary(hours = 24) {
  const since = Date.now() - hours * 3600000;
  return {
    hours,
    ...db.snortCountSince(since),
    topSources: db.snortTopSources(since, 10),
    topRules: db.snortTopRules(since, 10),
    ignoredCidrs: config.snort.ignoreCidrs,
    ignoredSids: config.snort.ignoreSids,
  };
}

const getHealth = () => ({ enabled: config.snort.enabled, ...health });

module.exports = { start, parseLine, getRecent, getSummary, getHealth, isIgnoredSource };
