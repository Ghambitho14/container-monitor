const settings = require('./settings');

/**
 * Objeto de configuracion compartido por todos los modulos.
 *
 * Los ajustes (variable de entorno, defecto, limites, texto del panel) viven en
 * `settings.js`; aqui solo quedan los valores fijos que no se exponen en el
 * panel. El orden de precedencia es defecto → `.env` → `data/settings.json`.
 *
 * Es un unico objeto mutable: cuando se guarda un ajuste "en caliente" desde
 * la pestaña Ajustes, `settings.save()` lo cambia aqui y los modulos lo ven en
 * su siguiente lectura.
 */
const config = settings.build({
  port: Number(process.env.PORT) || 3000,
  dataDir: process.env.DATA_DIR || '/app/data',
  telegram: {},
  watch: {},
  thresholds: {},
  containers: {},
  monitor: {},
  events: {},
  stats: {},
  domains: {},
  snort: {},
  digest: {},
  push: {},
  ws: {
    heartbeatMs: 30000,
    tailDefault: 200,
    tailMax: 2000,
  },
});

module.exports = config;
