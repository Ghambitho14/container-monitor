'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers').isolatedEnv();

const push = require('../server/push');

test('con PUSH_ENABLED=false no hay claves ni suscriptores', () => {
  assert.equal(push.enabled, false);
  assert.equal(push.publicKey(), null);
  assert.equal(push.hasSubscribers(), false);
  assert.throws(() => push.subscribe({}), /desactivado/);
});

test('fromEvent agrupa por contenedor y tipo y enlaza a la ficha', () => {
  const p = push.fromEvent({
    ts: 1, kind: 'container_down', name: 'web', containerId: 'abc', detail: 'Exited (1)', severity: 'crit',
  });
  assert.equal(p.tag, 'abc:container_down');
  assert.equal(p.url, '/#container=abc');
  assert.equal(p.body, 'Exited (1)');
  assert.equal(p.severity, 'crit');

  const h = push.fromEvent({ ts: 2, kind: 'host_disk', name: 'host', severity: 'warn' });
  assert.equal(h.tag, 'host:host_disk');
  assert.equal(h.url, '/#events');
  assert.equal(h.body, 'host_disk');
});

test('fromSummary usa la peor severidad y corta en 6 líneas', () => {
  const events = [
    { kind: 'container_new', name: 'a', severity: 'info' },
    { kind: 'container_down', name: 'b', severity: 'crit' },
    ...Array.from({ length: 5 }, (_, i) => ({ kind: 'container_gone', name: `g${i}`, severity: 'warn' })),
  ];
  const p = push.fromSummary(events);
  assert.equal(p.severity, 'crit');
  assert.equal(p.tag, 'summary');
  assert.equal(p.body.split('\n').length, 7); // 6 líneas + «… y 1 mas»
  assert.match(p.body, /… y 1 mas$/);
});
