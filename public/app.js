(() => {
  const el = (id) => document.getElementById(id);

  const listEl = el('container-list');
  const filterEl = el('filter');
  const onlyProblemsEl = el('only-problems');
  const statusLine = el('status-line');
  const topTitle = el('top-title');
  const topEyebrow = el('top-eyebrow');
  const alertBand = el('alert-band');
  const hostStrip = el('host-strip');
  const logView = el('log-view');
  const detailBody = el('detail-body');
  const hostBody = el('host-body');
  const eventsBody = el('events-body');
  const domainsBody = el('domains-body');
  const securityBody = el('security-body');
  const settingsBody = el('settings-body');
  const settingsBar = el('settings-bar');
  const logsActions = el('logs-actions');
  const rangeActions = el('range-actions');
  const rangeChips = el('range-chips');
  const btnRefresh = el('btn-refresh');
  const btnPause = el('btn-pause');
  const btnClear = el('btn-clear');
  const btnInstall = el('btn-install');
  const btnAlerts = el('btn-alerts');
  const alertsLabel = el('alerts-label');
  const autoScrollEl = el('auto-scroll');
  const eventFilterEl = el('event-filter');
  const onlyNotifiedEl = el('only-notified');
  const eventSevChips = el('event-sev-chips');
  const toastEl = el('toast');
  const connLine = el('conn-line');
  const updatedLine = el('updated-line');
  const navDetailSub = el('nav-detail-sub');
  const navLogsSub = el('nav-logs-sub');

  const views = {
    containers: el('view-containers'),
    host: el('view-host'),
    detail: el('view-detail'),
    events: el('view-events'),
    domains: el('view-domains'),
    security: el('view-security'),
    settings: el('view-settings'),
    logs: el('view-logs'),
  };

  const navs = {
    containers: el('nav-containers'),
    host: el('nav-host'),
    detail: el('nav-detail'),
    events: el('nav-events'),
    domains: el('nav-domains'),
    security: el('nav-security'),
    settings: el('nav-settings'),
    logs: el('nav-logs'),
  };

  let containers = [];
  let host = null;
  let hostAlerts = [];
  let domainsLive = [];
  let domainState = [];
  let monitor = null;
  let selected = null;
  let currentView = 'containers';
  let socket = null;
  let paused = false;
  let lineCount = 0;
  const collapsed = new Set();
  const MAX_LINES = 5000;
  // Lo que llega mientras la vista esta pausada, para volcarlo al reanudar.
  const pauseBuffer = [];
  const MAX_PAUSE_CHUNKS = 5000;

  const POLL_BASE_MS = 15000;
  let pollFailures = 0;
  let pollTimer = null;
  let firstLoad = true;
  // Ultima respuesta buena del monitor y ultimo error del sondeo: la cabecera
  // dice "actualizado hace X" y, si el sondeo falla, que los datos son viejos.
  let lastOkAt = null;
  let lastError = null;

  let wsAttempt = 0;
  let wsRetryTimer = null;
  let wantLogsFor = null;

  const RANGES = [
    ['1h', 1], ['6h', 6], ['24h', 24], ['7d', 24 * 7], ['14d', 24 * 14],
  ];
  const range = { host: 6, detail: 6, security: 24 };
  let eventSeverity = '';
  let eventsCache = [];

  // ------------------------------------------------------------ utilidades

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtBytes(bytes) {
    if (!bytes && bytes !== 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    return `${value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
  }

  function fmtRate(bytesPerSec) {
    if (!Number.isFinite(bytesPerSec)) return '—';
    return `${fmtBytes(bytesPerSec)}/s`;
  }

  function fmtAge(seconds) {
    if (!seconds) return '—';
    const d = Math.floor(seconds / 86400);
    if (d > 0) return `${d}d`;
    const h = Math.floor(seconds / 3600);
    if (h > 0) return `${h}h`;
    return `${Math.max(1, Math.floor(seconds / 60))}m`;
  }

  function fmtTime(ts) {
    return new Date(ts).toLocaleString('es', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }

  function fmtRel(ts) {
    if (!ts) return '—';
    const diff = Math.max(0, Date.now() - ts);
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'ahora';
    if (m < 60) return `hace ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 48) return `hace ${h} h`;
    return `hace ${Math.floor(h / 24)} d`;
  }

  function fmtPct(v, digits = 1) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
    return `${Number(v).toFixed(digits)}%`;
  }

  function fmtUptime(sec) {
    if (!sec) return '—';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d) return `${d} d ${h} h`;
    if (h) return `${h} h ${m} min`;
    return `${m} min`;
  }

  let toastTimer = null;
  function toast(text, kind = 'info') {
    toastEl.textContent = text;
    toastEl.className = `toast ${kind}`;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, 4500);
  }

  /** Un contenedor "con problema" es lo único urgente: va arriba y siempre visible. */
  function isProblem(c) {
    return c.state !== 'running' || c.health === 'unhealthy';
  }

  function problemReason(c) {
    if (c.health === 'unhealthy') return 'healthcheck fallando';
    if (c.state !== 'running') return c.status ? fmtDockerStatus(c.status) : stateLabel(c.state);
    return '';
  }

  const HOST_ALERT_LABELS = {
    host_disk: 'Disco lleno',
    host_mem: 'RAM alta',
    host_swap: 'Swap alto',
    host_cpu: 'CPU sostenida',
    host_load: 'Carga alta',
  };

  const KIND_LABELS = {
    container_down: 'caída',
    container_up: 'recuperado',
    container_restarted: 'reinicio',
    container_restart_loop: 'bucle de reinicio',
    container_oom: 'sin memoria (OOM)',
    container_mem: 'memoria al límite',
    container_mem_ok: 'memoria ok',
    container_unhealthy: 'sin salud',
    container_healthy: 'sano otra vez',
    container_gone: 'eliminado',
    container_new: 'nuevo',
    container_paused: 'pausado',
    container_unpaused: 'reanudado',
    host_disk: 'disco',
    host_mem: 'RAM',
    host_swap: 'swap',
    host_cpu: 'CPU',
    host_load: 'carga',
    host_disk_ok: 'disco ok',
    host_mem_ok: 'RAM ok',
    host_swap_ok: 'swap ok',
    host_cpu_ok: 'CPU ok',
    host_load_ok: 'carga ok',
    domain_down: 'dominio caído',
    domain_up: 'dominio ok',
    cert_expiring: 'certificado',
    snort: 'snort',
    monitor_docker_unreachable: 'docker no responde',
    monitor_docker_ok: 'docker ok',
    config_changed: 'ajustes',
  };

  const kindLabel = (kind) => KIND_LABELS[kind] || kind;

  /** Estados de Docker en español. La clase CSS conserva el nombre original. */
  const STATE_LABELS = {
    running: 'En marcha',
    exited: 'Parado',
    created: 'Creado',
    dead: 'Muerto',
    paused: 'En pausa',
    restarting: 'Reiniciando',
    removing: 'Eliminándose',
  };
  const stateLabel = (state) => STATE_LABELS[state] || state;

  const HEALTH_LABELS = { healthy: 'Sano', unhealthy: 'Sin salud', starting: 'Arrancando' };
  const healthLabel = (health) => HEALTH_LABELS[health] || health;

  const SEV_LABELS = { crit: 'Crítico', warn: 'Aviso', info: 'Info' };
  const sevLabel = (sev) => SEV_LABELS[sev] || sev;

  const TYPE_LABELS = {
    application: 'aplicación de Coolify',
    service: 'servicio de Coolify',
    stack: 'stack',
    compose: 'docker compose',
    other: 'sin proyecto',
  };

  const RESTART_POLICY_LABELS = {
    'unless-stopped': 'siempre, salvo parada manual',
    always: 'siempre',
    'on-failure': 'solo si falla',
    no: 'nunca',
  };

  /** "Exited (137) 2 hours ago" → "Parado (código 137) hace 2 h". Lo que no se reconoce se deja tal cual. */
  function fmtDockerStatus(status) {
    const s = String(status || '');
    const ago = (txt) => {
      const m = txt.match(/^(?:About an?|Less than an?|(\d+))\s*(second|minute|hour|day|week|month|year)s?(?: ago)?$/i);
      if (!m) return txt;
      const n = m[1] ? Number(m[1]) : 1;
      const unit = { second: 's', minute: 'min', hour: 'h', day: 'd', week: 'sem', month: 'mes', year: 'año' }[m[2].toLowerCase()];
      const label = n === 1 ? unit : unit === 'mes' ? 'meses' : unit === 'año' ? 'años' : unit;
      return `${n} ${label}`;
    };
    let m = s.match(/^Exited \((-?\d+)\) (.+)$/);
    if (m) return `Parado (código ${m[1]}) hace ${ago(m[2])}`;
    m = s.match(/^Restarting \((-?\d+)\) (.+)$/);
    if (m) return `Reiniciando (código ${m[1]}) hace ${ago(m[2])}`;
    m = s.match(/^Up (.+?)(?: \((?:healthy|unhealthy|health: starting)\))?$/);
    if (m) return `En marcha desde hace ${ago(m[1])}`;
    if (/^Created$/.test(s)) return 'Creado, sin arrancar';
    if (/^Paused/.test(s)) return 'En pausa';
    if (/^Dead/.test(s)) return 'Muerto';
    return s;
  }

  /** Umbrales e intervalos que usa el servidor: el panel pinta con los mismos. */
  const cfg = () => monitor?.config || {};

  // ------------------------------------------------------------ navegación

  function renderRangeChips(view) {
    rangeChips.innerHTML = '';
    for (const [label, hours] of RANGES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `chip${range[view] === hours ? ' active' : ''}`;
      b.setAttribute('aria-pressed', String(range[view] === hours));
      b.textContent = label;
      b.addEventListener('click', () => {
        range[view] = hours;
        renderRangeChips(view);
        if (view === 'host') renderHost();
        else if (view === 'detail') renderDetail();
        else if (view === 'security') renderSecurity();
      });
      rangeChips.appendChild(b);
    }
  }

  function setView(view) {
    currentView = view;
    // En Ajustes la banda de problemas y la tira del host solo quitan sitio al formulario.
    document.body.classList.toggle('on-settings', view === 'settings');

    for (const [name, node] of Object.entries(views)) {
      node.classList.toggle('hidden', name !== view);
    }
    for (const [name, node] of Object.entries(navs)) {
      node.classList.toggle('active', name === view);
    }

    logsActions.hidden = view !== 'logs';
    const ranged = view === 'host' || view === 'detail' || view === 'security';
    rangeActions.hidden = !ranged;
    if (ranged) renderRangeChips(view);

    if ((view === 'logs' || view === 'detail') && selected) {
      topEyebrow.textContent = selected.app || 'Contenedor';
      topTitle.textContent = selected.displayName;
      statusLine.textContent = `${selected.name} · ${stateLabel(selected.state)}`;
    } else if (view === 'events') {
      topEyebrow.textContent = 'Monitor';
      topTitle.textContent = 'Eventos';
      statusLine.textContent = 'Transiciones detectadas y avisos enviados';
      renderEvents();
    } else if (view === 'domains') {
      topEyebrow.textContent = 'Monitor';
      topTitle.textContent = 'Dominios';
      statusLine.textContent = `Sonda HTTPS cada ${Math.round((cfg().domainIntervalMs || 900000) / 60000)} min, con los días que le quedan al certificado`;
      renderDomains();
    } else if (view === 'host') {
      topEyebrow.textContent = 'Monitor';
      topTitle.textContent = monitor?.info?.name ? `Host · ${monitor.info.name}` : 'Host';
      updateHostStatusLine();
      renderHost();
    } else if (view === 'security') {
      topEyebrow.textContent = 'Monitor';
      topTitle.textContent = 'Seguridad';
      statusLine.textContent = 'Alertas de Snort, sin las redes propias (Tailscale y privadas)';
      renderSecurity();
    } else if (view === 'settings') {
      topEyebrow.textContent = 'Monitor';
      topTitle.textContent = 'Ajustes';
      statusLine.textContent = 'Los cambios se guardan en el servidor y mandan sobre el archivo .env, que no se modifica';
      renderSettings();
    } else {
      topEyebrow.textContent = 'Monitor';
      topTitle.textContent = 'Contenedores';
      updateStatusLine();
    }

    if (view !== 'logs' && view !== 'detail') {
      const hash = view === 'containers' ? '' : `#${view}`;
      if (location.hash !== hash) history.replaceState(null, '', location.pathname + hash);
    }
  }

  function updateStatusLine() {
    if (currentView !== 'containers') return;
    if (!containers.length) {
      if (!lastOkAt) statusLine.textContent = lastError ? 'Sin respuesta del monitor todavía' : 'Cargando…';
      else if (monitor?.dockerDown) statusLine.textContent = 'Docker no responde: el monitor no puede listar contenedores';
      else statusLine.textContent = 'Docker no devuelve ningún contenedor';
      return;
    }
    const running = containers.filter((c) => c.state === 'running').length;
    const problems = containers.filter(isProblem).length;
    const bits = [`${containers.length} contenedores`, `${running} en marcha`];
    if (problems) bits.push(`${problems} con problemas`);
    else bits.push('todo en verde');
    if (monitor?.eventsConnected) bits.push('detección en tiempo real');
    statusLine.textContent = bits.join(' · ');
  }

  function updateHostStatusLine() {
    if (currentView !== 'host' || !host) return;
    const bits = [];
    if (host.cpus) bits.push(`${host.cpus} vCPU`);
    if (host.memTotal) bits.push(`${fmtBytes(host.memTotal)} RAM`);
    if (host.diskTotal) bits.push(`${fmtBytes(host.diskTotal)} disco`);
    if (host.uptimeSec) bits.push(`encendido desde hace ${fmtUptime(host.uptimeSec)}`);
    statusLine.textContent = bits.join(' · ');
  }

  // ------------------------------------------------------------ carga

  async function loadOverview() {
    try {
      const res = await fetch('/api/overview');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      containers = data.containers || [];
      host = data.host || null;
      hostAlerts = data.hostAlerts || [];
      domainsLive = data.domains || [];
      domainState = data.domainState || [];
      monitor = data.monitor || null;
      pollFailures = 0;
      lastOkAt = Date.now();
      lastError = null;

      if (selected) selected = containers.find((c) => c.id === selected.id) || selected;

      renderAlertBand();
      renderHostStrip();
      renderList();
      updateStatusLine();
      updateHostStatusLine();
      renderConnLine();
      if (currentView === 'detail' && selected) renderDetail();
      if (currentView === 'host') renderHost();
      // Eventos se refresca solo mientras esta a la vista (sin parpadeo de "Cargando").
      if (currentView === 'events') renderEvents({ quiet: true });

      if (firstLoad) {
        firstLoad = false;
        applyHash();
      }
    } catch (err) {
      pollFailures += 1;
      lastError = err.message;
      // La linea de estado de cada pestaña no se pisa: el fallo va en su propia
      // linea, que desaparece sola cuando el monitor vuelve a responder.
      renderConnLine();
      updateStatusLine();
      if (!containers.length) {
        listEl.innerHTML = `<div class="error">No se pudo cargar la lista: ${escapeHtml(err.message)}</div>`;
      }
    } finally {
      schedulePoll();
      renderUpdatedLine();
    }
  }

  /** Backoff cuando el backend está caído: no martillear cada 15 s. */
  function nextPollDelay() {
    return pollFailures ? Math.min(POLL_BASE_MS * 2 ** Math.min(pollFailures, 4), 120000) : POLL_BASE_MS;
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(loadOverview, nextPollDelay());
  }

  /** Linea de conexion bajo el titulo: solo existe mientras el sondeo falla. */
  function renderConnLine() {
    if (restarting || !lastError) {
      connLine.hidden = true;
      connLine.textContent = '';
      return;
    }
    const since = lastOkAt ? ` · se muestran los datos de las ${fmtTime(lastOkAt)}` : '';
    connLine.textContent = `Sin conexión con el monitor (${lastError}) · reintento en ${Math.round(nextPollDelay() / 1000)} s${since}`;
    connLine.hidden = false;
  }

  /** "Actualizado hace 12 s" en la cabecera, en todas las pestañas. */
  function renderUpdatedLine() {
    if (!lastOkAt) {
      updatedLine.textContent = lastError ? 'sin datos' : '';
      updatedLine.classList.toggle('stale', Boolean(lastError));
      return;
    }
    const sec = Math.max(0, Math.round((Date.now() - lastOkAt) / 1000));
    const stale = Boolean(lastError) || sec > (POLL_BASE_MS / 1000) * 3;
    updatedLine.textContent = `${stale ? 'Datos de ' : 'Actualizado '}${sec < 60 ? `hace ${sec} s` : fmtRel(lastOkAt)}`;
    updatedLine.classList.toggle('stale', stale);
  }
  setInterval(renderUpdatedLine, 5000);

  /** `#events`, `#host`, `#container=<id>`: lo que abre un push o un acceso directo. */
  function applyHash() {
    const hash = location.hash.replace(/^#/, '');
    if (!hash) return;
    const m = hash.match(/^container=([a-zA-Z0-9_.-]{1,64})$/);
    if (m) {
      const c = containers.find((x) => x.id === m[1] || x.id.startsWith(m[1]));
      if (c) openDetail(c);
      return;
    }
    if (['events', 'host', 'domains', 'security', 'settings', 'containers'].includes(hash)) setView(hash);
  }

  // ------------------------------------------------------------ banda de alerta

  function collectProblems() {
    const items = [];
    for (const c of containers.filter(isProblem)) {
      items.push({ name: c.displayName, why: problemReason(c), onClick: () => openDetail(c) });
    }
    for (const kind of hostAlerts) {
      items.push({ name: 'host', why: HOST_ALERT_LABELS[kind] || kind, onClick: () => setView('host') });
    }
    const downDomains = new Set(domainState.filter((d) => d.down).map((d) => d.domain));
    for (const d of domainsLive.filter((x) => !x.ok)) downDomains.add(d.domain);
    for (const domain of downDomains) {
      const live = domainsLive.find((x) => x.domain === domain);
      const why = live?.error ? `no responde: ${live.error}` : live?.status ? `HTTP ${live.status}` : 'caído';
      items.push({ name: domain, why, onClick: () => setView('domains') });
    }
    for (const p of monitor?.problems || []) {
      items.push({ name: 'monitor', why: p, onClick: () => setView('events') });
    }
    return items;
  }

  function renderAlertBand() {
    const problems = collectProblems();
    if (!problems.length) {
      alertBand.hidden = true;
      alertBand.innerHTML = '';
      return;
    }

    alertBand.hidden = false;
    alertBand.innerHTML = `
      <div class="alert-band-title">${problems.length} ${problems.length === 1 ? 'cosa necesita atención' : 'cosas necesitan atención'}</div>
      <div class="alert-band-items"></div>
    `;

    const wrap = alertBand.querySelector('.alert-band-items');
    for (const p of problems) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'alert-chip';
      btn.innerHTML = `
        <span class="alert-chip-name">${escapeHtml(p.name)}</span>
        <span class="alert-chip-why">${escapeHtml(p.why)}</span>
      `;
      btn.addEventListener('click', p.onClick);
      wrap.appendChild(btn);
    }
  }

  function renderHostStrip() {
    if (!host) {
      hostStrip.hidden = true;
      return;
    }

    hostStrip.hidden = false;
    const hot = (k) => hostAlerts.includes(k);
    const cells = [
      ['CPU', host.cpuPct === null ? '—' : `${host.cpuPct}%`, hot('host_cpu') || host.cpuPct >= (cfg().thresholds?.cpuPct ?? 90)],
      ['RAM', `${host.memPct}%`, hot('host_mem')],
      ['Swap', `${host.swapPct}%`, hot('host_swap')],
      ['Disco', `${host.diskPct}%`, hot('host_disk')],
      ['Carga', String(host.load1 ?? '—'), hot('host_load')],
    ];

    hostStrip.innerHTML = cells
      .map(
        ([label, value, isHot]) => `
          <button type="button" class="host-cell${isHot ? ' hot' : ''}" data-go="host">
            <span class="host-label">${label}</span>
            <span class="host-value">${escapeHtml(value)}</span>
          </button>`,
      )
      .join('');
    for (const b of hostStrip.querySelectorAll('[data-go="host"]')) {
      b.addEventListener('click', () => setView('host'));
    }
  }

  // ------------------------------------------------------------ lista

  function filtered() {
    const q = filterEl.value.trim().toLowerCase();
    return containers.filter((c) => {
      if (onlyProblemsEl.checked && !isProblem(c)) return false;
      if (!q) return true;
      const hay = [c.displayName, c.name, c.image, c.app, c.project, c.shortId]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }

  function groupByApp(items) {
    const map = new Map();
    for (const c of items) {
      const key = c.appKey || 'other';
      if (!map.has(key)) {
        map.set(key, {
          key,
          app: c.app || 'Otros',
          project: c.project || null,
          kind: c.type || 'other',
          containers: [],
        });
      }
      map.get(key).containers.push(c);
    }
    return [...map.values()].sort((a, b) => {
      const ap = a.containers.some(isProblem) ? 0 : 1;
      const bp = b.containers.some(isProblem) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.app.localeCompare(b.app);
    });
  }

  function portsLabel(c) {
    const published = (c.ports || []).filter((p) => p.public);
    if (!published.length) return '';
    return published
      .slice(0, 3)
      .map((p) => `${p.public}→${p.private}`)
      .join(' ');
  }

  /** Limite "real": menor que la RAM del host. Si no, no hay limite. */
  function memLimitOf(c) {
    const limit = c.memLimit || c.stats?.memLimit || 0;
    if (!limit) return 0;
    if (host?.memTotal && limit >= host.memTotal * 0.98) return 0;
    return limit;
  }

  function cardMeta(c) {
    const bits = [];
    const ports = portsLabel(c);
    if (ports) bits.push(ports);
    if (c.created) bits.push(fmtAge(Date.now() / 1000 - c.created));
    if (typeof c.restartCount === 'number' && c.restartCount > 0) {
      bits.push(`${c.restartCount} reinicios`);
    }
    if (c.stats) {
      bits.push(`${c.stats.cpuPct.toFixed(1)}% cpu`);
      const limit = memLimitOf(c);
      bits.push(limit ? `${fmtBytes(c.stats.memBytes)} / ${fmtBytes(limit)}` : fmtBytes(c.stats.memBytes));
    }
    return bits.join(' · ');
  }

  function renderList() {
    const groups = groupByApp(filtered());

    if (!groups.length) {
      listEl.innerHTML = `<div class="empty">${
        onlyProblemsEl.checked ? 'Nada con problemas ahora mismo.' : 'Sin coincidencias'
      }</div>`;
      return;
    }

    listEl.innerHTML = '';
    for (const group of groups) {
      const running = group.containers.filter((c) => c.state === 'running').length;
      const isCollapsed = collapsed.has(group.key);
      const hasProblem = group.containers.some(isProblem);

      const section = document.createElement('section');
      section.className = `app-group${isCollapsed ? ' collapsed' : ''}${hasProblem ? ' has-problem' : ''}`;

      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'app-group-head';
      head.innerHTML = `
        <div class="app-group-left">
          <span class="chevron" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></span>
          <div>
            <div class="app-group-title">${escapeHtml(group.app)}</div>
            ${
              group.project
                ? `<div class="app-group-sub">proyecto · ${escapeHtml(group.project)}</div>`
                : `<div class="app-group-sub">${escapeHtml(TYPE_LABELS[group.kind] || group.kind)}</div>`
            }
          </div>
        </div>
        <span class="app-group-stats">${running}/${group.containers.length}</span>
      `;
      head.setAttribute('aria-expanded', String(!isCollapsed));
      head.addEventListener('click', () => {
        if (collapsed.has(group.key)) collapsed.delete(group.key);
        else collapsed.add(group.key);
        renderList();
      });

      const body = document.createElement('ul');
      body.className = 'app-group-body';

      for (const c of group.containers) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `container-item${selected && c.id === selected.id ? ' active' : ''}${
          isProblem(c) ? ' problem' : ''
        }`;

        const healthBadge =
          c.health && c.health !== 'healthy'
            ? `<span class="badge health-${escapeHtml(c.health)}" title="Healthcheck de Docker: ${escapeHtml(c.health)}">${escapeHtml(healthLabel(c.health))}</span>`
            : '';
        const limit = memLimitOf(c);
        const memPct = limit && c.stats ? Math.min(100, (c.stats.memBytes / limit) * 100) : null;
        const memWarn = cfg().containerMemPct ?? 90;
        const memBar =
          memPct !== null
            ? `<div class="mem-bar${memPct >= memWarn ? ' hot' : ''}" title="Memoria: ${Math.round(memPct)}% de su límite (aviso al ${memWarn}%)"><i style="width:${memPct.toFixed(0)}%"></i></div>`
            : '';

        btn.innerHTML = `
          <div class="item-top">
            <span class="item-name">${escapeHtml(c.displayName)}</span>
            <span class="badges">
              ${healthBadge}
              <span class="badge ${escapeHtml(c.state)}" title="Estado en Docker: ${escapeHtml(c.state)}">${escapeHtml(stateLabel(c.state))}</span>
            </span>
          </div>
          <div class="item-meta">${escapeHtml(c.name)}</div>
          <div class="item-meta dim">${escapeHtml(c.image || '')}</div>
          ${cardMeta(c) ? `<div class="item-meta dim">${escapeHtml(cardMeta(c))}</div>` : ''}
          ${memBar}
        `;
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          openDetail(c);
        });
        li.appendChild(btn);
        body.appendChild(li);
      }

      section.appendChild(head);
      section.appendChild(body);
      listEl.appendChild(section);
    }
  }

  // ------------------------------------------------------------ gráficas

  /**
   * Sparkline con área, línea de umbral opcional y eje temporal. `max` fija el
   * techo (100 para porcentajes) para que dos gráficas sean comparables.
   */
  function sparkline(points, { width = 460, height = 64, accessor, threshold = null, max = null } = {}) {
    const values = points.map((p) => ({ t: p.ts, v: accessor(p) })).filter((p) => Number.isFinite(p.v));
    if (values.length < 2) return '<div class="spark-empty">Sin histórico todavía</div>';

    const top = max ?? Math.max(...values.map((p) => p.v), threshold ?? 0, 0.0001);
    const min = 0;
    const span = top - min || 1;
    const t0 = values[0].t;
    const t1 = values[values.length - 1].t;
    const tspan = t1 - t0 || 1;

    const x = (t) => (((t - t0) / tspan) * width).toFixed(1);
    const y = (v) => (height - ((Math.min(v, top) - min) / span) * height).toFixed(1);

    const line = values.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t)},${y(p.v)}`).join(' ');
    const area = `${line} L${x(t1)},${height} L${x(t0)},${height} Z`;
    const thr =
      threshold !== null && threshold <= top
        ? `<line x1="0" x2="${width}" y1="${y(threshold)}" y2="${y(threshold)}" class="spark-threshold" />`
        : '';

    return `
      <svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img">
        <path d="${area}" class="spark-area" />
        ${thr}
        <path d="${line}" fill="none" stroke="currentColor" stroke-width="1.6" vector-effect="non-scaling-stroke" />
      </svg>`;
  }

  function statsOf(points, accessor) {
    const vals = points.map(accessor).filter((v) => Number.isFinite(v));
    if (!vals.length) return null;
    const sum = vals.reduce((a, b) => a + b, 0);
    return { last: vals[vals.length - 1], avg: sum / vals.length, max: Math.max(...vals), min: Math.min(...vals) };
  }

  function sparkCard(title, points, { accessor, fmt = (v) => fmtPct(v), threshold = null, max = null, cls = '' }) {
    const s = statsOf(points, accessor);
    return `
      <section class="card">
        <h2>${escapeHtml(title)}</h2>
        <div class="spark-wrap ${cls}">${sparkline(points, { accessor, threshold, max })}</div>
        <p class="spark-now">${
          s
            ? `${fmt(s.last)} ahora · media ${fmt(s.avg)} · máx ${fmt(s.max)}${threshold !== null ? ` · umbral ${fmt(threshold)}` : ''}`
            : 'sin muestra'
        }</p>
      </section>`;
  }

  /** Tasa a partir de un contador acumulado (bytes de red). */
  function rateSeries(points, accessor) {
    const out = [];
    for (let i = 1; i < points.length; i += 1) {
      const dt = (points[i].ts - points[i - 1].ts) / 1000;
      const dv = accessor(points[i]) - accessor(points[i - 1]);
      if (dt > 0 && dv >= 0) out.push({ ts: points[i].ts, v: dv / dt });
    }
    return out;
  }

  // ------------------------------------------------------------ host

  async function renderHost() {
    if (currentView !== 'host') return;
    let data;
    try {
      const res = await fetch(`/api/host?hours=${range.host}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      hostBody.innerHTML = `<div class="empty">No se pudo cargar el histórico: ${escapeHtml(err.message)}</div>`;
      return;
    }

    const samples = data.samples || [];
    const t = data.thresholds || {};
    const cur = data.current || host || {};
    const memPct = (s) => (s.mem_total ? (s.mem_used / s.mem_total) * 100 : NaN);
    const swapPct = (s) => (s.swap_total ? (s.swap_used / s.swap_total) * 100 : NaN);

    const facts = [
      ['CPUs', cur.cpus ?? '—'],
      ['RAM', cur.memTotal ? `${fmtBytes(cur.memUsed)} de ${fmtBytes(cur.memTotal)}` : '—'],
      ['Swap', cur.swapTotal ? `${fmtBytes(cur.swapUsed)} de ${fmtBytes(cur.swapTotal)}` : '—'],
      ['Disco', cur.diskTotal ? `${fmtBytes(cur.diskTotal - cur.diskFree)} de ${fmtBytes(cur.diskTotal)} (${fmtBytes(cur.diskFree)} libres)` : '—'],
      ['Carga (1 / 5 / 15 min)', `${cur.load1 ?? '—'} / ${cur.load5 ?? '—'} / ${cur.load15 ?? '—'}`],
      ['Encendido desde hace', fmtUptime(cur.uptimeSec)],
      ['Docker', monitor?.info?.serverVersion ? `${monitor.info.serverVersion} · ${monitor.info.running}/${monitor.info.containers} contenedores` : '—'],
      ['Umbrales activos', hostAlerts.length ? hostAlerts.map((k) => HOST_ALERT_LABELS[k] || k).join(', ') : 'ninguno'],
    ];

    hostBody.innerHTML = `
      <div class="detail-grid">
        ${sparkCard(`CPU · ${range.host} h`, samples, { accessor: (s) => s.cpu_pct, threshold: t.cpuPct ?? null, max: 100 })}
        ${sparkCard(`RAM · ${range.host} h`, samples, { accessor: memPct, threshold: t.memPct ?? null, max: 100, cls: 'mem' })}
        ${sparkCard(`Swap · ${range.host} h`, samples, { accessor: swapPct, threshold: t.swapPct ?? null, max: 100, cls: 'swap' })}
        ${sparkCard(`Disco · ${range.host} h`, samples, { accessor: (s) => s.disk_pct, threshold: t.diskPct ?? null, max: 100, cls: 'disk' })}
        ${sparkCard(`Carga · ${range.host} h`, samples, {
          accessor: (s) => s.load1, fmt: (v) => (Number.isFinite(v) ? v.toFixed(2) : '—'),
          threshold: t.loadPerCpu && cur.cpus ? t.loadPerCpu * cur.cpus : null, cls: 'load',
        })}
        <section class="card">
          <h2>Máquina</h2>
          <table class="kv">
            ${facts.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('')}
          </table>
        </section>
        ${renderMonitorCard()}
      </div>
    `;
  }

  function renderMonitorCard() {
    if (!monitor) return '';
    const rows = [
      ['Versión', monitor.version || '—'],
      ['Monitor en marcha desde hace', fmtUptime(monitor.uptimeSec)],
      ['Eventos de Docker', monitor.eventsConnected ? 'conectado (detección inmediata)' : `desconectado: sondeo cada ${Math.round((cfg().watchIntervalMs || 20000) / 1000)} s`],
      ['Snort', monitor.snortFollowing ? 'siguiendo el log' : 'no disponible'],
      ['Telegram', monitor.telegram ? 'activo' : 'sin configurar'],
      ['Push', monitor.push ? `${monitor.pushSubscribers} dispositivo${monitor.pushSubscribers === 1 ? '' : 's'}` : 'desactivado'],
      ['Estado', monitor.problems?.length ? monitor.problems.join(' · ') : 'todo en orden'],
    ];
    return `
      <section class="card">
        <h2>Monitor</h2>
        <table class="kv">
          ${rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('')}
        </table>
      </section>`;
  }

  // ------------------------------------------------------------ detalle

  async function openDetail(c) {
    selected = c;
    navs.detail.classList.remove('hidden');
    navDetailSub.textContent = c.displayName;
    navs.detail.title = `Detalle de ${c.displayName}`;
    setView('detail');
    history.replaceState(null, '', `${location.pathname}#container=${c.shortId}`);
    detailBody.innerHTML = '<div class="empty">Cargando…</div>';
    renderList();
    await renderDetail();
  }

  async function renderDetail() {
    if (!selected || currentView !== 'detail') return;
    const c = containers.find((x) => x.id === selected.id) || selected;

    let history = { samples: [], events: [] };
    let detail = null;
    try {
      const [h, d] = await Promise.all([
        fetch(`/api/history/${encodeURIComponent(c.id)}?hours=${range.detail}`),
        fetch(`/api/containers/${encodeURIComponent(c.id)}`),
      ]);
      if (h.ok) history = await h.json();
      if (d.ok) detail = (await d.json()).detail;
    } catch {
      /* el detalle sigue siendo útil sin histórico */
    }

    const limit = memLimitOf({ ...c, memLimit: detail?.memLimit ?? c.memLimit });
    const rows = [
      ['Nombre', c.name],
      ['Imagen', c.image],
      ['Estado', `${stateLabel(c.state)}${c.status ? ` — ${fmtDockerStatus(c.status)}` : ''}`],
      ['Salud', c.health ? `${healthLabel(c.health)} (healthcheck)` : 'sin healthcheck'],
      ['Reinicios', c.restartCount ?? '—'],
      ['Reinicio automático', c.restartPolicy ? `${RESTART_POLICY_LABELS[c.restartPolicy] || c.restartPolicy} (${c.restartPolicy})` : '—'],
      ['Último código de salida', detail ? `${detail.exitCode ?? '—'}${detail.oomKilled ? ' · matado por falta de memoria (OOM)' : ''}` : '—'],
      ['Arrancado', detail?.startedAt ? fmtTime(detail.startedAt) : '—'],
      ['Límite de memoria', limit ? fmtBytes(limit) : 'sin límite'],
      ['Creado', c.created ? fmtTime(c.created * 1000) : '—'],
      ['Puertos', portsLabel(c) || 'ninguno publicado'],
      ['ID', c.shortId],
    ];

    const samples = history.samples || [];
    const rx = rateSeries(samples, (s) => s.net_rx);
    const tx = rateSeries(samples, (s) => s.net_tx);
    const rxStats = statsOf(rx, (p) => p.v);
    const txStats = statsOf(tx, (p) => p.v);

    const healthLog = (detail?.healthLog || []).filter((l) => l.exitCode !== 0);

    detailBody.innerHTML = `
      <div class="detail-actions">
        <button type="button" class="btn" id="btn-open-logs">Ver logs en vivo</button>
        <button type="button" class="btn ghost" id="btn-back">← Contenedores</button>
      </div>

      <div class="detail-grid">
        <section class="card">
          <h2>Ficha</h2>
          <table class="kv">
            ${rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('')}
          </table>
        </section>

        <section class="card">
          <h2>CPU · últimas ${range.detail} h</h2>
          <div class="spark-wrap cpu">${sparkline(samples, { accessor: (s) => s.cpu_pct })}</div>
          <p class="spark-now">${c.stats ? `${c.stats.cpuPct.toFixed(1)}% ahora` : 'sin muestra'}${
            statsOf(samples, (s) => s.cpu_pct) ? ` · máx ${fmtPct(statsOf(samples, (s) => s.cpu_pct).max)}` : ''
          }</p>

          <h2>Memoria · últimas ${range.detail} h</h2>
          <div class="spark-wrap mem">${sparkline(samples, {
            accessor: (s) => s.mem_bytes, threshold: limit || null, max: limit || null,
          })}</div>
          <p class="spark-now">${
            c.stats
              ? `${fmtBytes(c.stats.memBytes)}${limit ? ` de ${fmtBytes(limit)} (${Math.round((c.stats.memBytes / limit) * 100)}%)` : ''} ahora`
              : 'sin muestra'
          }</p>

          <h2>Red · últimas ${range.detail} h</h2>
          <div class="spark-wrap net">${sparkline(rx, { accessor: (p) => p.v })}</div>
          <p class="spark-now">${
            rxStats ? `↓ ${fmtRate(rxStats.last)} (máx ${fmtRate(rxStats.max)})` : 'sin muestra'
          }${txStats ? ` · ↑ ${fmtRate(txStats.last)} (máx ${fmtRate(txStats.max)})` : ''}</p>
        </section>

        ${
          healthLog.length
            ? `<section class="card wide">
                <h2>Últimos healthchecks fallidos</h2>
                <ul class="event-list">${healthLog
                  .map(
                    (l) => `<li class="sev-crit">
                      <span class="event-time">${fmtTime(l.start)}</span>
                      <span class="event-detail"><code>exit ${l.exitCode}</code> ${escapeHtml(l.output || '')}</span>
                    </li>`,
                  )
                  .join('')}</ul>
              </section>`
            : ''
        }

        <section class="card wide">
          <h2>Eventos de este contenedor</h2>
          ${
            history.events?.length
              ? `<ul class="event-list">${history.events
                  .map(
                    (e) => `<li class="sev-${escapeHtml(e.severity)}">
                      <span class="event-time">${fmtTime(e.ts)}</span>
                      <span class="event-kind">${escapeHtml(kindLabel(e.kind))}</span>
                      <span class="event-detail">${escapeHtml(e.detail || '')}</span>
                    </li>`,
                  )
                  .join('')}</ul>`
              : '<div class="empty">Sin eventos registrados.</div>'
          }
        </section>
      </div>
    `;

    el('btn-open-logs').addEventListener('click', () => openLogs(c));
    el('btn-back').addEventListener('click', () => setView('containers'));
  }

  // ------------------------------------------------------------ eventos

  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /** Un error se pinta distinto de una lista vacia. */
  const errorBox = (text) => `<div class="error">${escapeHtml(text)}</div>`;

  async function renderEvents({ quiet = false } = {}) {
    if (!quiet || !eventsCache.length) eventsBody.innerHTML = '<div class="empty">Cargando…</div>';
    try {
      const { events } = await getJson('/api/events?limit=400');
      eventsCache = events || [];
      paintEvents();
    } catch (err) {
      if (quiet) return; // ya hay una lista en pantalla y la cabecera avisa de la desconexion
      eventsBody.innerHTML = errorBox(`No se pudieron cargar los eventos: ${err.message}`);
    }
  }

  function paintEvents() {
    const q = eventFilterEl.value.trim().toLowerCase();
    const rows = eventsCache.filter((e) => {
      if (eventSeverity && e.severity !== eventSeverity) return false;
      if (onlyNotifiedEl.checked && !e.notified) return false;
      if (q && !`${e.name || ''} ${e.kind} ${kindLabel(e.kind)} ${e.detail || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });

    if (!rows.length) {
      eventsBody.innerHTML = `<div class="empty">${
        eventsCache.length
          ? 'Ningún evento coincide con el filtro.'
          : 'Sin eventos todavía: aquí queda cada cambio que detecta el monitor.'
      }</div>`;
      return;
    }

    const crit = eventsCache.filter((e) => e.severity === 'crit').length;
    const sent = eventsCache.filter((e) => e.notified).length;

    eventsBody.innerHTML = `
      <p class="events-summary">${rows.length} de ${eventsCache.length} eventos · ${crit} críticos · ${sent} enviados</p>
      <ul class="event-list big">${rows
        .map(
          (e) => `<li class="sev-${escapeHtml(e.severity)}">
            <span class="event-time" title="${fmtTime(e.ts)}">${fmtTime(e.ts)}<br><small>${fmtRel(e.ts)}</small></span>
            <span class="event-name"><span class="sev-label sev-${escapeHtml(e.severity)}">${escapeHtml(sevLabel(e.severity))}</span> ${escapeHtml(e.name || 'host')}</span>
            <span class="event-kind">${escapeHtml(kindLabel(e.kind))}</span>
            <span class="event-detail">${escapeHtml(e.detail || '')}</span>
            ${e.notified ? '<span class="event-sent" title="Avisado por Telegram o push">Enviado</span>' : '<span class="event-sent dim" title="Sin aviso: solo queda en el historial">Historial</span>'}
          </li>`,
        )
        .join('')}</ul>`;
  }

  // ------------------------------------------------------------ dominios

  async function renderDomains() {
    domainsBody.innerHTML = '<div class="empty">Cargando…</div>';
    try {
      const { domains, state } = await getJson('/api/domains');
      if (!domains.length) {
        domainsBody.innerHTML = '<div class="empty">Todavía no hay sondas. La primera tarda unos minutos.</div>';
        return;
      }

      const histories = await Promise.all(
        domains.map((d) =>
          fetch(`/api/domains/${encodeURIComponent(d.domain)}/history?hours=24`)
            .then((r) => (r.ok ? r.json() : { samples: [] }))
            .catch(() => ({ samples: [] })),
        ),
      );

      const stateOf = (domain) => (state || []).find((s) => s.domain === domain);

      domainsBody.innerHTML = `<table class="domains">
        <thead><tr><th>Dominio</th><th>Estado</th><th>HTTP</th><th>Latencia</th><th>24 h</th><th>Certificado</th></tr></thead>
        <tbody>${domains
          .map((d, i) => {
            const st = stateOf(d.domain);
            const samples = histories[i].samples || [];
            const fails = samples.filter((s) => !s.ok).length;
            const okPct = samples.length ? (((samples.length - fails) / samples.length) * 100).toFixed(1) : null;
            const lat = statsOf(samples, (s) => s.latency_ms);
            return `<tr class="${d.ok ? 'ok' : 'down'}">
              <td>${escapeHtml(d.domain)}</td>
              <td>${
                d.ok
                  ? 'OK'
                  : `${escapeHtml(d.error || 'caído')}${st?.downSince ? `<br><small>desde ${fmtTime(st.downSince)}</small>` : ''}`
              }</td>
              <td>${d.status ?? '—'}</td>
              <td>${d.latency_ms ?? '—'} ms${lat ? `<br><small>media ${Math.round(lat.avg)} · máx ${Math.round(lat.max)}</small>` : ''}</td>
              <td class="spark-cell"><div class="spark-wrap tiny">${sparkline(samples, { accessor: (s) => s.latency_ms, height: 28 })}</div>${
                okPct !== null ? `<small class="${fails ? 'warn' : ''}">${okPct}% ok · ${fails} fallos</small>` : ''
              }</td>
              <td class="${d.cert_days !== null && d.cert_days <= (cfg().certWarnDays ?? 14) ? 'warn' : ''}" title="Aviso cuando quedan ${cfg().certWarnDays ?? 14} días o menos">${
                d.cert_days === null ? '—' : `${d.cert_days} días`
              }</td>
            </tr>`;
          })
          .join('')}</tbody>
      </table>`;
    } catch (err) {
      domainsBody.innerHTML = errorBox(`No se pudieron cargar los dominios: ${err.message}`);
    }
  }

  // ------------------------------------------------------------ seguridad

  async function renderSecurity() {
    if (currentView !== 'security') return;
    securityBody.innerHTML = '<div class="empty">Cargando…</div>';
    try {
      const [summary, recent] = await Promise.all([
        getJson(`/api/snort/summary?hours=${range.security}`),
        getJson('/api/snort?limit=200'),
      ]);
      const { health } = recent;
      // La tabla respeta el mismo rango que los recuadros de arriba.
      const since = Date.now() - range.security * 3600000;
      const alerts = (recent.alerts || []).filter((a) => a.ts >= since);

      const tiles = [
        ['Alertas', summary.n || 0, `últimas ${summary.hours} h`],
        ['Orígenes', summary.sources || 0, 'IPs distintas'],
        ['Lector del log', health?.following ? 'activo' : 'parado', health?.lastLineAt ? `última ${fmtRel(health.lastLineAt)}` : 'sin alertas aún'],
        ['Ignoradas', health?.ignored ?? 0, 'desde el arranque (redes propias)'],
      ];

      securityBody.innerHTML = `
        <div class="tiles">
          ${tiles
            .map(
              ([label, value, sub]) => `<div class="tile">
                <span class="tile-label">${escapeHtml(label)}</span>
                <span class="tile-value">${escapeHtml(String(value))}</span>
                <span class="tile-sub">${escapeHtml(sub)}</span>
              </div>`,
            )
            .join('')}
        </div>

        <div class="detail-grid">
          <section class="card">
            <h2>Orígenes más activos · ${summary.hours} h</h2>
            ${
              summary.topSources?.length
                ? `<table class="kv compact">${summary.topSources
                    .map(
                      (s) => `<tr>
                        <th>${escapeHtml(s.src)}</th>
                        <td><b>×${s.n}</b> · ${escapeHtml(s.last_msg || '')}<br><small>${fmtRel(s.last_ts)} · prioridad ${s.priority}${s.priority <= 1 ? ' (la más grave)' : ''}</small></td>
                      </tr>`,
                    )
                    .join('')}</table>`
                : '<div class="empty">Nada en este rango.</div>'
            }
          </section>

          <section class="card">
            <h2>Reglas más disparadas · ${summary.hours} h</h2>
            ${
              summary.topRules?.length
                ? `<table class="kv compact">${summary.topRules
                    .map(
                      (r) => `<tr>
                        <th title="Identificador de la regla de Snort (sid)">regla ${escapeHtml(r.sid)}</th>
                        <td><b>×${r.n}</b> · ${escapeHtml(r.msg || '')}<br><small>prioridad ${r.priority}</small></td>
                      </tr>`,
                    )
                    .join('')}</table>`
                : '<div class="empty">Nada en este rango.</div>'
            }
            <h2>Redes y reglas ignoradas</h2>
            <p class="dim-text">No se cuentan las alertas que vienen de ${escapeHtml((summary.ignoredCidrs || []).join(', '))} (Tailscale y redes privadas) ni las de las reglas ${escapeHtml((summary.ignoredSids || []).join(', '))}. El registro completo sigue en el disco del servidor.</p>
          </section>

          <section class="card wide">
            <h2>Últimas alertas · ${summary.hours} h</h2>
            ${
              alerts?.length
                ? `<table class="domains snort">
                    <thead><tr><th>Cuándo</th><th>Regla</th><th>Origen</th><th>Destino</th><th title="1 es la más grave">Prioridad</th></tr></thead>
                    <tbody>${alerts
                      .map(
                        (a) => `<tr class="${a.priority <= 1 ? 'down' : ''}">
                          <td>${fmtTime(a.ts)}</td>
                          <td>${escapeHtml(a.msg || '')}<br><small>regla ${escapeHtml(a.sid)}${a.classification ? ` · ${escapeHtml(a.classification)}` : ''}</small></td>
                          <td>${escapeHtml(a.src || '')}${a.srcPort ? `:${a.srcPort}` : ''}</td>
                          <td>${escapeHtml(a.dst || '')}${a.dstPort ? `:${a.dstPort}` : ''} <small>${escapeHtml(a.proto || '')}</small></td>
                          <td>${a.priority ?? '—'}</td>
                        </tr>`,
                      )
                      .join('')}</tbody>
                  </table>`
                : `<div class="empty">Sin alertas en las últimas ${summary.hours} h.</div>`
            }
          </section>
        </div>`;
    } catch (err) {
      securityBody.innerHTML = errorBox(`No se pudo cargar la seguridad: ${err.message}`);
    }
  }

  // ------------------------------------------------------------ logs

  function wsUrl(containerId) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/api/logs/${encodeURIComponent(containerId)}?tail=200`;
  }

  /**
   * Pausar congela la vista, no el stream: lo que llega se retiene y se vuelca
   * al reanudar, con un tope para no agotar la memoria en una pausa larga.
   */
  function appendLog(text, stream) {
    if (paused) {
      pauseBuffer.push([text, stream]);
      if (pauseBuffer.length > MAX_PAUSE_CHUNKS) pauseBuffer.shift();
      return;
    }
    writeLog(text, stream);
  }

  function flushPauseBuffer() {
    if (!pauseBuffer.length) return;
    const dropped = pauseBuffer.length === MAX_PAUSE_CHUNKS;
    const pending = pauseBuffer.splice(0, pauseBuffer.length);
    if (dropped) writeLog('[pausa larga: se perdio lo mas antiguo]\n', 'sys');
    for (const [text, stream] of pending) writeLog(text, stream);
  }

  function writeLog(text, stream) {
    const span = document.createElement('span');
    if (stream === 'stderr') span.className = 'stderr';
    if (stream === 'sys') span.className = 'sys';
    span.textContent = text;
    logView.appendChild(span);
    lineCount += (text.match(/\n/g) || []).length || (text ? 1 : 0);

    while (lineCount > MAX_LINES && logView.firstChild) {
      const first = logView.firstChild;
      const removed = (first.textContent.match(/\n/g) || []).length || 1;
      logView.removeChild(first);
      lineCount -= removed;
    }

    if (autoScrollEl.checked) logView.scrollTop = logView.scrollHeight;
  }

  /**
   * Cierre intencionado. El handler de `close` se registra con
   * `addEventListener` (no basta con `onclose = null`), asi que la marca le
   * dice que no reconecte: si no, al reabrir el mismo contenedor quedarian dos
   * sockets vivos y cada linea saldria duplicada.
   */
  function closeSocket() {
    clearTimeout(wsRetryTimer);
    if (socket) {
      socket.intentionalClose = true;
      socket.close();
      socket = null;
    }
  }

  function connectLogs(containerId) {
    const ws = new WebSocket(wsUrl(containerId));
    socket = ws;

    ws.addEventListener('open', () => {
      wsAttempt = 0;
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        appendLog(String(ev.data), 'stdout');
        return;
      }

      if (msg.type === 'log') appendLog(msg.text, msg.stream);
      else if (msg.type === 'ready') appendLog(`Conectado a los logs de ${msg.name || containerId}\n`, 'sys');
      else if (msg.type === 'error') appendLog(`Error: ${msg.message}\n`, 'stderr');
      else if (msg.type === 'end') appendLog('\n[el contenedor dejó de emitir logs]\n', 'sys');
    });

    /** Reconexión con backoff. */
    ws.addEventListener('close', () => {
      if (socket === ws) socket = null;
      if (ws.intentionalClose || wantLogsFor !== containerId) return;

      wsAttempt += 1;
      const delay = Math.min(1000 * 2 ** (wsAttempt - 1), 30000) + Math.random() * 1000;
      appendLog(`\n[desconectado — reintentando en ${Math.round(delay / 1000)} s]\n`, 'sys');
      wsRetryTimer = setTimeout(() => {
        if (wantLogsFor === containerId) connectLogs(containerId);
      }, delay);
    });

    // Sin handler de `error`: el navegador lo dispara y acto seguido `close`, y
    // el aviso util —con el reintento y su espera— lo da el de cierre. Tener los
    // dos escribia dos lineas en la vista por cada corte.
  }

  function openLogs(c) {
    selected = c;
    wantLogsFor = c.id;
    wsAttempt = 0;
    paused = false;
    btnPause.textContent = 'Pausar';
    btnPause.disabled = false;
    btnClear.disabled = false;
    navs.logs.classList.remove('hidden');
    navLogsSub.textContent = c.displayName;
    navs.logs.title = `Logs de ${c.displayName}`;
    logView.textContent = '';
    lineCount = 0;
    pauseBuffer.length = 0;
    renderList();
    closeSocket();
    setView('logs');

    appendLog('Conectando a los logs…\n', 'sys');
    connectLogs(c.id);
  }

  // ------------------------------------------------------------ PWA y push

  let swRegistration = null;
  let installPrompt = null;

  function urlBase64ToUint8Array(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
  }

  const pushSupported = () =>
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      swRegistration = await navigator.serviceWorker.register('/sw.js');
      await refreshAlertsButton();
    } catch (err) {
      console.warn('service worker no registrado:', err.message);
    }
  }

  async function currentSubscription() {
    if (!swRegistration || !pushSupported()) return null;
    try {
      return await swRegistration.pushManager.getSubscription();
    } catch {
      return null;
    }
  }

  async function refreshAlertsButton() {
    if (!window.isSecureContext) {
      alertsLabel.textContent = 'Alertas';
      btnAlerts.title = 'Para activar alertas en este dispositivo abre el monitor por HTTPS';
      btnAlerts.classList.remove('on');
      return;
    }
    if (!pushSupported()) {
      alertsLabel.textContent = 'Alertas';
      btnAlerts.title = 'Este navegador no soporta notificaciones push (en iPhone: añade primero la app a la pantalla de inicio)';
      btnAlerts.classList.remove('on');
      return;
    }
    const sub = await currentSubscription();
    const on = Boolean(sub) && Notification.permission === 'granted';
    btnAlerts.classList.toggle('on', on);
    alertsLabel.textContent = on ? 'Alertas activas' : 'Alertas';
    btnAlerts.title = on ? 'Alertas activas en este dispositivo (pulsa para desactivar)' : 'Activar alertas en este dispositivo';
  }

  async function enableAlerts() {
    if (!window.isSecureContext) {
      toast('Las alertas necesitan HTTPS: abre el monitor por su dirección https de la tailnet.', 'warn');
      return;
    }
    if (!pushSupported()) {
      toast('Este navegador no soporta push. En iPhone, añade la app a la pantalla de inicio y ábrela desde ahí.', 'warn');
      return;
    }
    if (!swRegistration) await registerServiceWorker();
    if (!swRegistration) {
      toast('No se pudo registrar el service worker.', 'warn');
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toast('Permiso de notificaciones denegado.', 'warn');
      return;
    }

    try {
      const keyRes = await fetch('/api/push/public-key');
      const { key, enabled } = await keyRes.json();
      if (!enabled || !key) throw new Error('push desactivado en el servidor');

      let sub = await swRegistration.pushManager.getSubscription();
      if (!sub) {
        sub = await swRegistration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key),
        });
      }

      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      await fetch('/api/push/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => null);

      toast('Alertas activadas en este dispositivo. Debería llegar una notificación de prueba.', 'ok');
    } catch (err) {
      toast(`No se pudieron activar: ${err.message}`, 'warn');
    }
    await refreshAlertsButton();
  }

  async function disableAlerts() {
    const sub = await currentSubscription();
    if (sub) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => null);
      await sub.unsubscribe().catch(() => null);
    }
    toast('Alertas desactivadas en este dispositivo.', 'info');
    await refreshAlertsButton();
  }

  btnAlerts.addEventListener('click', async () => {
    const sub = await currentSubscription();
    if (sub && Notification.permission === 'granted') await disableAlerts();
    else await enableAlerts();
  });

  window.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault();
    installPrompt = ev;
    btnInstall.classList.remove('hidden');
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    btnInstall.classList.add('hidden');
    toast('Instalado. Ábrelo desde el icono para activar las alertas.', 'ok');
  });

  btnInstall.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    btnInstall.classList.add('hidden');
  });

  // ------------------------------------------------------------ ajustes

  /**
   * Pestaña Ajustes. `settingsData` es lo que devuelve /api/settings; `draft`
   * guarda lo editado y aun no guardado (clave → valor en unidades del
   * servidor, o null = quitar el valor del panel). El borrador sobrevive a
   * cambiar de pestaña y al boton Refresh; solo «Descartar» o guardar lo vacian.
   */
  let settingsData = null;
  const draft = new Map();
  let settingsErrors = {};
  let restarting = false;

  const SOURCE_LABELS = { default: 'de serie', env: 'desde .env', panel: 'desde el panel' };

  async function jsonFetch(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  }

  const settingField = (key) => settingsData?.fields.find((f) => f.key === key);
  const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function fmtSettingValue(f, value) {
    if (value === null || value === undefined) return '—';
    if (Array.isArray(value)) return value.length ? value.join(', ') : '(vacío)';
    if (typeof value === 'boolean') return value ? 'sí' : 'no';
    if (typeof value === 'number') return `${value / (f.scale || 1)}${f.unit ? ` ${f.unit}` : ''}`;
    if (f.type === 'enum') return (f.options.find(([v]) => v === value) || [value, value])[1];
    return value === '' ? '(vacío)' : String(value);
  }

  /** Valor que se veria si se quita el del panel: el del .env o, si no hay, el defecto. */
  const baseOf = (f) => (f.envValue !== null && f.envValue !== undefined ? f.envValue : f.default);

  function settingInput(f) {
    const id = `set-${f.key.replace(/\./g, '-')}`;
    const pending = draft.has(f.key) ? draft.get(f.key) : undefined;
    // Marcado para quitar del panel: se ve ya el valor al que volvera.
    const current = pending === undefined ? f.value : pending === null ? baseOf(f) : pending;

    switch (f.type) {
      case 'bool':
        return `<label class="switch"><input type="checkbox" id="${id}" data-key="${f.key}" ${current ? 'checked' : ''} />
          <span>${current ? 'Sí' : 'No'}</span></label>`;
      case 'enum':
        return `<select id="${id}" data-key="${f.key}">${f.options
          .map(([v, label]) => `<option value="${escapeHtml(v)}" ${v === current ? 'selected' : ''}>${escapeHtml(label)}</option>`)
          .join('')}</select>`;
      case 'list':
        return `<textarea id="${id}" data-key="${f.key}" rows="${Math.min(Math.max(current.length + 1, 2), 8)}"
          spellcheck="false" placeholder="uno por línea">${escapeHtml(current.join('\n'))}</textarea>`;
      case 'secret':
        return `<input type="password" id="${id}" data-key="${f.key}" autocomplete="off" spellcheck="false"
          value="${escapeHtml(typeof pending === 'string' ? pending : '')}"
          placeholder="${f.set ? 'configurado · escribe para reemplazarlo' : 'sin configurar'}" />`;
      case 'string':
        return `<input type="text" id="${id}" data-key="${f.key}" spellcheck="false" value="${escapeHtml(current)}" />`;
      default: {
        const scale = f.scale || 1;
        const shown = typeof current === 'number' ? current / scale : current;
        return `<span class="set-num"><input type="number" inputmode="decimal" id="${id}" data-key="${f.key}"
          value="${escapeHtml(String(shown))}" min="${f.min / scale}" max="${f.max / scale}" step="${f.step || 1}" />
          ${f.unit ? `<span class="set-unit">${escapeHtml(f.unit)}</span>` : ''}</span>`;
      }
    }
  }

  function settingRow(f) {
    const id = `set-${f.key.replace(/\./g, '-')}`;
    const dirty = draft.has(f.key);
    // La etiqueta de origen solo cuando el valor NO es el de serie: menos ruido.
    const tags = [];
    if (f.source !== 'default') {
      tags.push(`<span class="set-tag src-${f.source}" title="Variable ${escapeHtml(f.env)}">${SOURCE_LABELS[f.source]}</span>`);
    }
    if (f.pendingRestart) tags.push('<span class="set-tag pending" title="Guardado, pero el monitor sigue con el valor anterior hasta reiniciar">pendiente de reinicio</span>');
    else if (f.apply === 'restart') tags.push('<span class="set-tag restart" title="Se aplica al reiniciar el monitor; el panel lo ofrece al guardar">requiere reinicio</span>');

    const base = f.type === 'secret' ? null : baseOf(f);
    const backTo = f.type === 'secret' ? 'al valor del .env (o a ninguno)' : `a ${fmtSettingValue(f, base)}`;
    const reset =
      f.source === 'panel' && draft.get(f.key) !== null
        ? `<button type="button" class="btn ghost set-reset" data-reset="${f.key}"
            title="Quitar lo guardado desde el panel y volver ${escapeHtml(backTo)}">${f.type === 'secret' ? 'Quitar' : 'Restablecer'}</button>`
        : '';
    const willReset = draft.get(f.key) === null
      ? `<p class="set-note">Al guardar se quita lo del panel y vuelve ${escapeHtml(backTo)}.</p>`
      : '';
    const hint = f.itemHelp || f.patternHelp || '';
    const formatHint = hint ? ` · ${/^formato/i.test(hint) ? '' : 'formato: '}${escapeHtml(hint)}` : '';
    const defaults =
      f.type === 'secret'
        ? formatHint
        : ` · de serie ${escapeHtml(fmtSettingValue(f, f.default))}${
            f.envValue !== null && f.envValue !== undefined ? ` · en .env ${escapeHtml(fmtSettingValue(f, f.envValue))}` : ''
          }${formatHint}`;
    const error = settingsErrors[f.key] ? `<p class="set-error">${escapeHtml(settingsErrors[f.key])}</p>` : '';

    return `<div class="set-field${dirty ? ' dirty' : ''}${error ? ' invalid' : ''}" data-field="${f.key}">
      <div class="set-head">
        <label for="${id}">${escapeHtml(f.label)}</label>
        <span class="set-tags">${tags.join('')}</span>
      </div>
      <div class="set-control">${settingInput(f)}${reset}</div>
      ${error}${willReset}
      <p class="set-help">${f.help ? `${escapeHtml(f.help)} ` : ''}<code>${escapeHtml(f.env)}</code>${defaults}</p>
    </div>`;
  }

  function paintSettings() {
    if (!settingsData) return;
    const cards = settingsData.groups
      .map((g) => {
        const fields = settingsData.fields.filter((f) => f.group === g.id);
        if (!fields.length) return '';
        const extra =
          g.id === 'telegram'
            ? `<div class="set-actions"><button type="button" class="btn" id="btn-telegram-test">Enviar prueba</button>
                <small>Usa lo escrito arriba; si está vacío, lo guardado.</small></div>`
            : '';
        return `<section class="card set-card"><h2>${escapeHtml(g.label)}</h2>${fields.map(settingRow).join('')}${extra}</section>`;
      })
      .join('');
    settingsBody.innerHTML = `<div class="settings-grid">${cards}</div>`;
    paintSettingsBar();
  }

  /**
   * Solo se reescribe si cambia: al pulsar Guardar, el campo pierde el foco y
   * dispara `change`; si la barra se rehiciera entre mousedown y mouseup, el
   * boton bajo el raton seria otro y el clic se perderia.
   */
  let settingsBarHtml = null;

  function paintSettingsBar() {
    const html = settingsBarContent();
    if (html === settingsBarHtml) return;
    settingsBarHtml = html;
    settingsBar.hidden = !html;
    settingsBar.innerHTML = html;
  }

  function settingsBarContent() {
    if (restarting) {
      return '<span class="set-bar-text">Reiniciando el monitor… vuelve en unos segundos.</span>';
    }
    const keys = [...draft.keys()];
    const needsRestart = keys.some((k) => settingField(k)?.apply === 'restart');
    if (keys.length) {
      return `
        <span class="set-bar-text"><b>${keys.length}</b> cambio${keys.length === 1 ? '' : 's'} sin guardar${
          needsRestart ? ' · alguno requiere reiniciar el monitor' : ''
        }</span>
        <span class="set-bar-actions">
          <button type="button" class="btn ghost" data-act="discard">Descartar</button>
          ${needsRestart ? '<button type="button" class="btn" data-act="save">Guardar sin reiniciar</button>' : ''}
          <button type="button" class="btn primary" data-act="${needsRestart ? 'save-restart' : 'save'}">${
            needsRestart ? 'Guardar y reiniciar' : 'Guardar'
          }</button>
        </span>`;
    }
    if (settingsData?.restartPending) {
      return `
        <span class="set-bar-text">Hay ajustes guardados que esperan un reinicio para aplicarse.</span>
        <span class="set-bar-actions"><button type="button" class="btn primary" data-act="restart">Reiniciar ahora</button></span>`;
    }
    return '';
  }

  async function renderSettings() {
    if (currentView !== 'settings' || restarting) return;
    if (!settingsData) settingsBody.innerHTML = '<div class="empty">Cargando…</div>';
    try {
      const { ok, body } = await jsonFetch('/api/settings');
      if (!ok) throw new Error(body.error || 'no se pudieron leer los ajustes');
      settingsData = body;
      paintSettings();
    } catch (err) {
      settingsBody.innerHTML = `<div class="empty">No se pudieron cargar los ajustes: ${escapeHtml(err.message)}</div>`;
    }
  }

  /** Lee el control y lo pasa a unidades del servidor. Devuelve undefined si no hay cambio. */
  function readSettingInput(f, input) {
    switch (f.type) {
      case 'bool':
        return input.checked;
      case 'enum':
        return input.value;
      case 'list':
        return input.value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      case 'secret':
        return input.value.trim() || undefined;
      case 'string':
        return input.value.trim();
      default: {
        const raw = input.value.trim();
        const n = Number(raw);
        if (raw === '' || !Number.isFinite(n)) return raw; // que lo rechace el servidor con su motivo
        const v = n * (f.scale || 1);
        return f.type === 'int' ? Math.round(v) : Math.round(v * 1000) / 1000;
      }
    }
  }

  function onSettingInput(ev) {
    const input = ev.target.closest('[data-key]');
    if (!input) return;
    const f = settingField(input.dataset.key);
    if (!f) return;

    const value = readSettingInput(f, input);
    if (value === undefined || (f.type !== 'secret' && sameValue(value, f.value))) draft.delete(f.key);
    else draft.set(f.key, value);

    delete settingsErrors[f.key];
    const row = input.closest('.set-field');
    row.classList.toggle('dirty', draft.has(f.key));
    row.classList.remove('invalid');
    row.querySelector('.set-error')?.remove();
    if (f.type === 'bool') input.nextElementSibling.textContent = input.checked ? 'Sí' : 'No';
    paintSettingsBar();
  }

  async function saveSettings({ restart = false } = {}) {
    const changes = Object.fromEntries(draft);
    let restartAfterSave = false;
    settingsBar.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      const { ok, body } = await jsonFetch('/api/settings', { method: 'PUT', body: JSON.stringify({ changes }) });
      if (!ok) {
        settingsErrors = body.errors || {};
        paintSettings();
        toast(body.errors ? 'Hay valores no válidos: revisa los campos en rojo.' : body.error || 'No se pudo guardar', 'warn');
        return;
      }
      draft.clear();
      settingsErrors = {};
      settingsData = body.settings;
      paintSettings();
      if (body.restartRequired) {
        if (!restart) toast('Guardado. Algunos cambios se aplicarán al reiniciar el monitor.', 'ok');
        restartAfterSave = restart;
      } else {
        toast(body.changed.length ? 'Guardado y aplicado al momento.' : 'No había nada que cambiar.', 'ok');
      }
    } catch (err) {
      toast(`No se pudo guardar: ${err.message}`, 'warn');
    } finally {
      // Los botones quedaron deshabilitados: forzar el repintado aunque el texto no cambie.
      settingsBarHtml = null;
      paintSettingsBar();
    }
    // Fuera del try: un fallo al reiniciar no debe decir "no se pudo guardar".
    if (restartAfterSave) await restartMonitor();
  }

  /** Pide el reinicio y espera a que vuelva un proceso nuevo (uptime menor que lo esperado). */
  async function restartMonitor() {
    const askedAt = Date.now();
    let res;
    try {
      res = await jsonFetch('/api/settings/restart', { method: 'POST', body: '{}' });
    } catch (err) {
      toast(`No se pudo pedir el reinicio: ${err.message}`, 'warn');
      return;
    }
    if (!res.ok) {
      toast(`El monitor rechazó el reinicio: ${res.body.error || `HTTP ${res.status}`}`, 'warn');
      return;
    }
    restarting = true;
    renderConnLine();
    paintSettingsBar();
    const deadline = askedAt + 90000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const r = await fetch('/api/health', { cache: 'no-store' });
        const h = await r.json();
        // Un proceso nuevo tiene menos uptime que el tiempo transcurrido. `ok` no
        // cuenta aqui: puede ser false por otro motivo (Snort, Docker) y el
        // reinicio haber ido bien igualmente.
        if (Number.isFinite(h.uptimeSec) && h.uptimeSec * 1000 < Date.now() - askedAt) {
          restarting = false;
          const warn = h.problems?.length ? ` Avisa de: ${h.problems.join(' · ')}.` : '';
          toast(`Monitor reiniciado (v${h.version}). Ajustes aplicados.${warn}`, warn ? 'warn' : 'ok');
          pollFailures = 0;
          lastError = null;
          loadOverview();
          renderSettings();
          return;
        }
      } catch {
        /* todavia arrancando */
      }
    }
    restarting = false;
    paintSettingsBar();
    renderConnLine();
    toast('El monitor no ha vuelto en 90 s. En el servidor: docker compose logs monitor', 'warn');
  }

  async function testTelegram(button) {
    const token = draft.get('telegram.token');
    const chatId = draft.get('telegram.chatId');
    button.disabled = true;
    try {
      const { body } = await jsonFetch('/api/settings/telegram-test', {
        method: 'POST',
        body: JSON.stringify({ token: token || '', chatId: chatId || '' }),
      });
      toast(body.ok ? 'Mensaje de prueba enviado: mira Telegram.' : `Telegram no lo aceptó: ${body.error}`, body.ok ? 'ok' : 'warn');
    } catch (err) {
      toast(`No se pudo probar: ${err.message}`, 'warn');
    } finally {
      button.disabled = false;
    }
  }

  settingsBody.addEventListener('input', onSettingInput);
  settingsBody.addEventListener('change', onSettingInput);
  settingsBody.addEventListener('click', (ev) => {
    const reset = ev.target.closest('[data-reset]');
    if (reset) {
      draft.set(reset.dataset.reset, null);
      delete settingsErrors[reset.dataset.reset];
      paintSettings();
      return;
    }
    const test = ev.target.closest('#btn-telegram-test');
    if (test) testTelegram(test);
  });
  settingsBar.addEventListener('click', (ev) => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'discard') {
      if (draft.size && !window.confirm(`¿Descartar ${draft.size} cambio${draft.size === 1 ? '' : 's'} sin guardar?`)) return;
      draft.clear();
      settingsErrors = {};
      paintSettings();
    } else if (act === 'save') saveSettings();
    else if (act === 'save-restart') {
      if (!window.confirm('Se guardarán los cambios y el monitor se reiniciará (unos 10 segundos sin vigilancia). ¿Continuar?')) return;
      saveSettings({ restart: true });
    } else if (act === 'restart') {
      if (!window.confirm('El monitor se reiniciará para aplicar los ajustes pendientes (unos 10 segundos sin vigilancia). ¿Continuar?')) return;
      restartMonitor();
    }
  });
  window.addEventListener('beforeunload', (ev) => {
    if (draft.size) ev.preventDefault();
  });

  // ------------------------------------------------------------ eventos UI

  navs.containers.addEventListener('click', () => {
    wantLogsFor = null;
    closeSocket();
    // Al volver a la lista se deja el contenedor: sus pestañas Detalle y Logs se van con el.
    selected = null;
    navs.detail.classList.add('hidden');
    navs.logs.classList.add('hidden');
    setView('containers');
  });
  navs.host.addEventListener('click', () => setView('host'));
  navs.events.addEventListener('click', () => setView('events'));
  navs.domains.addEventListener('click', () => setView('domains'));
  navs.security.addEventListener('click', () => setView('security'));
  navs.settings.addEventListener('click', () => setView('settings'));
  navs.detail.addEventListener('click', () => {
    if (selected) openDetail(selected);
  });
  navs.logs.addEventListener('click', () => {
    if (selected) openLogs(selected);
  });

  filterEl.addEventListener('input', renderList);
  onlyProblemsEl.addEventListener('change', renderList);
  eventFilterEl.addEventListener('input', paintEvents);
  onlyNotifiedEl.addEventListener('change', paintEvents);
  eventSevChips.addEventListener('click', (ev) => {
    const chip = ev.target.closest('[data-sev]');
    if (!chip) return;
    eventSeverity = chip.dataset.sev;
    for (const c of eventSevChips.querySelectorAll('.chip')) {
      c.classList.toggle('active', c === chip);
      c.setAttribute('aria-pressed', String(c === chip));
    }
    paintEvents();
  });

  btnRefresh.addEventListener('click', () => {
    pollFailures = 0;
    // Señal de que ha hecho algo: el icono gira y la cabecera pasa a "hace 0 s".
    btnRefresh.classList.add('busy');
    setTimeout(() => btnRefresh.classList.remove('busy'), 900);
    loadOverview();
    if (currentView === 'events') renderEvents();
    if (currentView === 'domains') renderDomains();
    if (currentView === 'security') renderSecurity();
    if (currentView === 'settings') renderSettings();
  });

  btnPause.addEventListener('click', () => {
    paused = !paused;
    btnPause.textContent = paused ? 'Reanudar' : 'Pausar';
    if (!paused) flushPauseBuffer();
  });

  btnClear.addEventListener('click', () => {
    logView.textContent = '';
    lineCount = 0;
    pauseBuffer.length = 0;
  });

  window.addEventListener('hashchange', () => {
    if (!firstLoad) applyHash();
  });

  // Al volver a la app (movil), refrescar sin esperar al siguiente sondeo.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      pollFailures = 0;
      loadOverview();
    }
  });

  setView('containers');
  loadOverview();
  registerServiceWorker();
})();
