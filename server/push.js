const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');
const config = require('./config');
const db = require('./db');
const notify = require('./notify');

/**
 * Web Push para la PWA instalada en el movil.
 *
 * El navegador se suscribe una vez (POST /api/push/subscribe) y a partir de ahi
 * los avisos llegan aunque la app este cerrada y el telefono fuera de la
 * tailnet: el servidor habla con el servicio de push de Google/Apple/Mozilla,
 * no con el movil. El contenido va cifrado extremo a extremo (RFC 8291).
 *
 * Las claves VAPID identifican a ESTE servidor ante esos servicios. Se generan
 * una vez y viven en `data/vapid.json`: si cambian, todas las suscripciones
 * dejan de valer y hay que volver a activar las alertas en cada dispositivo.
 */

const SEVERITY = { info: 0, warn: 1, crit: 2 };
const KEYS_FILE = path.join(config.dataDir, 'vapid.json');

let keys = null;
const enabled = config.push.enabled;
const health = { sent: 0, failed: 0, dropped: 0, lastOkAt: null, lastError: null };

function loadKeys() {
  try {
    const parsed = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    if (parsed.publicKey && parsed.privateKey) return parsed;
  } catch {
    /* no existe todavia */
  }
  const generated = webpush.generateVAPIDKeys();
  fs.writeFileSync(KEYS_FILE, JSON.stringify(generated), { mode: 0o600 });
  console.log(`[push] claves VAPID nuevas guardadas en ${KEYS_FILE}`);
  return generated;
}

if (enabled) {
  keys = loadKeys();
  webpush.setVapidDetails(config.push.subject, keys.publicKey, keys.privateKey);
} else {
  console.log('[push] desactivado por configuracion');
}

const publicKey = () => keys?.publicKey || null;
const hasSubscribers = () => enabled && db.countPush() > 0;

function isValidSubscription(sub) {
  if (!sub || typeof sub !== 'object') return false;
  if (typeof sub.endpoint !== 'string' || !/^https:\/\/[^\s]{10,2000}$/.test(sub.endpoint)) return false;
  const k = sub.keys;
  if (!k || typeof k.p256dh !== 'string' || typeof k.auth !== 'string') return false;
  if (k.p256dh.length > 200 || k.auth.length > 100) return false;
  return true;
}

function subscribe(sub, userAgent) {
  if (!enabled) throw new Error('push desactivado');
  if (!isValidSubscription(sub)) throw new Error('suscripcion invalida');
  db.upsertPush({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, String(userAgent || '').slice(0, 300));
  return true;
}

function unsubscribe(endpoint) {
  if (typeof endpoint !== 'string') return false;
  db.deletePush(endpoint);
  return true;
}

/** `Topic` colapsa avisos repetidos del mismo objeto en el servicio de push. */
function topicFor(tag) {
  return crypto.createHash('sha1').update(String(tag || 'x')).digest('base64url').slice(0, 32);
}

async function sendTo(sub, payload, { ttl = 3600, urgency = 'high' } = {}) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      JSON.stringify(payload),
      { TTL: ttl, urgency, topic: topicFor(payload.tag) },
    );
    db.pushOk(sub.endpoint);
    health.sent += 1;
    health.lastOkAt = Date.now();
    health.lastError = null;
    return true;
  } catch (err) {
    const status = err.statusCode;
    if (status === 404 || status === 410) {
      // El navegador revoco la suscripcion (app desinstalada, permiso quitado).
      db.deletePush(sub.endpoint);
      health.dropped += 1;
      console.warn(`[push] suscripcion caducada (${status}), eliminada`);
    } else {
      db.pushFail(sub.endpoint);
      health.failed += 1;
      health.lastError = `${status || ''} ${err.body || err.message}`.trim().slice(0, 200);
      console.error('[push] fallo al enviar:', health.lastError);
    }
    return false;
  }
}

/** Manda a todos los dispositivos. Devuelve cuantos envios salieron bien. */
async function broadcast(payload, { force = false } = {}) {
  if (!enabled || !payload) return 0;
  if (!force) {
    const min = SEVERITY[config.push.minSeverity] ?? SEVERITY.warn;
    if ((SEVERITY[payload.severity] ?? SEVERITY.crit) < min) return 0;
  }
  const subs = db.listPush();
  if (!subs.length) return 0;

  const urgency = payload.severity === 'crit' ? 'high' : 'normal';
  const results = await Promise.all(subs.map((sub) => sendTo(sub, payload, { urgency })));
  return results.filter(Boolean).length;
}

async function sendTest(endpoint) {
  const sub = db.listPush().find((s) => s.endpoint === endpoint);
  if (!sub) throw new Error('suscripcion desconocida');
  return sendTo(sub, {
    title: 'Alertas activadas',
    body: 'Este dispositivo recibira los avisos del monitor.',
    tag: 'test',
    severity: 'info',
    url: '/',
    ts: Date.now(),
  });
}

function fromEvent(event) {
  return {
    title: `${notify.labelFor(event.kind)} ${event.name || 'host'}`,
    body: event.detail || event.kind,
    tag: `${event.containerId || event.name || 'host'}:${event.kind}`,
    severity: event.severity,
    kind: event.kind,
    url: event.containerId ? `/#container=${event.containerId}` : '/#events',
    ts: event.ts,
  };
}

function fromSummary(events) {
  const worst = events.reduce(
    (acc, e) => ((SEVERITY[e.severity] ?? 0) > (SEVERITY[acc] ?? 0) ? e.severity : acc),
    'info',
  );
  const lines = events.slice(0, 6).map((e) => `${e.name || 'host'}: ${e.detail || e.kind}`);
  const extra = events.length > 6 ? `\n… y ${events.length - 6} mas` : '';
  return {
    title: `${notify.LABELS.summary} ${events.length} cambios a la vez`,
    body: lines.join('\n') + extra,
    tag: 'summary',
    severity: worst,
    kind: 'summary',
    url: '/#events',
    ts: Date.now(),
  };
}

const getHealth = () => ({ enabled, subscribers: enabled ? db.countPush() : 0, ...health });

module.exports = {
  enabled,
  publicKey,
  hasSubscribers,
  subscribe,
  unsubscribe,
  broadcast,
  sendTest,
  fromEvent,
  fromSummary,
  getHealth,
};
