const config = require('./config');

/**
 * Canal Telegram.
 *
 * `send` manda un mensaje en HTML con tres intentos (timeout de 10 s cada uno)
 * y respeta el `retry_after` de un 429; un 4xx distinto no se reintenta porque
 * es token o chat mal puestos. Devuelve true/false: el watcher lo usa para
 * corregir `notified` en el historial si ningun canal entrego el aviso.
 *
 * Tambien vive aqui la etiqueta de texto de cada tipo de evento, que push.js
 * reutiliza para que ambos canales se parezcan.
 */
const API = 'https://api.telegram.org';
const enabled = Boolean(config.telegram.token && config.telegram.chatId);

if (!enabled) {
  console.warn('[notify] sin TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID: los avisos quedan solo en el historial');
}

const health = { sent: 0, failed: 0, lastOkAt: null, lastError: null };

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Envia a Telegram. Si no hay credenciales es un no-op silencioso: la app tiene
 * que arrancar y funcionar igual sin ellas.
 */
async function send(text, { silent = false } = {}) {
  if (!enabled) return false;

  const body = {
    chat_id: config.telegram.chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    disable_notification: silent,
  };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(`${API}/bot${config.telegram.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        health.sent += 1;
        health.lastOkAt = Date.now();
        health.lastError = null;
        return true;
      }

      // 429: Telegram dice cuanto esperar.
      if (res.status === 429) {
        const payload = await res.json().catch(() => ({}));
        const wait = (payload.parameters?.retry_after ?? 5) * 1000;
        await sleep(wait);
        continue;
      }

      const detail = await res.text().catch(() => '');
      console.error(`[notify] telegram ${res.status}: ${detail.slice(0, 300)}`);
      health.lastError = `HTTP ${res.status}`;
      if (res.status >= 400 && res.status < 500) {
        health.failed += 1;
        return false; // token o chat_id mal: no reintentar
      }
    } catch (err) {
      console.error(`[notify] intento ${attempt} fallo:`, err.message);
      health.lastError = err.message;
    }

    if (attempt < 3) await sleep(attempt * 2000);
  }

  health.failed += 1;
  return false;
}

const LABELS = {
  down: '[CAÍDO]',
  up: '[RECUPERADO]',
  restart: '[REINICIO]',
  loop: '[BUCLE]',
  unhealthy: '[SIN SALUD]',
  gone: '[DESAPARECIDO]',
  new: '[NUEVO]',
  pause: '[PAUSA]',
  host: '[HOST]',
  mem: '[MEMORIA]',
  snort: '[SNORT]',
  domain: '[DOMINIO]',
  cert: '[CERTIFICADO]',
  monitor: '[MONITOR]',
  summary: '[RESUMEN]',
  ok: '[OK]',
  other: '[AVISO]',
};

function labelFor(kind) {
  if (kind === 'container_down') return LABELS.down;
  if (kind === 'container_up') return LABELS.up;
  if (kind === 'container_restarted') return LABELS.restart;
  if (kind === 'container_restart_loop') return LABELS.loop;
  if (kind === 'container_oom') return LABELS.mem;
  if (kind === 'container_mem') return LABELS.mem;
  if (kind === 'container_unhealthy') return LABELS.unhealthy;
  if (kind === 'container_healthy') return LABELS.up;
  if (kind === 'container_gone') return LABELS.gone;
  if (kind === 'container_new') return LABELS.new;
  if (kind === 'container_paused' || kind === 'container_unpaused') return LABELS.pause;
  if (kind === 'snort') return LABELS.snort;
  if (kind === 'domain_down') return LABELS.domain;
  if (kind === 'domain_up') return LABELS.ok;
  if (kind === 'cert_expiring') return LABELS.cert;
  if (kind.startsWith('monitor_')) return LABELS.monitor;
  if (kind.endsWith('_ok')) return LABELS.ok;
  if (kind.startsWith('host_')) return LABELS.host;
  return LABELS.other;
}

function formatEvent(event) {
  const label = labelFor(event.kind);
  const title = event.name ? `<b>${escapeHtml(event.name)}</b>` : '<b>host</b>';
  const detail = event.detail ? `\n${escapeHtml(event.detail)}` : '';
  return `${label} ${title}${detail}`;
}

/** Un solo mensaje cuando cambian muchas cosas a la vez (reinicio de stack). */
function formatSummary(events) {
  const lines = events
    .slice(0, 20)
    .map((e) => `${labelFor(e.kind)} ${escapeHtml(e.name || 'host')} — ${escapeHtml(e.detail || e.kind)}`);
  const extra = events.length > 20 ? `\n… y ${events.length - 20} mas` : '';
  return `${LABELS.summary} <b>${events.length} cambios a la vez</b>\n\n${lines.join('\n')}${extra}`;
}

/**
 * Mensaje de prueba de la pestaña Ajustes. Usa las credenciales que se le pasan
 * (las recien escritas o las guardadas, aunque aun no esten en uso), un solo
 * intento y sin tocar los contadores: devuelve el motivo si Telegram lo rechaza.
 */
async function sendTest(token, chatId) {
  if (!token || !chatId) return { ok: false, error: 'faltan el token o el chat ID' };
  try {
    const res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '<b>Prueba del monitor</b>\nSi lees esto, los avisos llegan a este chat.',
        parse_mode: 'HTML',
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return { ok: true };
    const payload = await res.json().catch(() => ({}));
    return { ok: false, error: `Telegram ${res.status}: ${String(payload.description || '').slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const getHealth = () => ({ enabled, ...health });

module.exports = { send, sendTest, formatEvent, formatSummary, escapeHtml, labelFor, enabled, getHealth, LABELS };
