const fs = require('fs/promises');
const os = require('os');
const config = require('./config');

/**
 * Metricas del host, no del contenedor.
 *
 * `/proc/meminfo`, `/proc/stat` y `/proc/loadavg` ya reflejan la maquina real
 * desde dentro del contenedor. El disco se mide sobre `dataDir`, que es un bind
 * mount del host y por tanto vive en el mismo filesystem que `/`.
 *
 * Los umbrales y su estado (en aviso / recuperado) viven en `watcher.js`.
 */

let prevCpu = null;

async function readCpu() {
  const text = await fs.readFile('/proc/stat', 'utf8');
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;

  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (parts[3] || 0) + (parts[4] || 0); // idle + iowait
  const total = parts.reduce((a, b) => a + b, 0);

  const sample = { idle, total };
  if (!prevCpu) {
    prevCpu = sample;
    return null; // la primera pasada solo siembra la referencia
  }

  const idleDelta = idle - prevCpu.idle;
  const totalDelta = total - prevCpu.total;
  prevCpu = sample;

  if (totalDelta <= 0) return null;
  return Math.round(((totalDelta - idleDelta) / totalDelta) * 10000) / 100;
}

async function readMem() {
  const text = await fs.readFile('/proc/meminfo', 'utf8');
  const values = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)\s*kB/);
    if (m) values[m[1]] = Number(m[2]) * 1024;
  }

  const memTotal = values.MemTotal || 0;
  const memAvailable = values.MemAvailable ?? values.MemFree ?? 0;
  const swapTotal = values.SwapTotal || 0;
  const swapFree = values.SwapFree || 0;

  return {
    memTotal,
    memUsed: Math.max(0, memTotal - memAvailable),
    swapTotal,
    swapUsed: Math.max(0, swapTotal - swapFree),
  };
}

async function readLoad() {
  const text = await fs.readFile('/proc/loadavg', 'utf8');
  const parts = text.split(/\s+/);
  return { load1: Number(parts[0]) || 0, load5: Number(parts[1]) || 0, load15: Number(parts[2]) || 0 };
}

async function readDisk() {
  const st = await fs.statfs(config.dataDir);
  const total = st.blocks * st.bsize;
  const free = st.bavail * st.bsize;
  if (!total) return { diskTotal: 0, diskFree: 0, diskPct: 0 };
  return {
    diskTotal: total,
    diskFree: free,
    diskPct: Math.round(((total - free) / total) * 10000) / 100,
  };
}

function cpuCount() {
  try {
    return os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  } catch {
    return 1;
  }
}

async function readUptime() {
  try {
    const text = await fs.readFile('/proc/uptime', 'utf8');
    return Math.floor(Number(text.split(/\s+/)[0]) || 0);
  } catch {
    return null;
  }
}

async function sampleHost() {
  const [cpuPct, mem, load, disk, uptimeSec] = await Promise.all([
    readCpu().catch(() => null),
    readMem().catch(() => ({ memTotal: 0, memUsed: 0, swapTotal: 0, swapUsed: 0 })),
    readLoad().catch(() => ({ load1: 0, load5: 0, load15: 0 })),
    readDisk().catch(() => ({ diskTotal: 0, diskFree: 0, diskPct: 0 })),
    readUptime(),
  ]);

  const memPct = mem.memTotal ? Math.round((mem.memUsed / mem.memTotal) * 10000) / 100 : 0;
  const swapPct = mem.swapTotal ? Math.round((mem.swapUsed / mem.swapTotal) * 10000) / 100 : 0;

  return { cpuPct, cpus: cpuCount(), uptimeSec, ...load, memPct, swapPct, ...mem, ...disk };
}

module.exports = { sampleHost, cpuCount };
