const fs = require('fs');
const path = require('path');

/**
 * Catalogo unico de ajustes del monitor.
 *
 * Cada ajuste se define una sola vez aqui: variable de entorno, valor por
 * defecto, limites, texto para el panel y si se aplica en caliente o pide
 * reiniciar. `config.js` construye el objeto `config` a partir de esta tabla.
 *
 * Precedencia: valor por defecto → `.env` → `data/settings.json` (lo que se
 * guarda desde la pestaña Ajustes). El `.env` nunca se escribe: borrar
 * `settings.json` devuelve todo a lo que diga el `.env`.
 *
 * `apply: 'live'` son los valores que los modulos leen en cada uso; basta con
 * cambiarlos en el objeto `config`. `apply: 'restart'` son los que se capturan
 * al arrancar (intervalos, credenciales, filtros precalculados): se guardan,
 * pero el proceso sigue con el valor viejo hasta reiniciar.
 */

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const FILE = path.join(DATA_DIR, 'settings.json');

const GROUPS = [
  ['telegram', 'Telegram'],
  ['alerts', 'Avisos'],
  ['host', 'Servidor'],
  ['containers', 'Contenedores'],
  ['domains', 'Dominios'],
  ['snort', 'Snort'],
  ['digest', 'Resumen diario'],
  ['push', 'Push al móvil'],
  ['polling', 'Sondeo'],
  ['history', 'Histórico'],
  ['ws', 'Logs en vivo'],
];

const HOST_PATH_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/[\w.~%!$&'()*+,;=:@/-]*)?$/i;
const CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

function validCidr(value) {
  const m = CIDR_RE.exec(value);
  if (!m) return false;
  return m.slice(1, 5).every((n) => Number(n) <= 255) && Number(m[5]) <= 32;
}

const SCHEMA = [
  {
    key: 'telegram.token', env: 'TELEGRAM_BOT_TOKEN', def: '', type: 'secret', group: 'telegram', apply: 'restart',
    label: 'Token del bot', help: 'Lo da @BotFather. Nunca se muestra: escribe uno nuevo solo para reemplazarlo.',
    pattern: /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/, patternHelp: 'formato 123456:ABC…',
  },
  {
    key: 'telegram.chatId', env: 'TELEGRAM_CHAT_ID', def: '', type: 'string', group: 'telegram', apply: 'restart',
    label: 'Chat ID', help: 'Chat o grupo que recibe los avisos (los grupos empiezan por -).',
    pattern: /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/, patternHelp: 'un número (p. ej. -100123…) o @canal',
  },

  {
    key: 'watch.dedupeMinutes', env: 'ALERT_DEDUPE_MINUTES', def: 15, type: 'int', min: 1, max: 1440, unit: 'min',
    group: 'alerts', apply: 'live', label: 'No repetir el mismo aviso durante',
    help: 'Mismo objeto y mismo tipo de aviso dentro de esta ventana: se guarda en el historial pero no se envía.',
  },
  {
    key: 'watch.groupThreshold', env: 'ALERT_GROUP_THRESHOLD', def: 4, type: 'int', min: 2, max: 50,
    group: 'alerts', apply: 'live', label: 'Agrupar a partir de',
    help: 'Si cambian tantas cosas a la vez (un reinicio de stack), llega un único mensaje resumen.',
  },
  {
    key: 'monitor.dockerFailures', env: 'ALERT_DOCKER_FAILURES', def: 3, type: 'int', min: 1, max: 20,
    group: 'alerts', apply: 'live', label: 'Fallos con Docker antes de avisar',
    help: 'Intentos seguidos sin respuesta de Docker antes del aviso «Docker no responde».',
  },

  {
    key: 'thresholds.diskPct', env: 'ALERT_DISK_PCT', def: 85, type: 'int', min: 50, max: 99, unit: '%',
    group: 'host', apply: 'live', label: 'Disco', help: 'Aviso crítico al superar este uso de disco.',
  },
  {
    key: 'thresholds.memPct', env: 'ALERT_MEM_PCT', def: 90, type: 'int', min: 50, max: 99, unit: '%',
    group: 'host', apply: 'live', label: 'RAM', help: 'Uso de memoria del servidor.',
  },
  {
    key: 'thresholds.swapPct', env: 'ALERT_SWAP_PCT', def: 85, type: 'int', min: 10, max: 100, unit: '%',
    group: 'host', apply: 'live', label: 'Swap', help: 'Si el servidor usa swap de forma habitual, deja margen sobre su nivel en reposo.',
  },
  {
    key: 'thresholds.cpuPct', env: 'ALERT_CPU_PCT', def: 90, type: 'int', min: 50, max: 100, unit: '%',
    group: 'host', apply: 'live', label: 'CPU (media sostenida)', help: 'Se evalúa como media del periodo de abajo, no por pico.',
  },
  {
    key: 'thresholds.loadPerCpu', env: 'ALERT_LOAD_PER_CPU', def: 2, type: 'number', min: 0.5, max: 10, step: 0.1,
    unit: '× CPU', group: 'host', apply: 'live', label: 'Carga por CPU (media sostenida)',
    help: 'Carga media dividida entre el número de CPUs.',
  },
  {
    key: 'thresholds.sustainMinutes', env: 'ALERT_SUSTAIN_MINUTES', def: 5, type: 'int', min: 1, max: 60, unit: 'min',
    group: 'host', apply: 'live', label: 'Periodo de la media', help: 'Ventana para CPU y carga: un pico de un build no avisa.',
  },
  {
    key: 'thresholds.hysteresisPct', env: 'ALERT_HYSTERESIS_PCT', def: 5, type: 'int', min: 1, max: 20, unit: 'pts',
    group: 'host', apply: 'live', label: 'Margen para dar por recuperado',
    help: 'Tiene que bajar este margen por debajo del umbral para avisar «vuelve a la normalidad».',
  },

  {
    key: 'containers.memPct', env: 'ALERT_CONTAINER_MEM_PCT', def: 90, type: 'int', min: 50, max: 100, unit: '%',
    group: 'containers', apply: 'live', label: 'Memoria contra su límite',
    help: 'Solo para contenedores que tienen límite de memoria propio.',
  },
  {
    key: 'containers.memSamples', env: 'ALERT_CONTAINER_MEM_SAMPLES', def: 3, type: 'int', min: 1, max: 20,
    group: 'containers', apply: 'live', label: 'Muestras seguidas por encima',
    help: 'Cuántas muestras (cada 30 s) tiene que pasar el umbral antes de avisar.',
  },
  {
    key: 'containers.restartLoopCount', env: 'ALERT_RESTART_LOOP_COUNT', def: 3, type: 'int', min: 2, max: 20,
    group: 'containers', apply: 'live', label: 'Reinicios para «bucle»', help: 'Tantos reinicios dentro de la ventana = aviso crítico.',
  },
  {
    key: 'containers.restartLoopMinutes', env: 'ALERT_RESTART_LOOP_MINUTES', def: 10, type: 'int', min: 1, max: 120,
    unit: 'min', group: 'containers', apply: 'live', label: 'Ventana del bucle de reinicio', help: '',
  },

  {
    key: 'domains.extra', env: 'DOMAIN_EXTRA', def: [], type: 'list', group: 'domains', apply: 'live',
    label: 'Dominios extra', help: 'Uno por línea: host o host/ruta. Se suman a los que salen solos de Traefik; la ruta sirve cuando «/» no refleja la salud.',
    itemValid: (v) => HOST_PATH_RE.test(v) && v.length <= 300, itemHelp: 'host o host/ruta (sin https://)', maxItems: 50,
  },
  {
    key: 'domains.certWarnDays', env: 'CERT_WARN_DAYS', def: 14, type: 'int', min: 1, max: 90, unit: 'días',
    group: 'domains', apply: 'live', label: 'Avisar del certificado con', help: 'Días que le quedan al certificado HTTPS.',
  },
  {
    key: 'domains.confirmRetries', env: 'DOMAIN_CONFIRM_RETRIES', def: 1, type: 'int', min: 0, max: 5,
    group: 'domains', apply: 'live', label: 'Sondas de confirmación', help: 'Sondas extra antes de dar un dominio por caído (0 = avisa al primer fallo).',
  },
  {
    key: 'domains.confirmDelayMs', env: 'DOMAIN_CONFIRM_DELAY_MS', def: 20000, type: 'int', min: 1000, max: 120000,
    unit: 's', scale: 1000, group: 'domains', apply: 'live', label: 'Espera entre sondas de confirmación', help: '',
  },
  {
    key: 'domains.intervalMs', env: 'DOMAIN_INTERVAL_MS', def: 900000, type: 'int', min: 60000, max: 86400000,
    unit: 'min', scale: 60000, group: 'domains', apply: 'restart', label: 'Revisar dominios cada', help: '',
  },

  {
    key: 'snort.enabled', env: 'SNORT_ENABLED', def: true, type: 'bool', group: 'snort', apply: 'restart',
    label: 'Leer alertas de Snort', help: '',
  },
  {
    key: 'snort.minCount', env: 'SNORT_ALERT_MIN_COUNT', def: 5, type: 'int', min: 1, max: 1000,
    group: 'snort', apply: 'live', label: 'Alertas del mismo origen para avisar', help: '',
  },
  {
    key: 'snort.windowMinutes', env: 'SNORT_WINDOW_MINUTES', def: 10, type: 'int', min: 1, max: 1440, unit: 'min',
    group: 'snort', apply: 'live', label: 'Dentro de', help: '',
  },
  {
    key: 'snort.ignoreCidrs', env: 'SNORT_IGNORE_CIDRS',
    def: ['100.64.0.0/10', '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
    type: 'list', group: 'snort', apply: 'restart', label: 'Redes ignoradas',
    help: 'Una por línea. No quites 100.64.0.0/10: cada SSH por Tailscale dispararía «fuerza bruta».',
    itemValid: validCidr, itemHelp: 'formato 1.2.3.0/24', maxItems: 50,
  },
  {
    key: 'snort.ignoreSids', env: 'SNORT_IGNORE_SIDS', def: ['1000001'], type: 'list', group: 'snort', apply: 'restart',
    label: 'Reglas ignoradas (SID)', help: 'Una por línea. 1000001 es la regla de ping.',
    itemValid: (v) => /^\d{1,10}$/.test(v), itemHelp: 'solo números', maxItems: 50,
  },
  {
    key: 'snort.fastLog', env: 'SNORT_FAST_LOG', def: '/var/log/snort/snort.alert.fast', type: 'string',
    group: 'snort', apply: 'restart', label: 'Archivo de alertas', help: 'Ruta dentro del contenedor.',
    pattern: /^\/[\w./-]{1,250}$/, patternHelp: 'ruta absoluta',
  },

  {
    key: 'digest.enabled', env: 'DIGEST_ENABLED', def: true, type: 'bool', group: 'digest', apply: 'restart',
    label: 'Enviar resumen diario', help: 'Mensaje silencioso por Telegram. También es el latido: si un día no llega, el monitor está caído.',
  },
  {
    key: 'digest.hour', env: 'DIGEST_HOUR', def: 8, type: 'int', min: 0, max: 23, unit: 'h UTC',
    group: 'digest', apply: 'restart', label: 'Hora del resumen', help: 'Hora del contenedor (UTC).',
  },

  {
    key: 'push.enabled', env: 'PUSH_ENABLED', def: true, type: 'bool', group: 'push', apply: 'restart',
    label: 'Notificaciones push', help: 'A la app instalada en el móvil.',
  },
  {
    key: 'push.minSeverity', env: 'PUSH_MIN_SEVERITY', def: 'warn', type: 'enum',
    options: [['info', 'Todo (info)'], ['warn', 'Avisos y críticos'], ['crit', 'Solo críticos']],
    group: 'push', apply: 'live', label: 'Qué llega al móvil', help: '',
  },
  {
    key: 'push.subject', env: 'PUSH_VAPID_SUBJECT', def: 'https://github.com/container-monitor', type: 'string',
    group: 'push', apply: 'restart', label: 'Contacto VAPID', help: 'Lo ven los servicios de push. URL https:// o mailto:.',
    pattern: /^(https:\/\/\S{3,200}|mailto:\S{3,200})$/, patternHelp: 'https://… o mailto:…',
  },

  {
    key: 'watch.intervalMs', env: 'WATCH_INTERVAL_MS', def: 20000, type: 'int', min: 5000, max: 300000,
    unit: 's', scale: 1000, group: 'polling', apply: 'restart', label: 'Revisar contenedores cada',
    help: 'El sondeo de respaldo; las caídas se ven antes por el stream de eventos.',
  },
  {
    key: 'watch.inspectIntervalMs', env: 'INSPECT_INTERVAL_MS', def: 60000, type: 'int', min: 10000, max: 600000,
    unit: 's', scale: 1000, group: 'polling', apply: 'live', label: 'Inspección completa cada', help: 'Reinicios y salud real.',
  },
  {
    key: 'stats.intervalMs', env: 'STATS_INTERVAL_MS', def: 30000, type: 'int', min: 10000, max: 600000,
    unit: 's', scale: 1000, group: 'polling', apply: 'restart', label: 'Métricas cada', help: '',
  },
  {
    key: 'stats.concurrency', env: 'STATS_CONCURRENCY', def: 4, type: 'int', min: 1, max: 16,
    group: 'polling', apply: 'live', label: 'Métricas en paralelo', help: 'Contenedores consultados a la vez.',
  },
  {
    key: 'events.enabled', env: 'DOCKER_EVENTS_ENABLED', def: true, type: 'bool', group: 'polling', apply: 'restart',
    label: 'Detección en tiempo real', help: 'Escucha los eventos de Docker: una caída se ve en ~1 s.',
  },
  {
    key: 'events.debounceMs', env: 'DOCKER_EVENTS_DEBOUNCE_MS', def: 750, type: 'int', min: 100, max: 10000,
    unit: 'ms', group: 'polling', apply: 'live', label: 'Agrupar ráfagas de eventos', help: '',
  },

  {
    key: 'stats.retentionDays', env: 'RETENTION_DAYS', def: 14, type: 'int', min: 1, max: 90, unit: 'días',
    group: 'history', apply: 'live', label: 'Guardar métricas', help: 'Bajarlo borra lo más viejo en la siguiente limpieza.',
  },

  {
    key: 'ws.maxTotal', env: 'WS_MAX_TOTAL', def: 40, type: 'int', min: 1, max: 500,
    group: 'ws', apply: 'live', label: 'Conexiones de logs en total', help: '',
  },
  {
    key: 'ws.maxPerIp', env: 'WS_MAX_PER_IP', def: 8, type: 'int', min: 1, max: 100,
    group: 'ws', apply: 'live', label: 'Conexiones de logs por dispositivo', help: '',
  },
];

const BY_KEY = new Map(SCHEMA.map((f) => [f.key, f]));

// ------------------------------------------------------------ lectura del .env

const hasEnv = (field) => process.env[field.env] !== undefined && process.env[field.env] !== '';

/** Un valor ilegible cae al defecto. */
function fromEnv(field) {
  const raw = process.env[field.env];
  if (raw === undefined || raw === '') return field.def;
  switch (field.type) {
    case 'int':
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : field.def;
    }
    case 'bool':
      return /^(1|true|yes|on)$/i.test(String(raw));
    case 'list':
      return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    default:
      return String(raw);
  }
}

// ------------------------------------------------------------ validacion

/** Valor que llega del panel → valor normalizado, o lanza con el motivo. */
function normalize(field, value) {
  switch (field.type) {
    case 'int':
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      if (value === '' || !Number.isFinite(n)) throw new Error('tiene que ser un número');
      if (field.type === 'int' && !Number.isInteger(n)) throw new Error('tiene que ser un número entero');
      if (n < field.min || n > field.max) {
        const s = field.scale || 1;
        throw new Error(`entre ${field.min / s} y ${field.max / s}${field.unit ? ` ${field.unit}` : ''}`);
      }
      return n;
    }
    case 'bool':
      if (typeof value !== 'boolean') throw new Error('tiene que ser sí o no');
      return value;
    case 'enum':
      if (!field.options.some(([v]) => v === value)) throw new Error('opción no válida');
      return value;
    case 'list': {
      const items = (Array.isArray(value) ? value : String(value).split(/[\n,]/))
        .map((s) => String(s).trim())
        .filter(Boolean);
      if (items.length > field.maxItems) throw new Error(`máximo ${field.maxItems} entradas`);
      const bad = items.find((v) => !field.itemValid(v));
      if (bad !== undefined) throw new Error(`«${bad.slice(0, 60)}» no vale: ${field.itemHelp}`);
      return [...new Set(items)];
    }
    case 'string':
    case 'secret': {
      if (typeof value !== 'string') throw new Error('tiene que ser texto');
      const v = value.trim();
      if (!field.pattern.test(v)) throw new Error(`formato no válido: ${field.patternHelp}`);
      return v;
    }
    default:
      throw new Error('tipo desconocido');
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ------------------------------------------------------------ objeto config

function getPath(obj, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, key, value) {
  const parts = key.split('.');
  let o = obj;
  for (const p of parts.slice(0, -1)) o = o[p] ??= {};
  o[parts.at(-1)] = Array.isArray(value) ? [...value] : value;
}

/** Lo guardado desde el panel. Un archivo roto o un valor invalido se ignoran: el monitor arranca igual. */
function readOverrides() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[settings] ${FILE} ilegible, se ignora:`, err.message);
    return {};
  }
  const values = parsed && typeof parsed.values === 'object' && parsed.values ? parsed.values : {};
  const clean = {};
  for (const [key, value] of Object.entries(values)) {
    const field = BY_KEY.get(key);
    if (!field) {
      console.warn(`[settings] ajuste desconocido en ${FILE}: ${key}`);
      continue;
    }
    try {
      clean[key] = normalize(field, value);
    } catch (err) {
      console.warn(`[settings] ${key} en ${FILE} no vale (${err.message}), se ignora`);
    }
  }
  return clean;
}

let overrides = {};
let config = null;

const baseValue = (field) => fromEnv(field);
const effective = (field) => (field.key in overrides ? overrides[field.key] : baseValue(field));

/** Construye el objeto `config` que exporta `config.js`. Se llama una vez. */
function build(fixed) {
  overrides = readOverrides();
  config = fixed;
  for (const field of SCHEMA) setPath(config, field.key, effective(field));
  const n = Object.keys(overrides).length;
  if (n) console.log(`[settings] ${n} ajuste(s) del panel aplicados desde ${FILE}`);
  return config;
}

// ------------------------------------------------------------ panel

function describe() {
  const fields = SCHEMA.map((f) => {
    const value = effective(f);
    const running = getPath(config, f.key);
    const out = {
      key: f.key,
      env: f.env,
      group: f.group,
      label: f.label,
      help: f.help,
      type: f.type,
      apply: f.apply,
      unit: f.unit || null,
      scale: f.scale || 1,
      step: f.step || null,
      min: f.min ?? null,
      max: f.max ?? null,
      options: f.options || null,
      itemHelp: f.itemHelp || null,
      patternHelp: f.patternHelp || null,
      source: f.key in overrides ? 'panel' : hasEnv(f) ? 'env' : 'default',
      pendingRestart: !same(value, running),
    };
    if (f.type === 'secret') {
      out.set = Boolean(value);
    } else {
      out.value = value;
      out.default = f.def;
      out.envValue = hasEnv(f) ? fromEnv(f) : null;
    }
    return out;
  });
  return {
    file: FILE,
    groups: GROUPS.map(([id, label]) => ({ id, label })),
    fields,
    restartPending: fields.some((f) => f.pendingRestart),
  };
}

function writeFile(values) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  const body = JSON.stringify({ updatedAt: new Date().toISOString(), values }, null, 2);
  fs.writeFileSync(tmp, `${body}\n`, { mode: 0o600 });
  if (fs.existsSync(FILE)) fs.copyFileSync(FILE, `${FILE}.prev`);
  fs.renameSync(tmp, FILE);
}

/**
 * `changes` es `{ clave: valor | null }`; `null` quita el ajuste del panel y
 * vuelve al del `.env` (o al defecto). Todo o nada: si algo no valida no se
 * guarda nada. Devuelve la lista de cambios reales para el historial.
 */
function save(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return { ok: false, errors: { _: 'formato no válido' } };
  }

  const next = { ...overrides };
  const errors = {};
  for (const [key, value] of Object.entries(changes)) {
    const field = BY_KEY.get(key);
    if (!field) {
      errors[key] = 'ajuste desconocido';
      continue;
    }
    if (value === null) {
      delete next[key];
      continue;
    }
    try {
      const v = normalize(field, value);
      // Igual a lo que ya daria el .env o el defecto: no hace falta guardarlo.
      if (same(v, baseValue(field))) delete next[key];
      else next[key] = v;
    } catch (err) {
      errors[key] = err.message;
    }
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  const changed = [];
  for (const field of SCHEMA) {
    const before = effective(field);
    const after = field.key in next ? next[field.key] : baseValue(field);
    if (!same(before, after)) changed.push({ field, before, after });
  }
  if (!changed.length) return { ok: true, changed: [], restartRequired: describe().restartPending };

  writeFile(next);
  overrides = next;

  for (const { field, after } of changed) {
    if (field.apply === 'live') setPath(config, field.key, after);
  }

  return { ok: true, changed, restartRequired: describe().restartPending };
}

/** Texto para el historial de eventos. Los secretos nunca aparecen. */
function describeChange({ field, before, after }) {
  if (field.type === 'secret') return `${field.env} (cambiado)`;
  const fmt = (v) => {
    if (Array.isArray(v)) return v.length ? v.join(', ') : '(vacío)';
    if (typeof v === 'boolean') return v ? 'sí' : 'no';
    if (typeof v === 'number') return `${v / (field.scale || 1)}${field.unit ? ` ${field.unit}` : ''}`;
    return v === '' ? '(vacío)' : String(v);
  };
  return `${field.env} ${fmt(before)} → ${fmt(after)}`;
}

/** Valor guardado (aunque aun no aplicado) de un ajuste: lo usa la prueba de Telegram. */
const saved = (key) => effective(BY_KEY.get(key));

module.exports = { SCHEMA, GROUPS, FILE, build, describe, save, describeChange, saved };
