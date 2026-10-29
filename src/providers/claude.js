// Proveedor de uso: Claude (claude.ai). Es lo único del proyecto que conoce el servicio.
//
// Contrato (ver docs/ADAPTING.md):
//   pageScript(cachedOrgId) => string   código que se ejecuta DENTRO de la página del servicio (mismo origen y cookies del login)
//                                        y devuelve { auth:true } | { retryOrg:true } | { error } | { orgId, data }
//   parseUsage(data) => { utilization 0-100, resetsAt (ms)|null, idle, weekly: [{ key, utilization, resetsAt }] }
//   Los errores de sesión los decide main.js a partir de { auth: true }.
function parseReset(value) {
  if (!value) return null;
  const ts = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}
function parseBucket(bucket) {
  const utilization = Number(bucket && bucket.utilization);
  if (!bucket || !Number.isFinite(utilization)) return null;
  return { utilization: Math.max(0, Math.min(100, utilization)), resetsAt: parseReset(bucket.resets_at) };
}
// Misma interpretación que background.js de la extensión.
function parseUsage(data) {
  if (!data || typeof data !== "object" || !("five_hour" in data)) {
    throw new Error("Respuesta de uso inesperada: no se encontró five_hour.");
  }
  let five = parseBucket(data.five_hour);
  let idle = false;
  if (!five) {
    if (data.five_hour !== null) throw new Error("Respuesta de uso inesperada: five_hour.utilization inválido.");
    five = { utilization: 0, resetsAt: null };
    idle = true;
  }
  const weekly = Object.keys(data)
    .filter(key => key.startsWith("seven_day"))
    .map(key => ({ key, ...parseBucket(data[key]) }))
    .filter(w => Number.isFinite(w.utilization));
  return { ...five, idle, weekly };
}

// Se ejecuta DENTRO de la página de claude.ai (mismo origen y cookies), así no se manejan cookies a mano.
function pageScript(cachedOrgId) {
  return `(async (cachedOrg) => {
    const get = async (u) => {
      const r = await fetch(u, { credentials: "include", headers: { Accept: "application/json" } });
      let body = null; try { body = await r.json(); } catch (_) {}
      return { status: r.status, body };
    };
    let orgId = cachedOrg;
    if (!orgId) {
      const o = await get("/api/organizations");
      if (o.status === 401 || o.status === 403) return { auth: true, status: o.status };
      if (o.status !== 200 || !Array.isArray(o.body) || !o.body.length) return { error: "organizaciones: HTTP " + o.status };
      const withId = o.body.filter(x => x.uuid || x.id);
      const org = withId.find(x => Array.isArray(x.capabilities) && x.capabilities.includes("chat")) || withId[0];
      if (!org) return { error: "sin identificador de organización" };
      orgId = org.uuid || org.id;
    }
    const u = await get("/api/organizations/" + encodeURIComponent(orgId) + "/usage");
    if (u.status === 404) return { retryOrg: true };
    if (u.status === 401 || u.status === 403) return { auth: true, status: u.status };
    if (u.status !== 200) return { error: "uso: HTTP " + u.status };
    return { orgId, data: u.body };
  })(${JSON.stringify(cachedOrgId || null)})`;
}
module.exports = { parseUsage, pageScript };
