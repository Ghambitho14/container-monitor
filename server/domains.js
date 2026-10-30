const https = require('https');
const config = require('./config');
const db = require('./db');
const watcher = require('./watcher');
const { docker } = require('./docker');

const VERSION = require('../package.json').version;

/**
 * Sonda HTTPS de los dominios servidos por Traefik.
 *
 * Los dominios se descubren de las labels `Host(...)` de los contenedores, no
 * se escriben a mano: asi un proyecto nuevo en Coolify entra en la sonda solo.
 *
 * Los avisos son por estado, no por sonda: `domain_down` una vez al caer (tras
 * confirmar con una segunda sonda) y `domain_up` una vez al volver, con el
 * tiempo que estuvo caido. El de certificado sale como mucho una vez al dia.
 */

const HOST_RE = /Host\(`([^`]+)`\)/g;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Un objetivo de `DOMAIN_EXTRA` es `host` o `host/ruta`.
 *
 * La ruta hace falta cuando la raiz no refleja la salud del servicio: un gateway
 * como Kong responde 404 en `/` con todo sano. Una ruta que dependa del backend
 * (p. ej. `/auth/v1/.well-known/jwks.json` en Supabase) atraviesa el stack entero.
 */
function parseTarget(entry) {
  const value = String(entry).trim();
  const slash = value.indexOf('/');
  if (slash === -1) return { host: value, path: '/' };
  return { host: value.slice(0, slash), path: value.slice(slash) || '/' };
}

async function discoverDomains() {
  const containers = await docker.listContainers({ all: false });

  // Lo configurado a mano manda: si un host ya trae ruta propia, el descubierto
  // por labels no debe pisarla con `/`.
  const byHost = new Map();
  for (const entry of config.domains.extra) {
    const target = parseTarget(entry);
    if (target.host) byHost.set(target.host, target);
  }

  for (const c of containers) {
    for (const value of Object.values(c.Labels || {})) {
      if (typeof value !== 'string' || !value.includes('Host(')) continue;
      for (const match of value.matchAll(HOST_RE)) {
        const host = match[1].trim();
        // Los hostnames sslip.io son internos de Coolify, no dominios reales.
        if (host && !host.endsWith('.sslip.io') && !byHost.has(host)) {
          byHost.set(host, { host, path: '/' });
        }
      }
    }
  }

  return [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host));
}

/**
 * Agente propio, sin reutilizacion de conexion ni cache de sesiones TLS.
 *
 * Con keep-alive (el agente global lo usa desde Node 19) la sesion TLS se reanuda
 * y `getPeerCertificate()` devuelve un objeto vacio. Un handshake completo es la
 * unica forma de leer los dias que le quedan al certificado.
 */
const agent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });

function certDaysFrom(socket) {
  try {
    const cert = socket?.getPeerCertificate?.();
    if (!cert || !cert.valid_to) return null;
    const expiry = new Date(cert.valid_to).getTime();
    if (!Number.isFinite(expiry)) return null;
    return Math.floor((expiry - Date.now()) / 86400000);
  } catch {
    return null;
  }
}

function probe(target) {
  const { host, path } = typeof target === 'string' ? parseTarget(target) : target;

  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    // Se lee en el handshake, no en la respuesta: para entonces el socket puede
    // haberse reciclado y el certificado ya no esta disponible.
    let certDays = null;

    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve({ domain: host, path, latencyMs: Date.now() - started, ...result });
    };

    const req = https.request(
      {
        host,
        servername: host,
        port: 443,
        path,
        method: 'GET',
        timeout: 15000,
        agent,
        headers: { 'user-agent': `container-monitor/${VERSION}` },
      },
      (res) => {
        if (certDays === null) certDays = certDaysFrom(res.socket);
        res.resume(); // descartar el cuerpo, solo interesan cabeceras y certificado
        done({ ok: res.statusCode < 400, status: res.statusCode, certDays, error: null });
      },
    );

    req.on('socket', (socket) => {
      socket.on('secureConnect', () => {
        certDays = certDaysFrom(socket);
      });
    });

    req.on('timeout', () => {
      req.destroy();
      done({ ok: false, status: null, certDays: null, error: 'timeout' });
    });

    req.on('error', (err) => {
      done({ ok: false, status: null, certDays: null, error: err.message });
    });

    req.end();
  });
}

/** Un fallo se confirma con otra sonda: un 502 de segundos en un deploy no cuenta. */
async function probeConfirmed(target) {
  let check = await probe(target);
  for (let i = 0; i < config.domains.confirmRetries && !check.ok; i += 1) {
    await sleep(config.domains.confirmDelayMs);
    const again = await probe(target);
    check = { ...again, confirmed: true, attempts: i + 2 };
  }
  return check;
}

function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

let latest = [];
const state = new Map(); // host -> { down, downSince, certWarnedAt }
const health = { lastRunAt: null, lastOkAt: null, running: false };

async function tick() {
  health.lastRunAt = Date.now();
  if (health.running) return;
  health.running = true;
  try {
    const domains = await discoverDomains();
    if (!domains.length) return;

    const ts = Date.now();
    const checks = await Promise.all(domains.map(probeConfirmed));
    latest = checks;
    health.lastOkAt = Date.now();

    for (const check of checks) {
      db.insertDomainCheck(ts, check);
      const st = state.get(check.domain) || { down: false, downSince: null, certWarnedAt: null };

      if (!check.ok) {
        if (!st.down) {
          st.down = true;
          st.downSince = ts;
          await watcher.emitExternal({
            ts, containerId: null, name: check.domain, kind: 'domain_down', severity: 'crit',
            detail: (check.error ? `No responde: ${check.error}` : `Responde HTTP ${check.status}`) +
              (check.confirmed ? ' (confirmado con segunda sonda)' : ''),
          });
        }
        state.set(check.domain, st);
        continue;
      }

      if (st.down) {
        const downFor = st.downSince ? fmtDuration(ts - st.downSince) : 'un rato';
        st.down = false;
        st.downSince = null;
        await watcher.emitExternal({
          ts, containerId: null, name: check.domain, kind: 'domain_up', severity: 'info',
          detail: `Vuelve a responder (HTTP ${check.status}) tras ${downFor} caido`,
        });
      }

      // El certificado se avisa una vez al dia por dominio, no en cada sonda.
      if (
        check.certDays !== null &&
        check.certDays <= config.domains.certWarnDays &&
        (!st.certWarnedAt || ts - st.certWarnedAt >= 86400000)
      ) {
        st.certWarnedAt = ts;
        await watcher.emitExternal({
          ts, containerId: null, name: check.domain, kind: 'cert_expiring',
          severity: check.certDays <= 3 ? 'crit' : 'warn',
          detail: `El certificado caduca en ${check.certDays} dias`,
        });
      }
      state.set(check.domain, st);
    }
  } finally {
    health.running = false;
  }
}

function start() {
  tick().catch((err) => console.error('[domains] primera sonda fallo:', err.message));
  const timer = setInterval(() => {
    tick().catch((err) => console.error('[domains] fallo la sonda:', err.message));
  }, config.domains.intervalMs);
  timer.unref();
  return timer;
}

const getLatest = () => latest;
const getState = () =>
  [...state].map(([domain, st]) => ({ domain, down: st.down, downSince: st.downSince }));
const getHealth = () => ({ ...health, domains: latest.length, down: getState().filter((d) => d.down).length });

module.exports = { start, tick, discoverDomains, probe, getLatest, getState, getHealth };
