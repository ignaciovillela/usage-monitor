// Versiones: compara la de la app y la del servidor (si se usa) con el último release publicado y arma los avisos.
// El repositorio sale de package.json («repository»), así un fork apunta a sus propios releases sin tocar código.
// USAGE_MONITOR_RELEASES_URL lo cambia por otra API compatible (lista de releases de GitHub).

const TIMEOUT_MS = 10000;

// "v0.4.1-dev.42" → { core: [0, 4, 1], pre: ["dev", 42] }. Orden semver: una prerelease va antes que su estable
// (0.4.1-dev.42 < 0.4.1) y entre prereleases se comparan sus partes (dev.41 < dev.42).
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/.exec(String(v || "").trim());
  return m ? { core: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split(".").map(p => /^\d+$/.test(p) ? +p : p) : [] } : null;
}
const isPrerelease = v => { const p = parseVersion(v); return !!p && p.pre.length > 0; };
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    if (typeof p === typeof q) return p < q ? -1 : 1;
    return typeof p === "number" ? -1 : 1;      // semver: los números van antes que el texto
  }
  return 0;
}
const clean = v => String(v).replace(/^v/, "");

function repoUrls(pkg, env = process.env) {
  const raw = pkg && (typeof pkg.repository === "string" ? pkg.repository : pkg.repository && pkg.repository.url) || "";
  const m = /github(?:\.com[/:]|:)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(raw);
  const repo = m ? `https://github.com/${m[1]}/${m[2]}` : null;
  const page = repo && `${repo}/releases`;
  const base = m ? `https://api.github.com/repos/${m[1]}/${m[2]}` : null;      // para comparar versiones (lista de cambios)
  const api = env.USAGE_MONITOR_RELEASES_URL || (base ? `${base}/releases?per_page=40` : null);
  return { api, page, repo, base };
}
// Último release no borrador, por número de versión. El canal lo decide la versión y no la marca «pre-release» de
// GitHub (el proyecto publica sus estables así): sin includeDev se descartan las X.Y.Z-algo, que son las de dev.
function latestRelease(releases, { includeDev = false } = {}) {
  let best = null;
  for (const r of Array.isArray(releases) ? releases : []) {
    if (!r || r.draft || !parseVersion(r.tag_name)) continue;
    if (!includeDev && isPrerelease(r.tag_name)) continue;
    if (!best || compareVersions(r.tag_name, best.tag_name) > 0) best = r;
  }
  return best && { version: clean(best.tag_name), url: best.html_url || null };
}
// Canal de actualizaciones: "main" (solo estables) o "dev" (también las X.Y.Z-dev.N). Sin elegir, la app de dev sigue dev.
const CHANNELS = ["main", "dev"];
const effectiveChannel = (setting, appVersion) => CHANNELS.includes(setting) ? setting : isPrerelease(appVersion) ? "dev" : "main";

async function getJson(url, appVersion) {
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": `usage-monitor/${appVersion}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url.replace(/^.*\/repos\/[^/]+\/[^/]+/, "")}: HTTP ${res.status}`);
  return res.json();
}
async function fetchLatest(api, appVersion, channel = effectiveChannel(null, appVersion)) {
  return latestRelease(await getJson(api, appVersion), { includeDev: channel === "dev" });
}

// Resumen de una actualización (de «from» a «to»): las viñetas de las notas de los releases intermedios y, como las
// notas de dev son genéricas, los títulos de los commits entre ambas versiones. Volver a una versión anterior
// (p. ej. al pasar de dev a main) solo muestra las notas de la versión de destino.
const GENERIC_NOTES = /^Compilación automática/;
function notesLines(body) {
  if (!body || GENERIC_NOTES.test(String(body).trim())) return [];
  let code = false;
  const out = [];
  for (const raw of String(body).split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) { code = !code; continue; }
    const m = !code && /^\s*[-*]\s+(.+)$/.exec(raw);
    if (m) out.push(m[1].replace(/\*\*|__|`/g, "").trim());
  }
  return out;
}
function commitLine(message) {
  const first = String(message || "").split(/\r?\n/)[0].trim();
  if (!first || /^Merge (pull request|branch|remote-tracking)/.test(first)) return null;
  const s = first.replace(/^\w+(\([^)]*\))?!?:\s*/, "");      // «feat(server): …» → «…»
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function summarize({ from, to, releases = [], commits = [], page = null, max = 15 }) {
  from = clean(from); to = clean(to);
  const downgrade = compareVersions(to, from) < 0;
  const inRange = (Array.isArray(releases) ? releases : [])
    .filter(r => r && !r.draft && parseVersion(r.tag_name))
    .filter(r => downgrade ? compareVersions(r.tag_name, to) === 0 : compareVersions(r.tag_name, from) > 0 && compareVersions(r.tag_name, to) <= 0)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  const items = [];
  for (const r of inRange) for (const l of notesLines(r.body)) if (!items.includes(l)) items.push(l);
  if (!downgrade) for (const c of commits) { const l = commitLine(c && c.commit ? c.commit.message : c); if (l && !items.includes(l)) items.push(l); }
  const target = inRange.find(r => compareVersions(r.tag_name, to) === 0);
  return { from, to, downgrade, items: items.slice(0, max), more: Math.max(0, items.length - max), url: (target && target.html_url) || page };
}
async function fetchSummary({ api, base, page }, from, to, appVersion) {
  const [releases, compare] = await Promise.all([
    api ? getJson(api, appVersion).catch(() => []) : [],
    // Los tags de dev antiguos se borran (se conservan 10): si ya no existe, no hay lista de commits.
    base && compareVersions(to, from) > 0 ? getJson(`${base}/compare/v${clean(from)}...v${clean(to)}`, appVersion).catch(() => null) : null
  ]);
  return summarize({ from, to, releases, commits: compare && Array.isArray(compare.commits) ? compare.commits.slice().reverse() : [], page });   // los más nuevos primero
}

// Avisos para mostrar. kind: "app" | "server". Sin release conocido, solo se compara la app con el servidor.
function advice({ appVersion, serverVersion, latest, releasesPage, channel }) {
  const out = [];
  const url = (latest && latest.url) || releasesPage || null;
  if (latest && compareVersions(appVersion, latest.version) < 0) {
    out.push({ kind: "app", version: latest.version, url, text: `Hay una versión nueva de la app: v${latest.version} (tienes v${clean(appVersion)}).` });
  } else if (latest && channel === "main" && isPrerelease(appVersion) && compareVersions(appVersion, latest.version) !== 0) {
    // Canal estable con una versión de dev instalada: se ofrece volver a la última estable.
    out.push({ kind: "app", version: latest.version, url, switch: true, text: `Elegiste el canal estable (main): la última estable es v${latest.version} y tienes la de desarrollo v${clean(appVersion)}.` });
  }
  if (serverVersion && parseVersion(serverVersion)) {
    const target = latest && compareVersions(latest.version, appVersion) > 0 ? latest.version : clean(appVersion);
    if (compareVersions(serverVersion, target) < 0) {
      out.push({ kind: "server", version: target, url, text: `El servidor está en v${clean(serverVersion)}; actualízalo a v${target} (docker compose pull && docker compose up -d).` });
    } else if (compareVersions(serverVersion, appVersion) > 0 && !out.some(a => a.kind === "app")) {
      out.push({ kind: "app", version: clean(serverVersion), url, text: `El servidor está en v${clean(serverVersion)} y la app en v${clean(appVersion)}: actualiza la app.` });
    }
  }
  return out;
}
module.exports = { parseVersion, isPrerelease, compareVersions, repoUrls, latestRelease, fetchLatest, advice, CHANNELS, effectiveChannel, notesLines, commitLine, summarize, fetchSummary };
