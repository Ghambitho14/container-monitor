const config = require('./config');
const db = require('./db');
const notify = require('./notify');
const watcher = require('./watcher');
const domains = require('./domains');
const snort = require('./snort');
const push = require('./push');
const { getInfo } = require('./docker');

/**
 * Resumen diario por Telegram, sin sonido.
 *
 * Hace dos cosas: cuenta que paso en las ultimas 24 h aunque no hubiera ningun
 * aviso, y sirve de latido. Si un dia no llega, el monitor esta caido, que es
 * justo el fallo del que un monitor no puede avisar.
 */

const { escapeHtml: esc } = notify;
const health = { lastSentAt: null, nextAt: null, failures: 0 };

function fmtBytes(bytes) {
  if (!bytes && bytes !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)}%`);

function fmtUptime(sec) {
  if (!sec) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return d ? `${d} d ${h} h` : `${h} h`;
}

async function build() {
  const now = Date.now();
  const since = now - 86400000;

  const containers = watcher.getSnapshot();
  const running = containers.filter((c) => c.state === 'running').length;
  const down = containers.filter((c) => c.state !== 'running');
  const unhealthy = containers.filter((c) => c.state === 'running' && c.health === 'unhealthy');

  const kinds = db.eventKindsSince(since);
  const restarts = kinds.filter((k) => k.kind === 'container_restarted');
  const counts = Object.fromEntries(db.eventCountsSince(since).map((r) => [r.severity, r]));
  const crit = counts.crit?.n || 0;
  const warn = counts.warn?.n || 0;
  const info = counts.info?.n || 0;

  const host = watcher.getHost();
  const peaks = db.hostPeaks(since) || {};
  const hostAlerts = watcher.getHostAlerts();

  const domainRows = db.latestDomainChecks();
  const domainsOk = domainRows.filter((d) => d.ok).length;
  const domainsDown = domainRows.filter((d) => !d.ok).map((d) => d.domain);
  const certs = domainRows.filter((d) => d.cert_days !== null).sort((a, b) => a.cert_days - b.cert_days);
  const domainFailures = db.domainFailuresSince(since);

  const snortSummary = snort.getSummary(24);
  const dbs = db.dbStats();
  const pushHealth = push.getHealth();

  let name = 'host';
  try {
    name = (await getInfo()).name || name;
  } catch {
    /* sin info no pasa nada */
  }

  const lines = [];
  lines.push(`<b>Resumen diario — ${esc(name)}</b>`);
  lines.push('');

  let cLine = `Contenedores: ${running}/${containers.length} corriendo`;
  if (down.length) cLine += ` · parados: ${esc(down.map((c) => c.displayName).join(', '))}`;
  if (unhealthy.length) cLine += ` · unhealthy: ${esc(unhealthy.map((c) => c.displayName).join(', '))}`;
  lines.push(cLine);

  if (restarts.length) {
    lines.push(
      `Reinicios (24 h): ${esc(restarts.slice(0, 6).map((r) => `${r.name} ×${r.n}`).join(', '))}` +
        (restarts.length > 6 ? ` y ${restarts.length - 6} mas` : ''),
    );
  } else {
    lines.push('Reinicios (24 h): ninguno');
  }

  lines.push(`Eventos (24 h): ${crit} crit · ${warn} warn · ${info} info`);

  if (host) {
    lines.push(
      `Host ahora: CPU ${pct(host.cpuPct)} · RAM ${pct(host.memPct)} · Swap ${pct(host.swapPct)} · Disco ${pct(host.diskPct)} (${fmtBytes(host.diskFree)} libres)`,
    );
    lines.push(
      `Picos 24 h: CPU ${pct(peaks.cpu_pct)} (media ${pct(peaks.cpu_avg)}) · RAM ${pct(peaks.mem_pct)} · Swap ${pct(peaks.swap_pct)} · carga ${peaks.load1 ? peaks.load1.toFixed(2) : '—'}`,
    );
    if (host.uptimeSec) lines.push(`Uptime del host: ${fmtUptime(host.uptimeSec)}`);
  }
  if (hostAlerts.length) lines.push(`Umbrales superados ahora: ${esc(hostAlerts.join(', '))}`);

  let dLine = `Dominios: ${domainsOk}/${domainRows.length} OK`;
  if (domainsDown.length) dLine += ` · caidos: ${esc(domainsDown.join(', '))}`;
  if (domainFailures.length) {
    dLine += ` · fallos 24 h: ${esc(domainFailures.map((d) => `${d.domain} ×${d.n}`).join(', '))}`;
  }
  lines.push(dLine);
  if (certs.length) {
    lines.push(`Certificado mas proximo: ${esc(certs[0].domain)} en ${certs[0].cert_days} dias`);
  }

  let sLine = `Snort (24 h): ${snortSummary.n || 0} alertas de ${snortSummary.sources || 0} origenes`;
  if (snortSummary.topSources?.length) {
    sLine += ` · top ${esc(snortSummary.topSources.slice(0, 3).map((s) => `${s.src} ×${s.n}`).join(', '))}`;
  }
  lines.push(sLine);

  lines.push('');
  lines.push(
    `<i>Monitor: base ${fmtBytes(dbs.bytes)} · ${Math.round(dbs.samples / 1000)}k muestras · ` +
      `push a ${pushHealth.subscribers} dispositivo${pushHealth.subscribers === 1 ? '' : 's'}</i>`,
  );

  return lines.join('\n');
}

function msUntilNext(hour) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

let timer = null;

function schedule() {
  const wait = msUntilNext(config.digest.hour);
  health.nextAt = Date.now() + wait;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      const ok = await notify.send(await build(), { silent: true });
      if (ok) health.lastSentAt = Date.now();
      else health.failures += 1;
    } catch (err) {
      health.failures += 1;
      console.error('[digest] fallo el resumen diario:', err.message);
    }
    schedule();
  }, wait);
  timer.unref();
}

function start() {
  if (!config.digest.enabled) {
    console.log('[digest] desactivado por configuracion');
    return;
  }
  if (!notify.enabled) {
    console.log('[digest] sin Telegram: el resumen diario no se envia');
    return;
  }
  schedule();
  console.log(`[digest] resumen diario a las ${String(config.digest.hour).padStart(2, '0')}:00 (hora del contenedor)`);
}

const getHealth = () => ({ enabled: config.digest.enabled && notify.enabled, hour: config.digest.hour, ...health });

module.exports = { start, build, getHealth };
