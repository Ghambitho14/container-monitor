'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers').isolatedEnv({ SNORT_IGNORE_CIDRS: '100.64.0.0/10,127.0.0.0/8', SNORT_IGNORE_SIDS: '1000001' });

const snort = require('../server/snort');

const LINE =
  '09/07-18:30:22.845888  [**] [1:1000003:1] FUERZA BRUTA SSH [**] [Priority: 0] {TCP} 1.2.3.4:62328 -> 100.100.100.100:22';

test('parseLine entiende el formato fast de Snort', () => {
  const a = snort.parseLine(LINE);
  assert.ok(a);
  assert.equal(a.sid, '1000003');
  assert.equal(a.msg, 'FUERZA BRUTA SSH');
  assert.equal(a.priority, 0);
  assert.equal(a.proto, 'TCP');
  assert.equal(a.src, '1.2.3.4');
  assert.equal(a.srcPort, 62328);
  assert.equal(a.dst, '100.100.100.100');
  assert.equal(a.dstPort, 22);
  assert.equal(a.classification, null);
  const d = new Date(a.ts);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 7);
  assert.equal(d.getHours(), 18);
});

test('parseLine acepta Classification y líneas sin puerto (ICMP)', () => {
  const a = snort.parseLine(
    '10/13-05:37:01.000001  [**] [1:2657:1] WEB-MISC SSLv2 Client_Hello [**] [Classification: Web Application Attack] [Priority: 1] {TCP} 198.51.100.20:5555 -> 203.0.113.10:443',
  );
  assert.equal(a.classification, 'Web Application Attack');
  assert.equal(a.priority, 1);
  const icmp = snort.parseLine('10/13-05:37:01.000001  [**] [1:1000001:1] PING [**] [Priority: 0] {ICMP} 8.8.8.8 -> 203.0.113.10');
  assert.equal(icmp.proto, 'ICMP');
  assert.equal(icmp.srcPort, null);
  assert.equal(icmp.dstPort, null);
});

test('parseLine devuelve null ante basura', () => {
  assert.equal(snort.parseLine(''), null);
  assert.equal(snort.parseLine('Commencing packet processing'), null);
});

test('isIgnoredSource aplica la allowlist por CIDR', () => {
  assert.equal(snort.isIgnoredSource('100.100.100.100'), true); // Tailscale
  assert.equal(snort.isIgnoredSource('100.127.255.255'), true);
  assert.equal(snort.isIgnoredSource('100.128.0.1'), false); // justo fuera del /10
  assert.equal(snort.isIgnoredSource('127.0.0.1'), true);
  assert.equal(snort.isIgnoredSource('8.8.8.8'), false);
  assert.equal(snort.isIgnoredSource('2001:db8::1'), false); // IPv6 no se filtra
});
