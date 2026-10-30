// Panel LOCAL contra la API REAL del monitor: sirve public/ desde este disco y
// reenvía /api/* al VPS. Para ver cambios de interfaz sin desplegar.
//
//   node scripts/dev-proxy.mjs            → http://127.0.0.1:3100
//   MONITOR_URL=http://host:3000 PORT=3200 node scripts/dev-proxy.mjs
//
// MONITOR_URL es obligatoria: en el entorno o en `.env.deploy` (ignorado por git).
//
// Ojo: las escrituras (Ajustes, reinicio, push) llegan al servidor de verdad.
// Los logs en vivo (WebSocket) no se reenvían.
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_ENV = path.join(ROOT, '.env.deploy');
if (existsSync(LOCAL_ENV)) process.loadEnvFile(LOCAL_ENV);
if (!process.env.MONITOR_URL) {
  console.error('[dev-proxy] falta MONITOR_URL (p. ej. http://100.64.0.1:3000): defínela en el entorno o en .env.deploy');
  process.exit(1);
}
const TARGET = new URL(process.env.MONITOR_URL);
const PORT = Number(process.env.PORT || 3100);
const PUBLIC = path.join(ROOT, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

http
  .createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      const headers = { ...req.headers, host: TARGET.host };
      // El servidor exige Origin == Host en las escrituras: se reescribe al del VPS.
      if (headers.origin) headers.origin = TARGET.origin;
      const up = http.request(
        { hostname: TARGET.hostname, port: TARGET.port || 80, path: req.url, method: req.method, headers },
        (r) => {
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res);
        },
      );
      up.on('error', (err) => {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`proxy: ${err.message}`);
      });
      req.pipe(up);
      return;
    }

    const clean = req.url.split('?')[0];
    let file = path.join(PUBLIC, clean === '/' ? 'index.html' : clean);
    try {
      if (!statSync(file).isFile()) throw new Error('dir');
    } catch {
      file = path.join(PUBLIC, 'index.html');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    createReadStream(file).pipe(res);
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`panel local en http://127.0.0.1:${PORT} → API en ${TARGET.origin}`);
  });
