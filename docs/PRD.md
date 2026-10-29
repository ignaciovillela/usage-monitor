# PRD — Usage Monitor (app de escritorio)

Versión 3.0 · Proyecto de código abierto, **no oficial y sin relación con Anthropic**.

## 1. Resumen

Usage Monitor responde, sin abrir nada, una pregunta: **¿me voy a quedar sin límite de uso de Claude antes de que se reinicie la ventana de 5 horas?** Es una app de escritorio (macOS y Windows) que muestra la respuesta en el ícono del Dock (macOS) o de la bandeja del sistema (Windows) y ofrece un panel con gráficos para el detalle.

## 2. Problema

El límite de uso de Claude Code se mide en ventanas de 5 h y en un tope semanal. Claude.ai solo muestra el porcentaje actual: no dice a qué ritmo vas ni si llegarás al 100 % antes del reinicio. El límite se descubre cuando ya se alcanzó, en medio del trabajo.

## 3. Objetivos y no objetivos

**Objetivos**
- Ver de un vistazo, en el ícono, si voy bien o no y cuál es la cifra relevante.
- Abrir el detalle gráfico solo cuando haya que decidir algo: frenar, cambiar de modelo, esperar el reinicio.
- Una señal confiable: pocas falsas alarmas y pocos límites sin aviso.

**No objetivos**
- Contar tokens exactos: se lee un porcentaje, no tokens.
- Proyectar el tope semanal: se muestra y se registra su historial, pero no se proyecta.
- **Extensión de Chrome o cualquier componente de navegador:** salió del alcance. La app es el único producto.
- Esquivar verificaciones o protecciones anti-bots de claude.ai.
- Gestión de cuentas de equipo o facturación; soporte oficial; tiendas de aplicaciones.

## 4. Usuarios

Personas que usan Claude Code de forma intensiva en macOS y quieren administrar su ritmo de uso. Se necesita Node 20+ para compilar la app (no hay binario distribuido) y abrir una app sin firma de desarrollador.

## 5. Funcionalidades

### 5.1 Conexión con la cuenta
- La app abre una ventana de **claude.ai** en la que inicias sesión una vez; la sesión persiste entre ejecuciones. La lectura del uso se hace **desde esa misma página** (mismo origen y cookies), así que la app no maneja contraseñas ni cookies a mano.
- La ventana se muestra sola cuando no hay sesión, cuando claude.ai no carga en 30 s o tras dos fallos seguidos, y se oculta sola cuando vuelven los datos. Siempre disponible desde el menú del Dock.
- Consulta cada 20 s (configurable: 10, 20, 30 o 60 s); con errores espacia las consultas hasta 5 min.
- Sin lecturas durante 5 min, el ícono se pone gris y avisa, en vez de mostrar un dato viejo.

### 5.2 Ícono del Dock
- Anillo exterior = uso de la ventana (color del veredicto); anillo interior = tiempo transcurrido. Formas: dos anillos, donut, torta 1/2/3.
- Número opcional dentro: veredicto (solo si hay riesgo), probabilidad de agotar, porcentaje, tiempo hasta el límite o hasta el reinicio. Tamaño, posición y transparencia configurables.
- Se redibuja cada 5 s y solo si algo visible cambió.
- Menú del Dock: estado, ajustes, abrir al iniciar sesión, mover a Aplicaciones, ventana de claude.ai.
- Primera ejecución: ofrece moverse a `/Applications` y activa el inicio automático una vez.

### 5.3 Panel (clic en el ícono)
- Cifra principal y titular («43 % de probabilidad de agotarlo · mediana 12:58 · rango 12:24–13:28»), línea que explica el veredicto.
- Gráficos, cada uno con vista de tabla: proyección de la ventana (uso real, mediana, banda del 80 %, hora de agotamiento), consumo por hora, picos por ventana y uso semanal con el tiempo transcurrido.
- Ajustes del ícono con vista previa; exportación a CSV (lecturas y semanal).
- Alertas de macOS: 80 %, 90 % y aviso anticipado, una vez por ventana, cuando el agotamiento es probable y cercano.

### 5.4 Motor de proyección
- Bloques de 10 min en que el usuario está *activo* o *en pausa* (cadena de Markov por hora, día y antigüedad de la sesión); si está activo, el bloque suma un escalón de tamaño aprendido y escalado por la intensidad de la ventana actual.
- 400 simulaciones Monte Carlo hasta el reinicio → P(llegar al 100 %), hora mediana y rango p10–p90. Semilla fija por ventana: el resultado cambia solo cuando cambian los datos.
- Veredicto con histéresis; recalibración logística con ≥ 12 ventanas cerradas; Brier visible en Ajustes.
- Aprende de hasta 42 días con vida media de 21 días; sin historial usa valores típicos y avisa «aún aprendiendo».

### 5.5 Datos locales
| Dato | Retención |
|---|---|
| Lecturas | 7 días |
| Bloques de 10 min | 42 días |
| Ventanas (pico, agotó o no) | 180 días |
| Registro de pronósticos | 90 días |
| Historial semanal | 400 días |

Todo en `~/Library/Application Support/Usage Monitor`. No hay servidor propio ni telemetría; no se guardan conversaciones.

## 6. Resultados medidos

Backtest con usuarios sintéticos (56 días), contra el motor lineal:

| Métrica | Probabilístico | Lineal |
|---|---|---|
| Brier de P(agotar) (menor es mejor) | 0,081 | 0,158 |
| Alarmas rojas que no se cumplen | 23 % | 44 % |
| Límites alcanzados sin alarma roja | 11 % (4 % sin ámbar ni rojo) | 4 % (2 %) |
| Cambios de veredicto por ventana | 1,5 | 80 |
| CPU por lectura (p95) | 1,7 ms | — |

Lectura honesta: acierta más y molesta menos, pero **deja pasar algo más de límites sin aviso rojo** que el lineal. Los datos son sintéticos; con uso real la calibración inicial es peor (error de calibración ~0,07 en arranque en frío) y mejora con las ventanas propias.

## 7. Limitaciones conocidas

| Limitación | Detalle |
|---|---|
| **Inicio de sesión en ventana embebida** | Es la principal incertidumbre. claude.ai puede exigir una verificación o rechazar el inicio de sesión (p. ej. con ciertos proveedores de identidad) en un navegador embebido. La app no intenta disimular que lo es; si el sitio no lo permite, no puede leer el uso. No validado con todas las cuentas. |
| **Endpoint no oficial** | Se usa una API interna de claude.ai que puede cambiar sin aviso; entonces la app deja de leer y muestra un error. Sin respaldo de Anthropic. |
| Granularidad | El porcentaje llega como entero; la proyección es una estimación estadística. |
| Aprendizaje | Tras un cambio brusco de hábitos tarda una o dos semanas en reajustarse. |
| La app debe estar abierta | Solo registra historial mientras corre (por eso se ofrece el inicio automático). |
| **Windows** | Soporte experimental: el ícono dinámico va en la bandeja del sistema (no hay Dock). Compilado por CI y **no probado en un equipo real**; sin firma, así que SmartScreen avisa. Las funciones propias de macOS (mover a Aplicaciones) no existen allí. |
| Sin firma de desarrollador | macOS: firma ad hoc, hay que autorizarla en cada Mac. Los releases son Apple Silicon; en Intel hay que compilar. |
| Solo español | La interfaz no está traducida. |

## 8. Privacidad
Datos solo locales; la app habla únicamente con `claude.ai` (en su ventana de sesión). Se guardan porcentajes y horas de reinicio, no contenido de conversaciones.

## 9. Estado
Funcional y probado con pruebas automatizadas y un autotest sin red. **Pendiente de validar con cuentas reales de varias personas:** el inicio de sesión en la ventana embebida y la precisión del modelo sobre historiales reales (hoy solo hay datos sintéticos).

## 10. Feedback
Lo más útil: si las alarmas rojas se cumplieron, si te quedaste sin límite sin aviso previo, y si el inicio de sesión funcionó (y con qué método). Si algo se ve raro, «Exportar CSV» genera los datos para revisar; no incluye conversaciones, pero revísalo antes de compartirlo.
