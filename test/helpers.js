'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Entorno aislado para los tests: un DATA_DIR temporal (db.js abre ahí la base
 * y push.js escribiría vapid.json) y todo lo que habla con fuera desactivado.
 * Hay que llamarlo ANTES del primer require de server/*. Cada archivo de test
 * corre en su propio proceso (`node --test`), así que no se pisan entre sí.
 */
function isolatedEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-test-'));
  Object.assign(
    process.env,
    {
      DATA_DIR: dir,
      PUSH_ENABLED: 'false',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_CHAT_ID: '',
      SNORT_ENABLED: 'false',
      DOCKER_EVENTS_ENABLED: 'false',
      DOCKER_HOST: 'tcp://127.0.0.1:1',
    },
    extra,
  );
  return dir;
}

module.exports = { isolatedEnv };
