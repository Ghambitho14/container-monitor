'use strict';
/**
 * Prueba de humo del servidor entero: lo arranca en un puerto libre con todo lo
 * externo desactivado (Docker inalcanzable, sin Telegram, sin push, sin Snort)
 * y comprueba por HTTP lo que no se puede probar importando index.js (escucha
 * el puerto al cargarse).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Peticion HTTP cruda por socket: para el upgrade de WebSocket y cabeceras raras. */
function rawRequest(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let out = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('timeout')));
    socket.on('connect', () => socket.write(text));
    socket.on('data', (d) => {
      out += d.toString('utf8');
      if (/\r\n\r\n/.test(out)) socket.end();
    });
    socket.on('close', () => resolve(out));
    socket.on('error', reject);
  });
}

let child;
let port;
let logs = '';

test.before(async () => {
  port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-smoke-'));
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      DOCKER_HOST: 'tcp://127.0.0.1:1',
      PUSH_ENABLED: 'false',
      SNORT_ENABLED: 'false',
      DOCKER_EVENTS_ENABLED: 'false',
      DIGEST_ENABLED: 'false',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_CHAT_ID: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.status === 200) return;
    } catch {
      /* todavia no escucha */
    }
    await sleep(250);
  }
  throw new Error(`el servidor no arranco:\n${logs}`);
});

test.after(() => {
  if (child && child.exitCode === null) child.kill();
});

const alive = () => child.exitCode === null && !child.killed;

test('/api/health responde con la version de package.json', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(res.status, 200);
  const h = await res.json();
  assert.equal(h.version, VERSION);
  assert.equal(h.service, 'container-monitor');
  assert.equal(h.components.telegram.enabled, false);
});

test('las escrituras sin Origin reciben 403 (restart, settings, push)', async () => {
  const post = (p, body = {}) =>
    fetch(`http://127.0.0.1:${port}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal((await post('/api/settings/restart')).status, 403);
  assert.equal((await post('/api/push/subscribe', { endpoint: 'https://x' })).status, 403);
  assert.equal((await post('/api/push/unsubscribe', { endpoint: 'https://x' })).status, 403);
  const put = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ changes: {} }),
  });
  assert.equal(put.status, 403);
  // Sin JSON ni siquiera llega a mirar el origen.
  const noJson = await fetch(`http://127.0.0.1:${port}/api/settings/restart`, { method: 'POST' });
  assert.equal(noJson.status, 415);
  assert.ok(alive());
});

test('con Origin igual al host, PUT /api/settings funciona y guarda en DATA_DIR', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ changes: { 'thresholds.diskPct': 77 } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.changed, ['thresholds.diskPct']);
  const host = await (await fetch(`http://127.0.0.1:${port}/api/host`)).json();
  assert.equal(host.thresholds.diskPct, 77);
});

test('una URL malformada en el WebSocket de logs devuelve 400 y NO tumba el proceso', async () => {
  const upgrade = (target, host = '127.0.0.1') =>
    rawRequest(
      port,
      `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
  assert.match(await upgrade('/api/logs/%ZZ'), /^HTTP\/1\.1 400/);
  assert.match(await upgrade('/api/logs/abc', '[::1'), /^HTTP\/1\.1 400/);
  assert.match(await upgrade('/otra/cosa'), /^HTTP\/1\.1 404/);
  assert.match(await upgrade('/api/logs/..%2F..'), /^HTTP\/1\.1 400/);
  await sleep(200);
  assert.ok(alive(), `el proceso murio:\n${logs}`);
  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(res.status, 200);
});

test('/api/containers/:id/logs rechaza ids raros y responde 502 si Docker no esta', async () => {
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/containers/a%20b/logs`)).status, 400);
  const res = await fetch(`http://127.0.0.1:${port}/api/containers/api/logs?since=abc&tail=99999`);
  assert.equal(res.status, 502);
  assert.ok((await res.json()).error);
  assert.ok(alive());
});

test('/api/events acepta los filtros y responde aunque Docker no este', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/events?severity=crit&limit=5&notified=1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.events));
  assert.ok(body.events.every((e) => e.severity === 'crit'));
});

test('/api/events?after= devuelve lo posterior en orden y rechaza un cursor invalido', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/events?after=0&limit=5`);
  assert.equal(res.status, 200);
  const { events } = await res.json();
  assert.ok(Array.isArray(events));
  assert.ok(events.every((e, i) => i === 0 || e.id > events[i - 1].id));
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/events?after=-1`)).status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/events?after=abc`)).status, 400);
});
