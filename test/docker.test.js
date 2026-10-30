'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers').isolatedEnv();

const { isValidContainerId, parseHealth, demuxDockerLogs } = require('../server/docker');

test('isValidContainerId acepta ids y nombres de Docker y rechaza rutas', () => {
  assert.equal(isValidContainerId('9b5dda9dce18'), true);
  assert.equal(isValidContainerId('container-monitor'), true);
  assert.equal(isValidContainerId('a'.repeat(64)), true);
  assert.equal(isValidContainerId('a'.repeat(65)), false);
  assert.equal(isValidContainerId(''), false);
  assert.equal(isValidContainerId('../etc'), false);
  assert.equal(isValidContainerId('a b'), false);
  assert.equal(isValidContainerId(123), false);
});

test('parseHealth saca la salud del texto de Status', () => {
  assert.equal(parseHealth('Up 20 hours (healthy)'), 'healthy');
  assert.equal(parseHealth('Up 2 minutes (unhealthy)'), 'unhealthy');
  assert.equal(parseHealth('Up 3 seconds (health: starting)'), 'starting');
  assert.equal(parseHealth('Up 2 days'), null);
  assert.equal(parseHealth(undefined), null);
});

function frame(type, text) {
  const body = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

test('demuxDockerLogs separa stdout y stderr y devuelve el resto incompleto', () => {
  const chunks = [];
  const full = Buffer.concat([frame(1, 'hola\n'), frame(2, 'error\n')]);
  const pending = frame(1, 'incompleto');
  const rest = demuxDockerLogs(Buffer.concat([full, pending.subarray(0, 12)]), (c) => chunks.push(c));
  assert.deepEqual(chunks, [
    { stream: 'stdout', text: 'hola\n' },
    { stream: 'stderr', text: 'error\n' },
  ]);
  assert.equal(rest.length, 12);

  // Al llegar el resto, el frame pendiente se completa.
  const more = [];
  const rest2 = demuxDockerLogs(Buffer.concat([rest, pending.subarray(12)]), (c) => more.push(c));
  assert.deepEqual(more, [{ stream: 'stdout', text: 'incompleto' }]);
  assert.equal(rest2.length, 0);
});
