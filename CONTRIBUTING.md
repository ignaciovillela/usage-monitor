# Contribuir

Se agradecen informes de errores, proveedores para otras suscripciones, traducciones y mejoras del modelo.

## Preparar
- Node 20+. Las pruebas del modelo no necesitan instalar nada: `npm test`.
- Para la app: `npm install`; `npm start` (desarrollo), `npm run selftest` (dibujo y modelo sin red), `npm run build` (macOS, crea el `.app`) y `npm run build:win` (Windows). Los releases los compila el workflow `release`.

## Estructura
- `renderer/panel/model.js` es el modelo de proyección: funciones puras, sin APIs de navegador ni `Date.now()`: todo recibe `now`, así que los resultados son reproducibles. `step()` es el único punto de entrada (lo usan la app, el backtest y las pruebas).
- `renderer/panel/core.js` y `util.js`: lógica pura y dibujo del ícono. `popup.*` es el panel; escrito contra la API de `chrome.storage`, que `src/panel-preload.js` emula con datos de la app.
- `src/providers/` es donde se conecta un servicio. Ver [docs/ADAPTING.md](docs/ADAPTING.md).

## Cambios en el modelo
No debe empeorar el backtest sin una razón explícita. Ejecuta `node tests/run-backtest.js` antes y después, y pon en el PR los números de Brier, falsas alarmas y alarmas perdidas. El backtest usa usuarios sintéticos: si tienes historial real, `tests/replay.js` es mejor evidencia (resume los números; no adjuntes tu CSV).

## Pull requests
- Agrega o actualiza pruebas (`tests/*.test.js`) y deja el CI en verde.
- La interfaz está en español. Si quieres empezar la traducción, abre antes un issue: los textos están repartidos entre `renderer/panel/` y `src/main.js`.
- **No pidas ni implementes** formas de saltarse verificaciones anti-bots (cambiar el user-agent, simular un navegador, etc.): el proyecto no las usa.
- Nunca subas exportaciones de uso, cookies, tokens ni ids de organización.

## Seguridad
La app guarda una sesión de claude.ai en tu equipo. Si encuentras una forma de que otro programa o sitio acceda a ella, repórtalo en privado mediante los avisos de seguridad del repositorio y no en un issue público.
