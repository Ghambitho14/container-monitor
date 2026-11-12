'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers').isolatedEnv({ ALERT_MUTE_CONTAINERS: 'coolify-sentinel, worker-*' });

const config = require('../server/config');
const { isMuted } = require('../server/watcher');
const { SCHEMA } = require('../server/settings');

test('ALERT_MUTE_CONTAINERS llega a config como lista', () => {
  assert.deepEqual(config.containers.mute, ['coolify-sentinel', 'worker-*']);
});

test('silencia por nombre del panel o de Docker, con * y sin importar mayusculas', () => {
  // El panel lo llama "sentinel"; Docker, "coolify-sentinel" (a veces con "/" delante).
  assert.equal(isMuted(['sentinel', 'coolify-sentinel']), true);
  assert.equal(isMuted(['sentinel', '/Coolify-Sentinel']), true);
  assert.equal(isMuted(['worker-7']), true);
  assert.equal(isMuted(['sentinel']), false, 'solo el nombre del panel no basta si la lista trae el de Docker');
  assert.equal(isMuted(['coolify']), false);
  assert.equal(isMuted([]), false);
  assert.equal(isMuted(['coolify-sentinel'], []), false, 'lista vacía = nada silenciado');
  assert.equal(isMuted(['a.b'], ['a.b']), true);
  assert.equal(isMuted(['axb'], ['a.b']), false, 'el punto es literal');
});

test('el ajuste se aplica en vivo y valida los nombres', () => {
  const field = SCHEMA.find((f) => f.key === 'containers.mute');
  assert.equal(field.apply, 'live');
  assert.equal(field.itemValid('coolify-sentinel'), true);
  assert.equal(field.itemValid('worker-*'), true);
  assert.equal(field.itemValid('mal nombre'), false);
});
