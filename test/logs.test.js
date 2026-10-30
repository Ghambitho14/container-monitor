'use strict';
/**
 * readLogs contra un Docker falso: un contenedor sin TTY (stdout/stderr
 * multiplexados) y otro con TTY (texto plano), y que pase `since` y `tail`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { isolatedEnv } = require('./helpers');

function frame(type, text) {
  const body = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

const CONTAINERS = {
  api: { tty: false, body: Buffer.concat([frame(1, 'arranco\n'), frame(2, 'Error: boom\n'), frame(1, 'listo\n')]) },
  web: { tty: true, body: Buffer.from('GET / 200\nGET /x 500\n') },
};

let server;
let lastQuery;
let readLogs;

test.before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://docker');
    const match = url.pathname.match(/\/containers\/([^/]+)\/(json|logs)$/);
    const c = match && CONTAINERS[match[1]];
    if (!c) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: 'No such container' }));
    }
    if (match[2] === 'json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ Config: { Tty: c.tty } }));
    }
    lastQuery = url.searchParams;
    res.writeHead(200, { 'content-type': c.tty ? 'application/vnd.docker.raw-stream' : 'application/vnd.docker.multiplexed-stream' });
    res.end(c.body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  isolatedEnv({ DOCKER_HOST: `tcp://127.0.0.1:${server.address().port}` });
  ({ readLogs } = require('../server/docker'));
});

test.after(() => server.close());

test('sin TTY junta stdout y stderr en lineas y manda since y tail', async () => {
  const lines = await readLogs('api', { since: 1700000000, tail: 50 });
  assert.deepEqual(lines, ['arranco', 'Error: boom', 'listo']);
  assert.equal(lastQuery.get('since'), '1700000000');
  assert.equal(lastQuery.get('tail'), '50');
  assert.notEqual(lastQuery.get('follow'), 'true');
});

test('con TTY lee el texto tal cual', async () => {
  assert.deepEqual(await readLogs('web'), ['GET / 200', 'GET /x 500']);
});

test('un contenedor que no existe falla con 404', async () => {
  await assert.rejects(readLogs('nada'), (err) => err.statusCode === 404);
});
