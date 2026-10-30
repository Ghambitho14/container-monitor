const Docker = require('dockerode');

/**
 * En produccion hablamos TCP con `docker-socket-proxy` (solo lectura), no con el
 * socket. `DOCKER_SOCKET` queda como salida para desarrollo local.
 */
function buildDockerClient() {
  const dockerHost = process.env.DOCKER_HOST || '';
  const tcp = dockerHost.match(/^tcp:\/\/([^:/]+)(?::(\d+))?/);
  if (tcp) {
    return new Docker({ host: tcp[1], port: Number(tcp[2] || 2375) });
  }
  return new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
}

const docker = buildDockerClient();

/** Ids y nombres validos de Docker. Nada mas llega a `getContainer()`. */
const CONTAINER_ID_RE = /^[a-zA-Z0-9_.-]{1,64}$/;

function isValidContainerId(value) {
  return typeof value === 'string' && CONTAINER_ID_RE.test(value);
}

/**
 * Docker no expone la salud en el listado; viaja dentro del texto de `Status`,
 * p.ej. "Up 20 hours (healthy)".
 */
function parseHealth(status) {
  const match = String(status || '').match(/\((healthy|unhealthy|health: starting|starting)\)/i);
  if (!match) return null;
  const value = match[1].toLowerCase();
  return value.includes('starting') ? 'starting' : value;
}

function pickName(container) {
  const raw = container.Names?.[0] || container.Name || container.Id;
  return String(raw).replace(/^\//, '');
}

function cleanCoolifyLabel(value) {
  if (!value) return null;
  // quita el sufijo uuid que Coolify anade, tipo -k3j9x2m4p8q1w7e5r6t0yhab
  return String(value)
    .replace(/-[a-z0-9]{20,}$/i, '')
    .replace(/main$/i, '')
    .replace(/[-_]+$/g, '')
    .trim() || value;
}

function resolveApp(name, labels = {}) {
  const composeProject = labels['com.docker.compose.project'] || null;
  const composeService = labels['com.docker.compose.service'] || null;
  const coolifyProject = labels['coolify.projectName'] || null;
  const coolifyResource = labels['coolify.resourceName'] || labels['coolify.name'] || null;
  const coolifyType = labels['coolify.type'] || null;
  const coolifyService = labels['coolify.serviceName'] || labels['coolify.service.subName'] || null;

  if (coolifyResource || coolifyProject) {
    const appLabel =
      cleanCoolifyLabel(coolifyResource) ||
      cleanCoolifyLabel(coolifyService) ||
      coolifyProject ||
      'Coolify app';
    return {
      appKey: `coolify:${coolifyResource || coolifyProject || name}`,
      app: appLabel,
      project: coolifyProject,
      kind: coolifyType || 'application',
      composeProject,
      composeService,
    };
  }

  if (name.startsWith('supabase_') || labels['com.supabase.cli.project']) {
    return {
      appKey: 'stack:supabase',
      app: 'Supabase',
      project: null,
      kind: 'stack',
      composeProject,
      composeService,
    };
  }

  if (
    name.startsWith('coolify') ||
    composeProject === 'source' ||
    (composeProject === 'coolify' && name.includes('coolify'))
  ) {
    return {
      appKey: 'stack:coolify',
      app: 'Coolify',
      project: null,
      kind: 'stack',
      composeProject,
      composeService,
    };
  }

  if (composeProject === 'container-monitor' || name === 'container-monitor') {
    return {
      appKey: 'stack:container-monitor',
      app: 'Container Monitor',
      project: null,
      kind: 'stack',
      composeProject,
      composeService,
    };
  }

  if (composeProject) {
    return {
      appKey: `compose:${composeProject}`,
      app: composeProject,
      project: null,
      kind: 'compose',
      composeProject,
      composeService,
    };
  }

  return {
    appKey: 'other',
    app: 'Otros',
    project: null,
    kind: 'other',
    composeProject,
    composeService,
  };
}

function shortDisplayName(name, appInfo, labels = {}) {
  if (appInfo.kind === 'stack' && appInfo.app === 'Supabase') {
    return name.replace(/^supabase_/, '').replace(/_root$/, '').replace(/_/g, '-');
  }
  if (appInfo.kind === 'stack' && appInfo.app === 'Coolify') {
    return name.replace(/^coolify-?/, '') || name;
  }
  const service =
    labels['coolify.service.subName'] ||
    labels['coolify.serviceName'] ||
    appInfo.composeService;
  if (service && service !== name) {
    const cleaned = cleanCoolifyLabel(service);
    if (cleaned && cleaned.length < name.length) return cleaned;
  }
  return cleanCoolifyLabel(labels['coolify.resourceName']) || name;
}

async function listContainers() {
  const containers = await docker.listContainers({ all: true });
  return containers
    .map((c) => {
      const labels = c.Labels || {};
      const name = pickName(c);
      const appInfo = resolveApp(name, labels);
      return {
        id: c.Id,
        shortId: c.Id.slice(0, 12),
        name,
        image: c.Image,
        state: c.State,
        status: c.Status,
        health: parseHealth(c.Status),
        created: c.Created,
        ports: (c.Ports || []).map((p) => ({
          private: p.PrivatePort,
          public: p.PublicPort || null,
          type: p.Type,
        })),
        coolifyManaged: labels['coolify.managed'] === 'true',
        environment: labels['coolify.environmentName'] || null,
        type: appInfo.kind,
        serviceName: labels['coolify.serviceName'] || labels['coolify.service.subName'] || appInfo.composeService,
        resourceName: labels['coolify.resourceName'] || labels['coolify.name'] || null,
        project: appInfo.project,
        appKey: appInfo.appKey,
        app: appInfo.app,
        composeProject: appInfo.composeProject,
        composeService: appInfo.composeService,
        displayName: shortDisplayName(name, appInfo, labels),
      };
    })
    .sort((a, b) => {
      const appCmp = a.app.localeCompare(b.app);
      if (appCmp !== 0) return appCmp;
      if (a.state === 'running' && b.state !== 'running') return -1;
      if (a.state !== 'running' && b.state === 'running') return 1;
      return a.displayName.localeCompare(b.displayName);
    });
}

function streamLogs(containerId, { tail = 200, follow = true } = {}) {
  const container = docker.getContainer(containerId);
  return container.logs({
    follow,
    stdout: true,
    stderr: true,
    tail,
    timestamps: true,
  });
}

/** Sin TTY, Docker multiplexa stdout/stderr con una cabecera de 8 bytes por bloque. */
function demuxDockerLogs(buffer, onChunk) {
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) break;
    const streamType = buffer[offset];
    const text = buffer.slice(start, end).toString('utf8');
    onChunk({ stream: streamType === 2 ? 'stderr' : 'stdout', text });
    offset = end;
  }
  return buffer.slice(offset);
}

/**
 * Logs ya escritos (sin `follow`) como lineas de texto, sin marcar stdout/stderr.
 * `since` en segundos unix. Lo usa la Oficina para contar errores desde su ultima revision.
 */
async function readLogs(containerId, { since = 0, tail = 200 } = {}) {
  const container = docker.getContainer(containerId);
  const info = await container.inspect();
  const raw = await container.logs({ follow: false, stdout: true, stderr: true, since, tail });
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  let text = '';
  if (info.Config?.Tty) text = buf.toString('utf8');
  else demuxDockerLogs(buf, (chunk) => { text += chunk.text; });
  return text.split('\n').filter((line) => line.trim());
}

/** Solo los campos que el listado no trae: reinicios, salud real, OOM y limite. */
async function inspectSummary(containerId) {
  const info = await docker.getContainer(containerId).inspect();
  return {
    restartCount: info.RestartCount ?? 0,
    health: info.State?.Health?.Status || null,
    startedAt: info.State?.StartedAt || null,
    finishedAt: info.State?.FinishedAt || null,
    exitCode: info.State?.ExitCode ?? null,
    oomKilled: Boolean(info.State?.OOMKilled),
    restartPolicy: info.HostConfig?.RestartPolicy?.Name || null,
    memLimit: info.HostConfig?.Memory || 0,
    healthLog: (info.State?.Health?.Log || []).slice(-3).map((l) => ({
      start: l.Start,
      exitCode: l.ExitCode,
      output: String(l.Output || '').slice(0, 500),
    })),
  };
}

/**
 * Una sola muestra de `stats` (sin stream). El porcentaje de CPU sale de la
 * delta contra `precpu_stats`, que la respuesta one-shot ya incluye.
 */
async function sampleStats(containerId) {
  const raw = await docker.getContainer(containerId).stats({ stream: false });

  const cpuDelta =
    (raw.cpu_stats?.cpu_usage?.total_usage ?? 0) - (raw.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta =
    (raw.cpu_stats?.system_cpu_usage ?? 0) - (raw.precpu_stats?.system_cpu_usage ?? 0);
  const cpuCount =
    raw.cpu_stats?.online_cpus || raw.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;

  let cpuPct = 0;
  if (cpuDelta > 0 && systemDelta > 0) {
    cpuPct = (cpuDelta / systemDelta) * cpuCount * 100;
  }

  // `cache` cuenta como memoria del contenedor pero no es presion real.
  const memUsage = raw.memory_stats?.usage ?? 0;
  const memCache = raw.memory_stats?.stats?.inactive_file ?? raw.memory_stats?.stats?.cache ?? 0;

  let netRx = 0;
  let netTx = 0;
  for (const iface of Object.values(raw.networks || {})) {
    netRx += iface.rx_bytes ?? 0;
    netTx += iface.tx_bytes ?? 0;
  }

  let blkRead = 0;
  let blkWrite = 0;
  for (const entry of raw.blkio_stats?.io_service_bytes_recursive || []) {
    if (/read/i.test(entry.op)) blkRead += entry.value ?? 0;
    if (/write/i.test(entry.op)) blkWrite += entry.value ?? 0;
  }

  return {
    cpuPct: Math.round(cpuPct * 100) / 100,
    memBytes: Math.max(0, memUsage - memCache),
    memLimit: raw.memory_stats?.limit ?? 0,
    netRx,
    netTx,
    blkRead,
    blkWrite,
    pids: raw.pids_stats?.current ?? null,
  };
}

/** `docker info` resumido, cacheado: el nombre del host y poco mas. */
let infoCache = { at: 0, value: null };
async function getInfo() {
  if (infoCache.value && Date.now() - infoCache.at < 300000) return infoCache.value;
  const info = await docker.info();
  infoCache = {
    at: Date.now(),
    value: {
      name: info.Name || null,
      cpus: info.NCPU || null,
      memTotal: info.MemTotal || null,
      serverVersion: info.ServerVersion || null,
      containers: info.Containers ?? null,
      running: info.ContainersRunning ?? null,
      images: info.Images ?? null,
    },
  };
  return infoCache.value;
}

module.exports = {
  docker,
  listContainers,
  streamLogs,
  readLogs,
  demuxDockerLogs,
  inspectSummary,
  sampleStats,
  getInfo,
  isValidContainerId,
  parseHealth,
};
