# Usage Monitor

> ¿Voy a llegar al límite de uso de Claude antes del reinicio de la ventana? Míralo en el ícono del Dock, sin abrir nada.

App de macOS y Windows que lee tu uso de Claude, lo **proyecta hasta el reinicio de la ventana de 5 horas** y muestra el veredicto en el ícono del Dock (macOS) o de la bandeja del sistema (Windows): anillo de uso, anillo de tiempo transcurrido y, solo si importa, un número (probabilidad de agotarlo o minutos de margen). El detalle está en un panel con gráficos que abres con un clic en el ícono.

> [!WARNING]
> **No oficial.** Sin relación con Anthropic ni respaldo suyo. Lee un **endpoint interno y no documentado de claude.ai** usando tu propia sesión, iniciada en una ventana de la app. Puede cambiar o desaparecer sin aviso, y es tu responsabilidad comprobar que ese uso sea aceptable según los términos de tu cuenta. «Claude» es una marca de Anthropic; si publicas un fork, considera cambiar el nombre.

English summary: a macOS (Dock) and Windows (system tray) app that projects your Claude usage until the 5-hour window resets (probability of hitting the limit, median time, 80 % range) and shows it in the Dock icon. Unofficial; it reads an undocumented claude.ai endpoint with your own session. UI is Spanish-only for now; see [CONTRIBUTING](CONTRIBUTING.md).

## Instalación rápida (macOS, Apple Silicon)

```sh
curl -fsSL https://raw.githubusercontent.com/ignaciovillela/usage-monitor/main/scripts/install-mac.sh | bash
```

Instala la última versión en *Aplicaciones* sin avisos de macOS. Al abrirla, el panel te ofrece conectarla con Claude Code.

## Instalación rápida (Windows x64)

En PowerShell:

```powershell
irm https://raw.githubusercontent.com/ignaciovillela/usage-monitor/main/scripts/install-win.ps1 | iex
```

Instala la última versión sin avisos de SmartScreen y la abre. Para que además se actualice sola, ver [Instalar](#instalar). Más opciones (`.dmg`, zip, código fuente) también ahí.

¿Prefieres que un servidor tuyo consulte el uso y la app solo lo muestre? Copia [`server/docker-compose.yml`](server/docker-compose.yml) (Docker, opcional) y mira [Servidor propio](#fuente-de-datos-servidor-propio-opcional).

## Qué hace

- **Ícono dinámico** (se redibuja cada pocos segundos): uso de la ventana, tiempo transcurrido, y un número opcional (veredicto, probabilidad, porcentaje, tiempo hasta el límite o el reinicio). Forma, tamaño, posición y transparencia configurables.
- **Proyección probabilística:** el consumo llega en ráfagas, así que el modelo simula 400 futuros posibles a partir de tu propio historial (hora del día, duración de las sesiones, tamaño de los pasos) y entrega P(llegar al 100 %), la hora mediana y un rango del 80 %. El veredicto tiene histéresis para no parpadear, y se recalibra solo con ≥ 12 ventanas cerradas.
- **Panel:** proyección de la ventana con banda, consumo por hora, picos por ventana, uso semanal con tiempo transcurrido; cada gráfico con vista de tabla. Exporta e **importa CSV** (Ajustes → Importar CSV): sirve para llevar tu historial a otro equipo o recuperarlo; se fusiona con lo que ya hay, sin borrar nada, y acepta los CSV de lecturas, bloques y semanal.
- **Alertas** como notificaciones de macOS (80 %, 90 % y aviso anticipado).
- **Local:** sin servidor ni telemetría; no lee ni guarda conversaciones.

Backtest con usuarios sintéticos (56 días) contra una extrapolación lineal: Brier 0,081 vs 0,158; alarmas rojas falsas 23 % vs 44 %; 1,5 vs 80 cambios de veredicto por ventana. Deja pasar algo más de límites sin alarma roja (11 % vs 4 %). Son usuarios sintéticos, no datos reales: ver [docs/PRD.md](docs/PRD.md) §6.

## Instalar

**Desde un release** (lo más fácil): descarga el zip de tu sistema en [Releases](https://github.com/ignaciovillela/usage-monitor/releases).
- **macOS (Apple Silicon) — instalación sin bloqueos, una línea en Terminal:**
  ```sh
  curl -fsSL https://raw.githubusercontent.com/ignaciovillela/usage-monitor/main/scripts/install-mac.sh | bash
  ```
  Descarga el último `.dmg` con `curl`, copia la app a *Aplicaciones* y la abre. macOS solo bloquea lo que descargan los navegadores (los marca como «descargado de internet»), no lo que baja `curl`, así que no aparece ningún aviso; el script no toca ningún atributo de seguridad ni usa `sudo` (léelo antes: [scripts/install-mac.sh](scripts/install-mac.sh)).
- **macOS, con el `.dmg` descargado del navegador:** arrastra *Usage Monitor* a *Applications*. La app no está firmada con un certificado de pago de Apple ni notarizada, así que macOS la bloqueará la primera vez. Para permitirla: *Ajustes del Sistema → Privacidad y seguridad → «Abrir de todos modos»* (aparece tras intentar abrirla una vez), o en Terminal `xattr -dr com.apple.quarantine "/Applications/Usage Monitor.app"`. (En macOS anteriores basta con clic derecho → *Abrir*.)
- **Windows (x64) — experimental — instalación sin avisos, una línea en PowerShell:**
  ```powershell
  irm https://raw.githubusercontent.com/ignaciovillela/usage-monitor/main/scripts/install-win.ps1 | iex
  ```
  Descarga el último zip de Windows, lo instala en `%LOCALAPPDATA%\Programs\Usage Monitor`, crea un acceso directo en el menú Inicio y abre la app. Si vuelves a ejecutarlo, actualiza (o no hace nada si ya tienes la última versión). Lo que baja PowerShell no lleva la marca «descargado de internet», así que SmartScreen no avisa; no usa permisos de administrador ni toca tus datos (léelo antes: [scripts/install-win.ps1](scripts/install-win.ps1)).

  **Actualización automática (opcional):** crea una tarea programada que repite la instalación al iniciar sesión y cada día; si hay versión nueva, cierra la app, la reemplaza y la vuelve a abrir.
  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/ignaciovillela/usage-monitor/main/scripts/install-win.ps1))) -AutoUpdate
  ```
  Con el mismo comando, cambiando `-AutoUpdate` por `-DisableAutoUpdate` la quitas, y con `-Uninstall` borras la app, el acceso directo y la tarea (tus datos quedan en `%APPDATA%\Usage Monitor`).

  **Canal (main o dev):** en una instalación nueva se instala la última estable (main); añade `-Channel dev` para la última de desarrollo. Después se cambia desde la app (*Ajustes y datos → Canal de actualizaciones*, o *Más opciones* en el menú de la bandeja), y el botón *Actualizar ahora* y la tarea automática siguen ese canal. Pasar de dev a main instala la estable aunque tenga un número menor.
- **Windows, con el zip descargado del navegador:** descomprime y ejecuta `Usage Monitor.exe`. Los releases van firmados con Azure Artifact Signing, así que Smart App Control no los bloquea (SmartScreen puede avisar mientras el certificado gana reputación: *Más información → Ejecutar de todos modos*). Si compilas tú la app, sale sin firmar y Smart App Control la bloqueará; ver [docs/windows-signing.md](docs/windows-signing.md). El ícono dinámico vive en la bandeja del sistema (junto al reloj; puede quedar en el menú «^» de íconos ocultos): clic para abrir el panel, clic derecho para el menú.

**Desde el código fuente** (necesitas Node 20+; en Mac Intel es la única opción):

```sh
npm install
npm run build        # macOS: crea dist/Usage Monitor-darwin-<arq>/Usage Monitor.app
npm run build:win    # Windows (ejecutar en Windows): crea dist/Usage Monitor-win32-x64/
npm run dmg          # macOS: crea el instalador .dmg a partir de la app compilada
open "dist/Usage Monitor-darwin-"*/"Usage Monitor.app"   # macOS
```

En macOS la app está firmada ad hoc, sin notarizar: la primera vez, clic derecho → *Abrir* (o permítela en Ajustes del sistema → Privacidad y seguridad). Ofrece moverse a `/Applications` y abrirse al iniciar sesión. Los instaladores de los releases (`.dmg` y `.zip` de Windows) los compila el workflow `release` de GitHub Actions.

### Fuente de datos: Claude Code (por defecto, sin iniciar sesión en la app)

Si usas Claude Code con un plan **Pro o Max**, la app lee tus límites de uso desde su [línea de estado](https://code.claude.com/docs/en/statusline), que recibe `rate_limits.five_hour` y `rate_limits.seven_day`. No se maneja ninguna sesión, cookie ni token: solo los números que Claude Code ya calcula.

Al abrir la app por primera vez, el panel muestra la tarjeta **«Conecta Usage Monitor con Claude Code»**. Pulsa *Conectar con Claude Code* y confirma: la app instala `~/.usage-monitor/statusline-feed.sh` y añade la clave `statusLine` a `~/.claude/settings.json`, guardando antes una copia de respaldo con fecha. Si ya tenías una línea de estado, se conserva (el script la ejecuta después). *Desconectar de Claude Code…* (menú del Dock) lo deja como estaba.

Después abre una sesión **nueva** de Claude Code: la app se actualiza sola cuando llegan los datos. Si prefieres la ventana de claude.ai, usa *Usar claude.ai en su lugar* en la tarjeta o *Fuente de datos* en el menú del Dock.

Limitaciones: Claude Code solo envía los límites tras la primera respuesta de cada sesión, no hay datos mientras no lo uses, y solo cuenta el uso que Claude Code refleja (no verifiqué si incluye el chat de claude.ai). Sin `jq` el script guarda la entrada completa de la línea de estado (ruta de trabajo, modelo, etc.) en un archivo local con permisos 600; con `jq` guarda solo `rate_limits`.

### Conectar tu cuenta (fuente claude.ai)

Si eliges esta fuente, al abrir la app se muestra una ventana de **claude.ai**: inicia sesión ahí. La sesión se conserva entre ejecuciones y la ventana se oculta sola cuando hay datos. Se vuelve a mostrar si la sesión caduca, si claude.ai no carga o tras dos fallos seguidos; también desde el menú del Dock (*Ventana de claude.ai…*).

Si claude.ai muestra una verificación («comprobando que eres humano»), complétala en esa ventana. **La app no oculta que es una ventana embebida ni intenta saltarse ninguna protección.** Si el sitio no permite iniciar sesión en un navegador embebido (por ejemplo con ciertos proveedores de identidad o verificaciones), la app no podrá leer tu uso; esto no se ha validado con todas las cuentas y es la principal limitación conocida.

### Fuente de datos: servidor propio (opcional)

> **Ejemplo listo para copiar:** [`server/docker-compose.yml`](server/docker-compose.yml) · guía en [`server/README.md`](server/README.md). El servidor también sirve una página web en `http://<servidor>:8787/` para ver el uso desde cualquier navegador.

Para que otro equipo (un servidor tuyo) consulte el uso y la app solo lo muestre. En el panel, **Ajustes y datos → Fuente de datos → Servidor propio (URL)**: escribe la **URL local** (red de casa), una **URL online** opcional o ambas (se usa la local y, si no responde, la online) y el token (el servidor de `server/` lo exige; *Generar* crea uno y lo copias en `API_TOKEN` del compose; se envía como `Authorization: Bearer …` y se guarda cifrado con el llavero del sistema cuando está disponible). *Guardar y probar* hace una consulta al momento. También se puede fijar con `USAGE_MONITOR_REMOTE_URL`, `USAGE_MONITOR_REMOTE_URL_ONLINE` y `USAGE_MONITOR_REMOTE_TOKEN`. La flecha de recargar hace `POST` a la URL para pedir datos frescos (si no lo admite, `GET`).

La URL puede devolver el JSON de claude.ai (`five_hour`, `seven_day`, `seven_day_*`), el de la línea de estado de Claude Code (`{ rate_limits: … }`) o un sobre `{ fetchedAt, usage, error }`; con `fetchedAt` la app avisa si los datos tienen más de 15 minutos. En [`server/`](server/README.md) hay un servicio listo para Docker Compose que consulta el uso con el login de Claude Code de esa máquina (o con tu cookie de claude.ai) y trae todos los topes semanales.

## Estructura

```
src/            proceso principal (Electron): ventana de sesión, consulta, ícono del Dock, menú
src/providers/  lo único que conoce claude.ai (ver docs/ADAPTING.md)
renderer/       ícono (icon.html) y panel (panel/: popup + modelo: util.js, core.js, model.js)
tests/          pruebas unitarias, backtest con usuarios sintéticos, replay con tu CSV
scripts/        build del .app e importación de historial
docs/           PRD, notas de diseño, guía para adaptarlo a otros servicios
server/         servicio opcional (Docker) que consulta el uso y lo sirve por HTTP a la app
```

## Desarrollo

```sh
npm test                               # pruebas del modelo (Node 20+, sin instalar nada)
node tests/run-backtest.js             # backtest sintético; --days 56 --seeds 3 es el completo
node tests/replay.js mi.csv            # mide el modelo con tu propio CSV exportado
npm start                              # ejecuta la app en desarrollo (en el Dock aparece como "Electron")
npm run selftest                       # prueba de dibujo del ícono y del modelo, sin red
USAGE_MONITOR_MOCK=1 npm start           # datos simulados para ver el ícono moverse
```

Para otro servicio o suscripción: [docs/ADAPTING.md](docs/ADAPTING.md).

### Versiones y actualizaciones

El pie del panel muestra la versión de la app y, con servidor propio, la del servidor y la URL que respondió (local u online). Cada 6 h la app consulta la lista de releases del repositorio de `package.json` (`repository`) y avisa en el panel, en el menú y con una notificación (una vez por versión) si hay una versión nueva de la app o si el servidor está desactualizado o es más nuevo que la app. Se desactiva en *Ajustes y datos → Buscar actualizaciones*; `USAGE_MONITOR_RELEASES_URL` apunta a otra API compatible. La consulta no envía datos de uso.

**Canal dev.** Cada cambio en la rama `dev` publica un pre-release `vX.Y.Z-dev.N` (N = número de commits; se conservan los últimos 10) con los instaladores, y la imagen del servidor `X.Y.Z-dev.N` y `:dev` con la misma versión. El canal se elige en *Ajustes y datos → Canal de actualizaciones*: **Estable (main)** solo mira las estables (y, con una app de dev instalada, ofrece volver a la última estable); **Desarrollo (dev)** también las de dev. Sin elegir, una app de dev sigue dev y una estable sigue main.

**Actualizar con un botón** (Windows x64 y macOS Apple Silicon, en la app empaquetada). El aviso trae *Actualizar ahora*: la app descarga el instalador del release con una barra de progreso (se puede cancelar), comprueba su sha256 con el que publica GitHub y se lo pasa a `scripts/install-win.ps1` o `scripts/install-mac.sh`, que vienen dentro de la app. La app se cierra, el script la reemplaza y la vuelve a abrir. Si algo falla, el script reabre la versión que estabas usando y el panel muestra el error con *Reintentar*. En Windows, si la abriste desde un zip, se instala en `%LOCALAPPDATA%\Programs\Usage Monitor`, igual que con el script. En macOS se reemplaza la copia que estás usando, si su carpeta admite escritura, o se instala en */Applications*.

**Resumen de la actualización.** Al abrir una versión distinta de la última vez, el panel muestra *Actualizado a vX* con lo que cambió: las viñetas de las notas de los releases intermedios y los títulos de los commits entre ambas versiones (sin los merges), hasta que pulses *Entendido*. Si la versión anterior era un dev que ya se borró (se conservan 10), no hay lista de commits y queda solo el enlace a GitHub. Con *Buscar actualizaciones* desactivado no se consulta GitHub y el resumen solo dice de qué versión vienes.

## Privacidad

Todo queda en tu equipo: `~/Library/Application Support/Usage Monitor` (macOS) o `%APPDATA%\Usage Monitor` (Windows) (historial, modelo, ajustes y la sesión de la ventana de claude.ai). Se guardan porcentajes de uso y horas de reinicio, no contenido de conversaciones. «Exportar CSV» incluye tu patrón de uso: no lo subas al repositorio (`*.csv` está en `.gitignore`).

## Licencia

[MIT](LICENSE)
