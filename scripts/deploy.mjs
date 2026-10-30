#!/usr/bin/env node
/**
 * Despliega la copia local del monitor en el VPS, con vuelta atrás.
 *
 *   npm run deploy:baseline      guarda la huella (MD5) de lo que hay hoy en el servidor
 *   npm run deploy               tests → ¿alguien editó en el servidor? → copia en
 *                                /root/backups → subir → rebuild → esperar /api/health
 *                                → si no vuelve sano, restaurar la copia
 *   npm run deploy -- --dry-run  enseña qué cambiaría sin tocar el servidor
 *
 * Opciones: --force (sigue aunque el servidor tenga cambios sin huella), --skip-tests,
 * --no-rollback, --wait=120 (segundos de espera a /api/health; 90 por defecto).
 * Variables, en el entorno o en `.env.deploy` (ignorado por git): MONITOR_SSH
 * (obligatoria, p. ej. root@100.64.0.1), MONITOR_REMOTE_DIR (/opt/monitoring/container-monitor).
 *
 * Nunca toca `.env` ni `data/` del servidor.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_ENV = path.join(ROOT, '.env.deploy');
if (existsSync(LOCAL_ENV)) process.loadEnvFile(LOCAL_ENV);
const HOST = process.env.MONITOR_SSH;
const REMOTE = process.env.MONITOR_REMOTE_DIR || '/opt/monitoring/container-monitor';
const BACKUP_ROOT = '/root/backups';
const HEALTH_URL = 'http://127.0.0.1:3000/api/health';
const MANIFEST = path.join(ROOT, 'deploy', 'last-deployed.md5');
const TAR = path.join(ROOT, 'deploy', 'deploy.tar');
// Ruta relativa para tar y scp: en Git Bash toman la letra de unidad por un host remoto.
const TAR_REL = 'deploy/deploy.tar';
const REMOTE_TAR = '/tmp/cm-deploy.tar';

// Lo que se despliega. `.env` y `data/` nunca salen de aquí ni se tocan allí.
// `.dockerignore` evita que el build mande data/ como contexto; `scripts/` lleva
// backup.sh al servidor (el build lo ignora).
const FILES = [
  'server', 'public', 'scripts', 'Dockerfile', '.dockerignore', 'docker-compose.yml', 'package.json',
  'package-lock.json', 'README.md', '.env.example', 'setup-telegram.sh',
];
// Directorios que se sustituyen enteros, para que desaparezca lo que ya no existe en local.
const REPLACE_DIRS = ['server', 'public'];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const DRY = flag('dry-run');
const WAIT_S = Number(opt('wait', 90)) || 90;

const log = (msg) => console.log(`[deploy] ${msg}`);
function fail(msg) {
  console.error(`[deploy] ERROR: ${msg}`);
  process.exit(1);
}
if (!HOST) fail('falta MONITOR_SSH (p. ej. root@100.64.0.1): defínela en el entorno o en .env.deploy');

/** Ejecuta un comando; con allowFail devuelve el resultado en vez de abortar. */
function run(cmd, args, { capture = false, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) fail(`${cmd} terminó con código ${r.status}`);
  return r;
}
const ssh = (remoteCmd, o) => run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', HOST, remoteCmd], o);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- huellas

function parseManifest(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{32})\s+\*?(.+)$/);
    if (m) map.set(m[2].replace(/^\.\//, ''), m[1]);
  }
  return map;
}

function serverManifest() {
  const cmd = `cd ${REMOTE} && find ${FILES.join(' ')} -type f 2>/dev/null | LC_ALL=C sort | xargs md5sum`;
  return parseManifest(ssh(cmd, { capture: true }).stdout);
}

function walk(rel, out) {
  const abs = path.join(ROOT, rel);
  if (statSync(abs).isDirectory()) {
    for (const name of readdirSync(abs).sort()) walk(`${rel}/${name}`, out);
  } else {
    out.push(rel);
  }
}

function localManifest() {
  const files = [];
  for (const f of FILES) if (existsSync(path.join(ROOT, f))) walk(f, files);
  const map = new Map();
  for (const f of files.sort()) {
    map.set(f, createHash('md5').update(readFileSync(path.join(ROOT, f))).digest('hex'));
  }
  return map;
}

const manifestText = (map) => `${[...map.keys()].sort().map((f) => `${map.get(f)}  ${f}`).join('\n')}\n`;

function diff(from, to, labelFrom, labelTo) {
  const lines = [];
  for (const [f, h] of from) {
    if (!to.has(f)) lines.push(`  solo en ${labelFrom}: ${f}`);
    else if (to.get(f) !== h) lines.push(`  distinto: ${f}`);
  }
  for (const f of to.keys()) if (!from.has(f)) lines.push(`  solo en ${labelTo}: ${f}`);
  return lines;
}

// ---------------------------------------------------------------- pasos

async function waitForHealth(expectedVersion) {
  const deadline = Date.now() + WAIT_S * 1000;
  let last = '';
  while (Date.now() < deadline) {
    const body = ssh(`curl -s --max-time 5 ${HEALTH_URL} || true`, { capture: true, allowFail: true }).stdout.trim();
    if (body) {
      try {
        const h = JSON.parse(body);
        if (h.version === expectedVersion && h.ok) return h;
        last = `version ${h.version} ok=${h.ok} problems=${JSON.stringify(h.problems)}`;
      } catch {
        last = body.slice(0, 120);
      }
    }
    await sleep(3000);
  }
  return { timeout: true, last };
}

function rollback(backupDir) {
  log(`restaurando ${backupDir}`);
  const cmd = `cd ${REMOTE} && rm -rf ${REPLACE_DIRS.join(' ')} && cp -a ${backupDir}/. . && docker compose up -d --build monitor`;
  ssh(cmd, { allowFail: true });
}

async function main() {
  if (flag('baseline')) {
    const m = serverManifest();
    if (!m.size) fail('no se pudo leer la huella del servidor');
    mkdirSync(path.dirname(MANIFEST), { recursive: true });
    writeFileSync(MANIFEST, manifestText(m));
    log(`huella del servidor guardada en deploy/last-deployed.md5 (${m.size} archivos). Haz commit de ese archivo.`);
    return;
  }

  const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  log(`versión local ${version} → ${HOST}:${REMOTE}${DRY ? ' (dry-run)' : ''}`);

  if (!flag('skip-tests')) {
    log('sintaxis y tests');
    run(process.execPath, ['scripts/check.mjs']);
    run(process.execPath, ['--test', 'test/*.test.js']);
  }

  // ¿Alguien editó directamente en el servidor desde el último despliegue?
  if (!existsSync(MANIFEST)) fail('no hay deploy/last-deployed.md5: ejecuta primero `npm run deploy:baseline`');
  const known = parseManifest(readFileSync(MANIFEST, 'utf8'));
  const server = serverManifest();
  if (!server.size) fail('no se pudo leer la huella del servidor');
  const drift = diff(server, known, 'servidor', 'huella');
  if (drift.length) {
    console.error(`[deploy] el servidor no coincide con la última huella:\n${drift.join('\n')}`);
    if (!flag('force')) fail('alguien cambió archivos en el servidor; revísalo o usa --force');
    log('--force: se sobrescriben');
  }

  const local = localManifest();
  const changes = diff(server, local, 'servidor', 'local');
  if (!changes.length) {
    log('el servidor ya tiene exactamente lo que hay en local; nada que desplegar');
    return;
  }
  log(`cambios a desplegar (${changes.length}):\n${changes.join('\n')}`);
  if (DRY) return;

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const backupDir = `${BACKUP_ROOT}/container-monitor-${stamp}`;

  log('empaquetando');
  mkdirSync(path.dirname(TAR), { recursive: true });
  rmSync(TAR, { force: true });
  run('tar', ['-cf', TAR_REL, ...FILES.filter((f) => existsSync(path.join(ROOT, f)))]);

  log('subiendo');
  run('scp', ['-o', 'BatchMode=yes', '-q', TAR_REL, `${HOST}:${REMOTE_TAR}`]);

  log(`copia de seguridad en ${backupDir} y despliegue`);
  const applied = ssh(
    [
      `cd ${REMOTE}`,
      // Solo lo que exista: un archivo nuevo en local todavia no esta en el servidor.
      `mkdir -p ${backupDir} && for f in ${FILES.join(' ')}; do if [ -e "$f" ]; then cp -a "$f" ${backupDir}/; fi; done`,
      `rm -rf ${REPLACE_DIRS.join(' ')}`,
      `tar -xf ${REMOTE_TAR} && rm -f ${REMOTE_TAR}`,
      'chmod +x setup-telegram.sh',
      'docker compose up -d --build monitor',
    ].join(' && '),
    { allowFail: true },
  );
  if (applied.status !== 0) {
    console.error('[deploy] el despliegue falló a medias');
    rollback(backupDir);
    fail(`restaurada la copia ${backupDir}`);
  }

  log(`esperando a /api/health (hasta ${WAIT_S} s)`);
  const health = await waitForHealth(version);
  if (health.timeout) {
    console.error(`[deploy] el monitor no ha vuelto sano: ${health.last || 'sin respuesta'}`);
    if (flag('no-rollback')) fail('sin vuelta atrás (--no-rollback); el servidor queda con la versión nueva');
    rollback(backupDir);
    fail(`restaurada la copia ${backupDir}; mira \`docker compose logs monitor\` en el servidor`);
  }
  log(`sano: versión ${health.version}, uptime ${health.uptimeSec} s`);

  const after = serverManifest();
  const mismatch = diff(after, local, 'servidor', 'local');
  if (mismatch.length) fail(`el servidor no quedó igual que local:\n${mismatch.join('\n')}`);
  writeFileSync(MANIFEST, manifestText(after));
  rmSync(TAR, { force: true });
  log('listo. Haz commit de deploy/last-deployed.md5 junto con el cambio.');
}

main().catch((err) => fail(err.stack || err.message));
