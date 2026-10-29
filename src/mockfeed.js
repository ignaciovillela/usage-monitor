// Datos simulados (USAGE_MONITOR_MOCK=1) para ver el ícono moverse sin iniciar sesión.
// Un ciclo de 6 min: el uso sube de ~8 % a ~97 % con ráfagas y pausas, y vuelve a empezar.
const CYCLE_MS = 6 * 60 * 1000;
const start = Date.now();
function next() {
  const now = Date.now();
  const phase = ((now - start) % CYCLE_MS) / CYCLE_MS;
  const burst = Math.sin(phase * 40) > 0.25 ? 1 : 0.35;     // ráfagas y pausas
  const util = Math.min(100, 8 + 89 * Math.pow(phase, 1.15) * (0.8 + 0.2 * burst));
  const cycleStart = now - phase * CYCLE_MS;
  return { utilization: +util.toFixed(1), resetsAt: cycleStart + 110 * 60 * 1000, idle: false,
    weekly: [{ key: "seven_day", utilization: 41, resetsAt: now + 3.5 * 864e5 }] };
}
module.exports = { next };
