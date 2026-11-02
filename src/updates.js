// Versiones: compara la de la app y la del servidor (si se usa) con el último release publicado y arma los avisos.
// El repositorio sale de package.json («repository»), así un fork apunta a sus propios releases sin tocar código.
// USAGE_MONITOR_RELEASES_URL lo cambia por otra API compatible (lista de releases de GitHub).

const TIMEOUT_MS = 10000;

// "v0.4.1" → [0, 4, 1, pre] donde pre=0 si es estable (una prerelease «0.4.1-beta» va antes que «0.4.1»).
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-[\w.]+)?$/.exec(String(v || "").trim());
  return m ? [+m[1], +m[2], +m[3], m[4] ? -1 : 0] : null;
}
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
const clean = v => String(v).replace(/^v/, "");

function repoUrls(pkg, env = process.env) {
  const raw = pkg && (typeof pkg.repository === "string" ? pkg.repository : pkg.repository && pkg.repository.url) || "";
  const m = /github(?:\.com[/:]|:)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(raw);
  const repo = m ? `https://github.com/${m[1]}/${m[2]}` : null;
  const page = repo && `${repo}/releases`;
  const api = env.USAGE_MONITOR_RELEASES_URL || (m ? `https://api.github.com/repos/${m[1]}/${m[2]}/releases?per_page=20` : null);
  return { api, page, repo };
}
// Último release no borrador, por número de versión (los releases del proyecto se publican como pre-release en GitHub).
function latestRelease(releases) {
  let best = null;
  for (const r of Array.isArray(releases) ? releases : []) {
    if (!r || r.draft || !parseVersion(r.tag_name)) continue;
    if (!best || compareVersions(r.tag_name, best.tag_name) > 0) best = r;
  }
  return best && { version: clean(best.tag_name), url: best.html_url || null };
}
async function fetchLatest(api, appVersion) {
  const res = await fetch(api, { headers: { Accept: "application/vnd.github+json", "User-Agent": `usage-monitor/${appVersion}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`releases: HTTP ${res.status}`);
  return latestRelease(await res.json());
}

// Avisos para mostrar. kind: "app" | "server". Sin release conocido, solo se compara la app con el servidor.
function advice({ appVersion, serverVersion, latest, releasesPage }) {
  const out = [];
  const url = (latest && latest.url) || releasesPage || null;
  if (latest && compareVersions(appVersion, latest.version) < 0) {
    out.push({ kind: "app", version: latest.version, url, text: `Hay una versión nueva de la app: v${latest.version} (tienes v${clean(appVersion)}).` });
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
module.exports = { parseVersion, compareVersions, repoUrls, latestRelease, fetchLatest, advice };
