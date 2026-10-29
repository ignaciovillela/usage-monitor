# Adaptar el proyecto a otra suscripción o servicio

El modelo de proyección no sabe nada de Claude: recibe, en cada lectura, **un porcentaje de uso de una ventana que se reinicia**. Todo lo específico de claude.ai está en pocos lugares.

## 1. El contrato del proveedor

`src/providers/claude.js` exporta dos funciones; para otro servicio, escribe un archivo equivalente y cámbialo en el `require` de `src/main.js`:

```js
pageScript(cachedOrgId) => string
// Código que se ejecuta DENTRO de la página del servicio (mismo origen y cookies del login). Devuelve:
//   { auth: true }  sesión caducada o sin permiso    { retryOrg: true }  el id en caché ya no sirve
//   { error: "..." } fallo legible                    { orgId, data }     respuesta cruda del servicio

parseUsage(data) => {
  utilization: number,        // 0–100: porcentaje usado de la ventana corta
  resetsAt: number | null,    // ms epoch del próximo reinicio de esa ventana
  idle: boolean,              // sin ventana activa: utilization 0 y resetsAt null
  weekly: [{ key, utilization, resetsAt }]   // cupos largos (semanal, mensual…); puede ser []
}
```
Leer desde la página evita manejar cookies o tokens a mano: **no los copies ni los guardes**. Si el servicio usa una API con clave propia, ten en cuenta sus términos antes de leerla.

## 2. Qué más cambiar

| Dónde | Qué |
|---|---|
| `src/main.js` | URL y dominio de la ventana de sesión (`claude.ai`), título, partición de sesión y los textos de estado |
| `renderer/panel/core.js` | `WINDOW_MS` (duración de la ventana corta, hoy 5 h) y `WEEKLY_LABELS` (nombres de los cupos largos) |
| `renderer/panel/*`, `src/main.js` | Textos que dicen «Claude» / «claude.ai» (la interfaz está en español) |

## 3. Supuestos del modelo (revísalos antes de confiar en la salida)

- El uso es un **porcentaje que sube** dentro de una ventana y **vuelve a 0 en el reinicio** (el reinicio se detecta por una caída grande o un cambio de `resetsAt`).
- La ventana dura horas, no días: los bloques son de 10 min y las probabilidades dependen de la hora y el día de la semana. Para un cupo mensual o diario el motor probabilístico no está pensado.
- Con datos enteros el modelo lo detecta solo (umbral de 1 punto).
- La calibración mejora con ≥ 12 ventanas cerradas; antes usa valores típicos.

## 4. Cómo comprobar tu proveedor

1. `npm test` (modelo) y `npm run selftest` (dibujo del ícono y flujo del modelo, sin red).
2. `USAGE_MONITOR_MOCK=1 npm start` muestra el ícono con datos simulados; `USAGE_MONITOR_DEBUG=1` imprime los redibujos.
3. Tras unos días, «Exportar CSV» en el panel y `node tests/replay.js tu.csv` miden el modelo con tus ventanas reales.
