'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers').isolatedEnv();

const db = require('../server/db');

const base = Date.now() - 60000;
const seed = [
  ['crit', 'container_down', true],
  ['info', 'container_up', false],
  ['warn', 'host_load', true],
  ['crit', 'domain_down', false],
  ['info', 'container_new', true],
  ['crit', 'container_oom', true],
];

test('queryEvents filtra en la consulta, antes del LIMIT', () => {
  const ids = seed.map(([severity, kind, notified], i) =>
    db.insertEvent({ ts: base + i * 1000, name: `c${i}`, kind, severity, notified }),
  );
  assert.equal(ids.length, 6);
  assert.ok(ids.every((id) => Number.isInteger(id)));

  const all = db.queryEvents({ limit: 100 });
  assert.equal(all.length, 6);
  assert.equal(all[0].kind, 'container_oom'); // mas reciente primero

  // Los 2 ultimos criticos de verdad, no los criticos entre los 2 ultimos eventos.
  const crit = db.queryEvents({ severity: 'crit', limit: 2 });
  assert.deepEqual(crit.map((e) => e.kind), ['container_oom', 'domain_down']);

  const sent = db.queryEvents({ notified: true, limit: 100 });
  assert.deepEqual(sent.map((e) => e.kind), ['container_oom', 'container_new', 'host_load', 'container_down']);

  const critSent = db.queryEvents({ severity: 'crit', notified: true, limit: 100 });
  assert.deepEqual(critSent.map((e) => e.kind), ['container_oom', 'container_down']);

  const recent = db.queryEvents({ since: base + 4000, limit: 100 });
  assert.deepEqual(recent.map((e) => e.kind), ['container_oom', 'container_new']);
});

test('markNotified corrige el campo cuando ningun canal entrego el aviso', () => {
  const id = db.insertEvent({ ts: Date.now(), name: 'x', kind: 'container_down', severity: 'crit', notified: true });
  assert.equal(db.queryEvents({ limit: 1 })[0].notified, 1);
  db.markNotified(id, false);
  assert.equal(db.queryEvents({ limit: 1 })[0].notified, 0);
});
