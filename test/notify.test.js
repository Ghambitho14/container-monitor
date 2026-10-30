'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers').isolatedEnv();

const notify = require('../server/notify');

test('sin credenciales el canal queda desactivado', () => {
  assert.equal(notify.enabled, false);
});

test('escapeHtml neutraliza lo que Telegram interpretaría como HTML', () => {
  assert.equal(notify.escapeHtml('<b>&"x"</b>'), '&lt;b&gt;&amp;"x"&lt;/b&gt;');
  assert.equal(notify.escapeHtml(null), '');
});

test('labelFor elige etiqueta por tipo de evento', () => {
  assert.equal(notify.labelFor('container_down'), notify.LABELS.down);
  assert.equal(notify.labelFor('host_disk_ok'), notify.LABELS.ok);
  assert.equal(notify.labelFor('host_disk'), notify.LABELS.host);
  assert.equal(notify.labelFor('monitor_docker_unreachable'), notify.LABELS.monitor);
  assert.equal(notify.labelFor('algo_raro'), '[AVISO]');
});

test('formatEvent escapa el nombre y el detalle', () => {
  const text = notify.formatEvent({ kind: 'container_down', name: 'web<1>', detail: 'Exited (137) & OOM' });
  assert.equal(text, `${notify.LABELS.down} <b>web&lt;1&gt;</b>\nExited (137) &amp; OOM`);
  assert.equal(notify.formatEvent({ kind: 'host_cpu' }), `${notify.LABELS.host} <b>host</b>`);
});

test('formatSummary corta en 20 líneas y cuenta el resto', () => {
  const events = Array.from({ length: 25 }, (_, i) => ({ kind: 'container_new', name: `c${i}`, detail: 'nuevo' }));
  const text = notify.formatSummary(events);
  assert.match(text, /<b>25 cambios a la vez<\/b>/);
  assert.equal(text.split('\n').filter((l) => l.includes(' — ')).length, 20);
  assert.match(text, /… y 5 mas$/);
});
