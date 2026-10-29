> **Nota histórica.** Estas notas se escribieron cuando el proyecto era una extensión de Chrome más una app de macOS. La extensión salió del alcance; el modelo y el panel viven ahora en `renderer/panel/` y la app los usa directamente. Las secciones sobre `background.js`, el badge, el service worker y el puente local ya no se aplican.

# Claude Usage Monitor — notas para retomar el proyecto

Extensión de Chrome (Manifest V3) que muestra el uso de Claude (ventana de 5 h y semanal) y **proyecta si te vas a quedar sin límite antes del reinicio**, con el veredicto en el ícono de la barra. Versión actual: **3.0.0**. Todo local: no hay backend ni red salvo `claude.ai`.

Ubicación: carpeta `extension/`. Interfaz y mensajes en español.

## Objetivo del usuario (resumen de lo pedido)
1. Ver de un vistazo la proyección del consumo frente a la hora de reinicio.
2. Números relevantes **en el ícono** (sin abrir el popup) y gráficos con el detalle.
3. Saber "qué tan bien voy": si me quedaré sin límite antes del reinicio, o no (no alarmista: con 15 % de uso no debe gritar).
4. Libertad total para mejorar el algoritmo (estadística/ML ligero, guardar histórico). El plan lo diseñó un agente Opus; se implementó por fases.
5. En el uso semanal, mostrar también la barrita de tiempo transcurrido.

## Cómo se instala / prueba rápido
- `chrome://extensions` → Modo desarrollador → Cargar descomprimida → esta carpeta (Chrome ≥ 110). Tras cambiar código, pulsar recargar.
- Tests: `node --test tests/` (19 pruebas) · `node tests/linear-engine.js` (suite del motor lineal) · `node tests/run-backtest.js --days 56 --seeds 3` (≈2 min) · `node tests/replay.js historial.csv` (datos reales exportados desde el popup).
- Chrome real por CDP: `node tests/tools/chrome-e2e.js <dir-perfil-vacío> <prefijo-capturas>` (ver "Trucos").

## Arquitectura (archivos)
| Archivo | Rol |
|---|---|
| `manifest.json` | MV3. Permisos: storage, alarms, notifications; host `https://claude.ai/*`. Content script: `util.js`, `core.js`, `content.js`. |
| `util.js` | Formato (`fmtDuration`, `fmtReset`, `fmtClock`, `fmtPct`). Compartido por todos. |
| `core.js` | Lógica pura compartida (SW, popup, widget): muestras, ventana actual, `estimate` lineal, `projection`, `levelFor`/`verdict`, `projectionParts`/`probParts`, `badgeInfo`, `tooltipText`, `drawIcon`, series de gráficos. **No** hace el modelo probabilístico. |
| `model.js` | Motor probabilístico (solo SW, popup para Brier, y tests): bloques de 10 min, `fitModel`, `forecast` (Monte Carlo), histéresis, calibración, registros, y `step()` (núcleo puro de cada lectura). Sin `chrome.*` ni `Date.now()`. |
| `background.js` | Service worker: alarma cada 1 min → `fetchUsage` → `step` → guarda solo las claves "dirty" → notificaciones → ícono (badge, anillos con OffscreenCanvas, tooltip). `poll()` coalesce lecturas concurrentes. |
| `popup.html/css/js` | UI: hero, losetas, barras semanales (con marca de tiempo), gráficos SVG propios (ventana con banda, 24 h, ventanas), tablas equivalentes, ajustes. |
| `content.js` | Widget en claude.ai (Shadow DOM, se puede ocultar y reactivar desde el popup). |
| `tests/` | Ver "Pruebas". |

Los archivos se cargan en el mismo ámbito (`importScripts` en SW; `<script>` en popup; `js: [...]` en content script), por eso **los nombres de `const`/`function` de nivel superior no pueden repetirse entre `util.js`, `core.js`, `model.js` y el archivo que los usa** (ya ocurrió con `PROJECTION_ALERT_MIN`).

## Datos de la API (supuestos)
- `GET /api/organizations` → elegir la org con `capabilities` que incluya `"chat"` (se cachea `orgId`; se redescubre ante 404/403).
- `GET /api/organizations/{id}/usage` → `five_hour {utilization 0-100, resets_at}`; `five_hour: null` = **sin ventana activa** (no es error). `seven_day`, `seven_day_opus`, `seven_day_sonnet` con el mismo formato.
- Es un endpoint interno: puede cambiar. No se confirmó si `utilization` es entera (el modelo detecta datos enteros y sube el umbral de "activo" a 1 pp).
- La URL `https://claude.ai/settings/usage` (clic en el widget) se puso de memoria, **sin verificar**.

## Almacenamiento (`chrome.storage.local`)
| Clave | Contenido | Retención | Se escribe |
|---|---|---|---|
| `usageSamples` | `[ts, uso, resetsAt|0]` | 7 d (completas 6 h; 1 cada 10 min antes). Sin ventana: 1 lectura cada ~10 min | cada lectura |
| `usageBlocks` | `[k, vFin×10, d×10, flags]` (k = ts/10 min; flags 1 GAP, 2 RESET, 4 CENSORED, 8 NOWIN) | 42 d | cada 10 min |
| `usageModel` | pStart[48], pStay[4], sizes[≤500], mu, days, thr, lastClosedK, v | — | cada 10 min |
| `usageWindows` | `[inicio, reinicio, pico, hitTs]` | 180 d | al cambiar |
| `usageForecastLog` | `[reinicio, ts, uso×10, pHit×1000, mediana]` cada 30 min | 90 d | cada 30 min |
| `usageState` | estado + `forecast` (pHit, hitQ, finalQ, band, drivers, why), `verdictMemo`, `calib`, `windowSeed` | — | cada lectura |
| `alertsEnabled`, `badgeMode` (pace/prob/percent/limit/reset), `widgetEnabled`, `projectionEngine` (prob/linear), `orgId` | ajustes | — | — |

Tamaño típico: ~40 KB al inicio, ~350 KB a las 6 semanas. Migraciones: `usageHistory` (formato viejo) → `usageSamples`; sin `usageBlocks`/`usageModel` se reconstruyen desde las muestras (solo hay 7 d al migrar).

## El algoritmo (motor probabilístico)
**Modelo.** Bloques de 10 min: estado activo/pausa (cadena de Markov) + escalón de tamaño aleatorio si activo.
- `pStart[hora, laborable/finde]` = P(activo | pausa): estimado de transiciones contiguas válidas, **suavizado con horas vecinas (0,25/0,5/0,25)** y contraído a un prior (`kappa`=6).
- `pStay[4]` = P(activo | activo) por antigüedad de sesión (1, 2-3, 4-7, ≥8 bloques); priors `[0,55; 0,72; 0,85; 0,92]`.
- Tamaños: muestreo de los últimos 500 bloques activos (peso 0,5^(edad/21 d)) mezclado con prior lognormal (mediana 1,5 pp, σ 1, peso 10 pseudo-obs).
- Intensidad de la ventana actual θ (inversa-gamma A=2, B=1) a partir de los bloques completos de la ventana (el bloque a medias **no** cuenta salvo que supere a la media de los completos).
- Bloques excluidos del ajuste: GAP (hueco >25 min / sin referencia) y CENSORED (ya en el tope 99,5 %). NOWIN cuenta como pausa observada.
- Un salto tras un hueco se reparte entre los bloques del hueco (`windowContext`).

**Pronóstico (`forecast`).** 400 trayectorias con PRNG mulberry32, semilla fija por ventana (`state.windowSeed`) → estable entre lecturas. Salidas: `pHit`, `hitQ` (p10/p50/p90 de la hora de agotamiento, si pHit ≥ 5 %), `finalQ`, banda p10/p50/p90 por bloque.

**Calibración.** Al empezar cada ventana, con ≥12 ventanas cerradas: `p' = σ(a + b·logit p)` por MAP (priors a~N(0,0.5²), b~N(1,0.3²)), 12 pasos de Newton, cada ventana pesa 3. Se registra la P **sin calibrar** y se aplica la calibrada.

**Veredicto (`rawLevel` + `applyHysteresis`).** `pHit ≥ 0,45` → rojo (si la mediana cae ≥15 min antes del reinicio; si no, ámbar); `pHit ≥ 0,20` → ámbar; uso ≥ 99,5 % → rojo; uso ≥ 90 % → al menos ámbar. Sube al instante; baja solo tras 3 lecturas bajo la salida (rojo→0,30; ámbar→0,12).

**Alertas.** 80 % y 90 % de uso; aviso anticipado una vez por ventana si nivel rojo, pHit ≥ 0,70 y mediana a < 60 min.

**Badge.** Modo `pace` (predeterminado): *(vacío si todo va bien; el anillo exterior va en verde)* | `43%` (ámbar con pHit ≥ 20 %) | `-65m` (rojo/ámbar con mediana de bloqueo) | porcentaje si no hay pronóstico. Colores: verde `#2e7d32`, ámbar `#b45309`, rojo `#c62828`, gris `#5f6368`, azul `#37608a`.

**Motor lineal (respaldo).** Regresión en ventanas de 3 y 15 min + `effectiveRate` (amortigua ráfagas con poco uso) + umbral `EARLY_UTIL=30 %` (sin rojo por debajo). Se activa con Ajustes → Proyección → Lineal; el modelo sigue aprendiendo en segundo plano.

## Por qué está así (decisiones y hallazgos)
- **Opus planificó, se implementó por fases** (arnés → núcleo `step` → modelo → integración → UI → calibración). Se cambió respecto al plan: umbrales (rojo 0,45 / ámbar 0,20 en vez de 0,60 / 0,25) por barrido sobre el backtest; 4 tramos de antigüedad en vez de 3; suavizado horario; prior de θ más débil; lecturas sin ventana cada ~10 min; notificación a 60 min / 0,70.
- **El rojo es de precisión; el ámbar es de detección.** Con ámbar+rojo la detección casi iguala al lineal con muchas menos falsas alarmas; con rojo solo se pierde más (11 % vs 4 %).
- **Bugs que halló el backtest** (útil si reaparece algo parecido): bloque parcial al inicio de ventana leído como "intensidad baja"; salto tras un hueco atribuido a un solo bloque; lecturas sin ventana no guardadas → el modelo no veía pausas; estimación por hora muy ruidosa (parámetros sensibles: −27 % en pStart + −10 % en tamaño dividían pHit a la mitad); compactación de muestras que colapsaba el historial al reemplazar con timestamp nuevo.
- **Control de calidad del modelo:** el perfil sintético `markov` (que cumple exactamente los supuestos) sale calibrado (ECE ≈ 0,01); con los parámetros verdaderos del generador el modelo reproduce la realidad (0,49–0,60 vs 0,58). Por eso el sesgo restante en usuarios intensos es de **estimación**, y se corrige con la recalibración.
- **Alarmismo con poco uso:** el motor lineal sigue bloqueando el rojo bajo 30 % de uso; el probabilístico lo evita por construcción (una ráfaga corta no se extrapola) y por la histéresis.

## Resultados del backtest (42 simulaciones de 56 días, vs motor lineal)
| | Lineal | Probabilístico |
|---|---|---|
| Brier (días 15-56) | 0,158 | **0,081** |
| ECE | 0,158 | **0,009** |
| Cobertura p10-p90 (instante / uso final) | — | 85 % / 92 % (objetivo 72-88 %: la banda del uso final es algo ancha) |
| Falsas alarmas en rojo | 44 % | **23 %** |
| Perdidas en rojo | 4 % | 11 % (ámbar+rojo: 4 % vs 2 %) |
| Cambios de veredicto por ventana | 80 | **1,5** |
| CPU por lectura | — | p50 0,02 ms · p95 1,7 ms · máx 26 ms |
| Arranque en frío (días 0-3), Brier | 0,190 | 0,134 (ECE 0,072) |

**Límite de estos números:** los usuarios son sintéticos y los escribí yo (`tests/sim.js`), no usuarios reales. Perfiles: bursty, burstygeo, marathon, light, nightowl, planchange, spikes, markov.

## Debilidades conocidas / pendientes
1. **Validar con datos reales** tras ~2 semanas: exportar CSV (popup → Ajustes) y `node tests/replay.js`. El modelo hoy aprende de 7 d como máximo al migrar; luego crece hasta 42 d.
2. Perfil `nightowl` pierde ~60 % de ventanas agotadas (solo 15 casos): no se investigó.
3. Banda del uso final algo ancha (92 % de cobertura para un 80 % nominal).
4. Arranque en frío: ECE 0,072 (justo sobre el objetivo 0,07).
5. No implementado del plan: nota "límite semanal alcanzado" si `seven_day ≥ 100`; el uso semanal solo se muestra, no entra al modelo.
6. Barras semanales: el color sigue por porcentaje (ámbar ≥70 %, rojo ≥90 %); posible mejora: ámbar si van 15 pp por delante del tiempo transcurrido (el usuario aún no lo pidió).
7. Si `utilization` fuera entero en la API real, `quantized` sube el umbral de actividad a 1 pp: nunca probado con datos reales.
8. La proyección del popup se recalcula solo cuando el SW hace una lectura (cada minuto); entre lecturas solo se actualizan cuenta atrás y tiempo transcurrido.

## Pruebas (carpeta `tests/`)
- `model.test.js`: unidad del modelo (RNG, gamma, bloques, ajuste, invariantes del pronóstico, escenarios de arranque en frío, histéresis, calibración, Brier, explicación).
- `background.test.js`: integración del SW con `chrome.*`/`fetch` simulados y reloj controlado (migración, alertas, idle, error, cambio de motor, cambio de ventana).
- `linear-engine.js`: suite completa del motor lineal (garantiza la vuelta atrás).
- `sim.js` (usuarios sintéticos), `backtest.js`, `metrics.js`, `run-backtest.js` (paralelo; `--dump archivo.json` guarda los registros), `replay.js` (CSV real), `load.js` (carga los archivos reales en un ámbito sin modificarlos).
- `tools/`: `chrome-e2e.js` (Chrome real), `sweep-thresholds.js`, `reliability.js`, `segment-calibration.js` (análisis sobre un `--dump`; ver su uso en el código).

## Trucos que costó descubrir
- **Chrome de marca (v137+) ignora `--load-extension`.** Para probar la extensión real: lanzar con `--remote-debugging-pipe --enable-unsafe-extension-debugging` y llamar `Extensions.loadUnpacked` por el pipe (fd 3 escribe, fd 4 lee, mensajes terminados en `\0`). `tests/tools/chrome-e2e.js` lo hace: siembra historial, evalúa `poll()` dentro del service worker (con `fetch` simulado), lee el badge/tooltip y captura el popup en claro/oscuro con `Emulation.setEmulatedMedia`.
- Capturas del popup con datos simulados sin extensión: página con un `mock.js` que define `window.chrome` y `chrome --headless=new --screenshot`.
- `Write`/`Edit` fallan si el archivo cambió desde la última lectura (pasó cada vez que se editaba con Python); releer primero.
- En macOS `sed -i` necesita `''`.
- Los tests no deben depender de milisegundos (una muestra justo en el borde de una ventana volvió flaky un test).

## Historial resumido de versiones
- **1.0** original del usuario (widget + popup, lineal).
- **1.x** revisión: carrera en `storage`, org equivocada, notificaciones, reinicio de ventana, ETA vs reinicio, claves epoch, Shadow DOM, etc.
- **2.0** badge con veredicto, ícono con dos anillos, popup con gráficos y tablas, historial 7 días, alertas anticipadas, widget reactivable.
- **3.0** motor probabilístico (este documento), recalibración, banda de incertidumbre, ajustes de motor, exportar bloques, precisión visible, tests y backtest.
- Después de 3.0: barra de tiempo transcurrido en el uso semanal.

## Nota: número sin fondo en el badge (probado, no se puede)
Chrome pinta siempre un rectángulo de fondo en el badge nativo: con `setBadgeBackgroundColor` en `[0,0,0,0]` y en `[0,0,0,1]` el usuario lo vio negro. `getBadgeBackgroundColor` devuelve el valor guardado, pero el renderizado lo ignora. La única forma de mostrar el número sin rectángulo es dibujarlo dentro del ícono (`badgeStyle: "icon"`, `drawIconText` en `core.js`, con borde fino translúcido). Pendiente de que el usuario confirme si ese estilo le sirve; si no, la alternativa es quitar el número del ícono (el anillo ya cambia de color).

## Ajustes del ícono (estado actual)
- `badgeStyle`: `solid` (badge de Chrome con fondo de color) | `inside` (número dibujado dentro del ícono). Valores antiguos `icon`/`center`/`clear` se tratan como `inside` (`center` además implica la forma `donut`).
- `iconShape`: `rings` (dos anillos) | `donut` (donut de uso + anillo fino de tiempo) | `pie1` (torta de uso) | `pie2` (torta + anillo de tiempo) | `pie3` (torta de uso + torta pequeña de tiempo). Se dibujan en `drawIcon` (`core.js`).
- `numberAlpha` (0,15–1, por defecto 0,48): opacidad del número, con barra en el popup. `numberInk` (auto/light/dark) y `colorScheme` (lo informan popup y página) eligen su color para contrastar con la barra de Chrome.
- El número dentro del ícono muestra solo los dígitos (sin `%`, `m` ni `-`).

## Puente con la app del Dock (`../claude_usage_dock`)
`background.js` envía `usageState` por `POST http://127.0.0.1:47831/state` después de cada consulta (`pushToDock`, falla en silencio si la app no corre; permiso `host_permissions` en el manifest). La consulta pasó a cada 30 s (`POLL_MINUTES = 0.5`) para refrescar el ícono más seguido. La app solo acepta orígenes `chrome-extension://`. Si cambia el formato de `usageState`, hay que reconstruir la app (`npm run sync && npm run build`).


## Historial semanal (añadido)
- `usageWeekly`: [key, reinicio, pico, [[ts, uso],…]] por ciclo y cupo. `updateWeeklyLog` en model.js; lo llama `step`. Retención 400 días, no se borra con «Borrar historial». Base para proyectar el tope semanal (aún no hay modelo semanal).
