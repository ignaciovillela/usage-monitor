// Prueba las fuentes en orden. Un «sin ventana activa» (idle) de una fuente de respaldo NO se acepta: el archivo de la línea de estado
// solo se actualiza mientras Claude Code está activo, así que si la fuente principal falló ese idle sería un 0 falso y el uso «se perdería».
// En ese caso se informa el error de la fuente principal (p. ej. llavero denegado) y el estado conserva el último dato bueno.
async function pickUsage(order, readers) {
  const errs = {};
  for (const via of order) {
    try {
      const usage = await readers[via]();
      const fellBack = via !== order[0];
      if (fellBack && usage.idle) { errs[via] = Object.assign(new Error("Fuente principal sin respuesta y el respaldo no tiene ventana activa; se conserva el último dato."), { kind: "stale" }); continue; }
      return { ...usage, via, fellBack };
    } catch (e) { errs[via] = e; }
  }
  const first = order[0];
  const primary = errs[first] && errs[first].kind !== "nofeed" ? errs[first] : null;
  throw errs.web || primary || errs.oauth || errs["claude-code"] || errs[first];
}
module.exports = { pickUsage };
