// Formato compartido por el service worker, el popup y el monitor integrado en la página.
const LOCALE = "es";

function fmtDuration(mins) {
  if (!Number.isFinite(mins)) return "—";
  const n = Math.max(0, Math.round(mins));
  const h = Math.floor(n / 60), m = n % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
}
function fmtReset(ts) {
  if (!Number.isFinite(ts)) return "No disponible";
  const diff = ts - Date.now();
  return diff <= 0 ? "Reinicio próximo" : fmtDuration(diff / 60000);
}
function fmtClock(ts) {
  return Number.isFinite(ts)
    ? new Date(ts).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", hour12: false })
    : "—";
}
function fmtPct(value, digits = 1) {
  return Number.isFinite(value)
    ? `${value.toLocaleString(LOCALE, { minimumFractionDigits: 0, maximumFractionDigits: digits })}%`
    : "—%";
}
