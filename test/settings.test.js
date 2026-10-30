'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
require('./helpers').isolatedEnv({
  ALERT_DISK_PCT: '80',
  ALERT_LOAD_PER_CPU: 'abc', // ilegible → cae al defecto
  DIGEST_ENABLED: 'no',
  DOMAIN_EXTRA: 'api.example.com/auth/v1/.well-known/jwks.json, example.com',
});

const settings = require('../server/settings');
const config = require('../server/config');

test('build aplica defecto → .env con la interpretación de cada tipo', () => {
  assert.equal(config.thresholds.diskPct, 80); // .env
  assert.equal(config.thresholds.memPct, 90); // defecto
  assert.equal(config.thresholds.loadPerCpu, 2); // ilegible cae al defecto
  assert.equal(config.digest.enabled, false); // 'no' no es true
  assert.equal(config.push.enabled, false);
  assert.deepEqual(config.domains.extra, ['api.example.com/auth/v1/.well-known/jwks.json', 'example.com']);
});

test('describe nunca devuelve el token y marca el origen de cada valor', () => {
  const d = settings.describe();
  const token = d.fields.find((f) => f.key === 'telegram.token');
  assert.equal(token.type, 'secret');
  assert.equal('value' in token, false);
  assert.equal(token.set, false);
  const disk = d.fields.find((f) => f.key === 'thresholds.diskPct');
  assert.equal(disk.source, 'env');
  assert.equal(disk.value, 80);
  assert.equal(disk.envValue, 80);
  assert.equal(d.fields.find((f) => f.key === 'thresholds.memPct').source, 'default');
  assert.equal(d.restartPending, false);
});

test('save valida todo o nada y no escribe si algo falla', () => {
  const r = settings.save({ 'thresholds.diskPct': 70, 'thresholds.memPct': 'mucho', 'no.existe': 1 });
  assert.equal(r.ok, false);
  assert.match(r.errors['thresholds.memPct'], /número/);
  assert.equal(r.errors['no.existe'], 'ajuste desconocido');
  assert.equal(fs.existsSync(settings.FILE), false);
  assert.equal(config.thresholds.diskPct, 80);
});

test('save aplica en caliente los ajustes live y escribe settings.json', () => {
  const r = settings.save({ 'thresholds.diskPct': 70 });
  assert.equal(r.ok, true);
  assert.equal(r.changed.length, 1);
  assert.equal(r.restartRequired, false);
  assert.equal(config.thresholds.diskPct, 70);
  const written = JSON.parse(fs.readFileSync(settings.FILE, 'utf8'));
  assert.deepEqual(written.values, { 'thresholds.diskPct': 70 });
  assert.equal(settings.describe().fields.find((f) => f.key === 'thresholds.diskPct').source, 'panel');

  // null quita el ajuste del panel y vuelve al valor del .env.
  const back = settings.save({ 'thresholds.diskPct': null });
  assert.equal(back.ok, true);
  assert.equal(config.thresholds.diskPct, 80);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings.FILE, 'utf8')).values, {});
  assert.equal(fs.existsSync(`${settings.FILE}.prev`), true);
});

test('un ajuste restart se guarda pero no se aplica hasta reiniciar', () => {
  const r = settings.save({ 'watch.intervalMs': 30000 });
  assert.equal(r.ok, true);
  assert.equal(r.restartRequired, true);
  assert.equal(config.watch.intervalMs, 20000); // el proceso sigue con el viejo
  const field = settings.describe().fields.find((f) => f.key === 'watch.intervalMs');
  assert.equal(field.pendingRestart, true);
  assert.equal(settings.saved('watch.intervalMs'), 30000);
  assert.match(settings.describeChange(r.changed[0]), /^WATCH_INTERVAL_MS (20 s|20000) → (30 s|30000)$/);
});

test('describeChange no revela secretos', () => {
  const field = settings.SCHEMA.find((f) => f.key === 'telegram.token');
  assert.equal(settings.describeChange({ field, before: '', after: '123456:abc' }), 'TELEGRAM_BOT_TOKEN (cambiado)');
});
