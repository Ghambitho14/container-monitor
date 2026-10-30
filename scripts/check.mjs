// Comprobaciones rapidas antes de desplegar (`npm run check`):
//  1. sintaxis de todos los modulos de server/ sin ejecutarlos (index.js escucha
//     el puerto al cargar, asi que no se puede importar en un test);
//  2. que .env.example documente todas las variables del catalogo de ajustes;
//  3. que los dos README (README.md y README.es.md) mencionen todas las rutas de la API.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let failed = 0;
const problem = (msg) => {
  failed += 1;
  console.error(`[check] ${msg}`);
};

// 1. Sintaxis.
const serverDir = path.join(ROOT, 'server');
for (const name of readdirSync(serverDir).filter((n) => n.endsWith('.js')).sort()) {
  const r = spawnSync(process.execPath, ['--check', path.join(serverDir, name)], { encoding: 'utf8' });
  if (r.status !== 0) problem(`${name}\n${r.stderr}`);
}

// 2. Variables de entorno: SCHEMA frente a .env.example (settings.js no tiene efectos al importar).
const { SCHEMA } = require('../server/settings.js');
const envExample = readFileSync(path.join(ROOT, '.env.example'), 'utf8');
for (const field of SCHEMA) {
  if (!new RegExp(`^#?\\s*${field.env}=`, 'm').test(envExample)) problem(`.env.example no documenta ${field.env}`);
}

// 3. Rutas de la API frente a los README.
const indexSrc = readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
const routes = [...indexSrc.matchAll(/app\.(?:get|post|put|delete)\('(\/api\/[^']+)'/g)].map((m) => m[1]);
const READMES = ['README.md', 'README.es.md'];
for (const name of READMES) {
  const readme = readFileSync(path.join(ROOT, name), 'utf8');
  for (const route of new Set(routes)) {
    // "/api/push/subscribe" puede aparecer en el README como "`/subscribe`" dentro de su fila.
    const short = route.split('/').pop();
    if (!readme.includes(route) && !readme.includes(`\`/${short}\``)) problem(`${name} no menciona la ruta ${route}`);
  }
}

console.log(
  failed
    ? `[check] ${failed} problema(s)`
    : `[check] sintaxis correcta en server/, .env.example completo (${SCHEMA.length} variables), ${READMES.join(' y ')} con las ${new Set(routes).size} rutas`,
);
process.exit(failed ? 1 : 0);
