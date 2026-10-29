# Usage Monitor

> ¿Voy a llegar al límite de uso de Claude antes del reinicio de la ventana? Míralo en el ícono del Dock, sin abrir nada.

App de macOS y Windows que lee tu uso de Claude, lo **proyecta hasta el reinicio de la ventana de 5 horas** y muestra el veredicto en el ícono del Dock (macOS) o de la bandeja del sistema (Windows): anillo de uso, anillo de tiempo transcurrido y, solo si importa, un número (probabilidad de agotarlo o minutos de margen). El detalle está en un panel con gráficos que abres con un clic en el ícono.

> [!WARNING]
> **No oficial.** Sin relación con Anthropic ni respaldo suyo. Lee un **endpoint interno y no documentado de claude.ai** usando tu propia sesión, iniciada en una ventana de la app. Puede cambiar o desaparecer sin aviso, y es tu responsabilidad comprobar que ese uso sea aceptable según los términos de tu cuenta. «Claude» es una marca de Anthropic; si publicas un fork, considera cambiar el nombre.

English summary: a macOS (Dock) and Windows (system tray) app that projects your Claude usage until the 5-hour window resets (probability of hitting the limit, median time, 80 % range) and shows it in the Dock icon. Unofficial; it reads an undocumented claude.ai endpoint with your own session. UI is Spanish-only for now; see [CONTRIBUTING](CONTRIBUTING.md).

## Qué hace

- **Ícono dinámico** (se redibuja cada pocos segundos): uso de la ventana, tiempo transcurrido, y un número opcional (veredicto, probabilidad, porcentaje, tiempo hasta el límite o el reinicio). Forma, tamaño, posición y transparencia configurables.
- **Proyección probabilística:** el consumo llega en ráfagas, así que el modelo simula 400 futuros posibles a partir de tu propio historial (hora del día, duración de las sesiones, tamaño de los pasos) y entrega P(llegar al 100 %), la hora mediana y un rango del 80 %. El veredicto tiene histéresis para no parpadear, y se recalibra solo con ≥ 12 ventanas cerradas.
- **Panel:** proyección de la ventana con banda, consumo por hora, picos por ventana, uso semanal con tiempo transcurrido; cada gráfico con vista de tabla. Exporta e **importa CSV** (Ajustes → Importar CSV): sirve para llevar tu historial a otro equipo o recuperarlo; se fusiona con lo que ya hay, sin borrar nada, y acepta los CSV de lecturas, bloques y semanal.
- **Alertas** como notificaciones de macOS (80 %, 90 % y aviso anticipado).
- **Local:** sin servidor ni telemetría; no lee ni guarda conversaciones.

Backtest con usuarios sintéticos (56 días) contra una extrapolación lineal: Brier 0,081 vs 0,158; alarmas rojas falsas 23 % vs 44 %; 1,5 vs 80 cambios de veredicto por ventana. Deja pasar algo más de límites sin alarma roja (11 % vs 4 %). Son usuarios sintéticos, no datos reales: ver [docs/PRD.md](docs/PRD.md) §6.

## Instalar

**Desde un release** (lo más fácil): descarga el zip de tu sistema en [Releases](https://github.com/ignaciovillela/usage-monitor/releases).
- **macOS (Apple Silicon):** descarga el `.dmg`, ábrelo y **arrastra *Usage Monitor* a *Applications***. La app no está firmada por un desarrollador de Apple ni notarizada, así que la primera vez macOS puede bloquearla. Si pasa, haz doble clic en **«Si macOS la bloquea, abre esto.command»** (está en el mismo `.dmg`): intenta abrir la app y, si fue bloqueada, te lleva directo a *Ajustes del Sistema → Privacidad y seguridad*, donde pulsas **«Abrir de todos modos»** junto a *Usage Monitor*. (En macOS anteriores basta con clic derecho → *Abrir*.) El ayudante no salta la protección de macOS: la decisión de permitir la app sigue siendo tuya.
- **Windows (x64) — experimental, sin probar en un equipo real:** descomprime y ejecuta `Usage Monitor.exe`. Windows SmartScreen avisará porque la app no está firmada: *Más información → Ejecutar de todos modos*. El ícono dinámico vive en la bandeja del sistema (junto al reloj; puede quedar en el menú «^» de íconos ocultos): clic para abrir el panel, clic derecho para el menú.

**Desde el código fuente** (necesitas Node 20+; en Mac Intel es la única opción):

```sh
npm install
npm run build        # macOS: crea dist/Usage Monitor-darwin-<arq>/Usage Monitor.app
npm run build:win    # Windows (ejecutar en Windows): crea dist/Usage Monitor-win32-x64/
npm run dmg          # macOS: crea el instalador .dmg a partir de la app compilada
open "dist/Usage Monitor-darwin-"*/"Usage Monitor.app"   # macOS
```

En macOS la app está firmada ad hoc, sin notarizar: la primera vez, clic derecho → *Abrir* (o permítela en Ajustes del sistema → Privacidad y seguridad). Ofrece moverse a `/Applications` y abrirse al iniciar sesión. Los instaladores de los releases (`.dmg` y `.zip` de Windows) los compila el workflow `release` de GitHub Actions.

### Conectar tu cuenta

Al abrir la app por primera vez se muestra una ventana de **claude.ai**: inicia sesión ahí. La sesión se conserva entre ejecuciones y la ventana se oculta sola cuando hay datos. Se vuelve a mostrar si la sesión caduca, si claude.ai no carga o tras dos fallos seguidos; también desde el menú del Dock (*Ventana de claude.ai…*).

Si claude.ai muestra una verificación («comprobando que eres humano»), complétala en esa ventana. **La app no oculta que es una ventana embebida ni intenta saltarse ninguna protección.** Si el sitio no permite iniciar sesión en un navegador embebido (por ejemplo con ciertos proveedores de identidad o verificaciones), la app no podrá leer tu uso; esto no se ha validado con todas las cuentas y es la principal limitación conocida.

## Estructura

```
src/            proceso principal (Electron): ventana de sesión, consulta, ícono del Dock, menú
src/providers/  lo único que conoce claude.ai (ver docs/ADAPTING.md)
renderer/       ícono (icon.html) y panel (panel/: popup + modelo: util.js, core.js, model.js)
tests/          pruebas unitarias, backtest con usuarios sintéticos, replay con tu CSV
scripts/        build del .app e importación de historial
docs/           PRD, notas de diseño, guía para adaptarlo a otros servicios
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

## Privacidad

Todo queda en tu equipo: `~/Library/Application Support/Usage Monitor` (macOS) o `%APPDATA%\Usage Monitor` (Windows) (historial, modelo, ajustes y la sesión de la ventana de claude.ai). Se guardan porcentajes de uso y horas de reinicio, no contenido de conversaciones. «Exportar CSV» incluye tu patrón de uso: no lo subas al repositorio (`*.csv` está en `.gitignore`).

## Licencia

[MIT](LICENSE)
