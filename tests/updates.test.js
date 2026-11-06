const test = require("node:test");
const assert = require("node:assert");
const { compareVersions, latestRelease, repoUrls, advice, isPrerelease } = require("../src/updates");

test("compara versiones (con o sin v, prerelease antes que estable)", () => {
  assert.strictEqual(compareVersions("0.4.0", "v0.4.1"), -1);
  assert.strictEqual(compareVersions("v1.0.0", "0.9.9"), 1);
  assert.strictEqual(compareVersions("0.4.0", "0.4.0"), 0);
  assert.strictEqual(compareVersions("0.4.0-beta.1", "0.4.0"), -1);
  assert.strictEqual(compareVersions("basura", "0.4.0"), 0);
});
test("último release: el de versión más alta, sin borradores (los pre-release cuentan)", () => {
  const r = latestRelease([
    { tag_name: "v0.3.2", html_url: "u32", prerelease: true },
    { tag_name: "v0.5.0", html_url: "u50", draft: true },
    { tag_name: "v0.4.1", html_url: "u41", prerelease: true },
    { tag_name: "nightly" }
  ]);
  assert.deepStrictEqual(r, { version: "0.4.1", url: "u41" });
  assert.strictEqual(latestRelease([]), null);
});
test("repositorio desde package.json y variable para cambiar la API", () => {
  const pkg = { repository: { url: "https://github.com/ana/usage-monitor.git" } };
  assert.deepStrictEqual(repoUrls(pkg, {}), { api: "https://api.github.com/repos/ana/usage-monitor/releases?per_page=40", page: "https://github.com/ana/usage-monitor/releases", repo: "https://github.com/ana/usage-monitor", base: "https://api.github.com/repos/ana/usage-monitor" });
  assert.strictEqual(repoUrls(pkg, { USAGE_MONITOR_RELEASES_URL: "https://x/api" }).api, "https://x/api");
  assert.deepStrictEqual(repoUrls({}, {}), { api: null, page: null, repo: null, base: null });
});
test("avisos: app vieja, servidor viejo, servidor más nuevo que la app, todo al día", () => {
  const latest = { version: "0.5.0", url: "rel" };
  const kinds = a => a.map(x => `${x.kind}@${x.version}`);
  assert.deepStrictEqual(kinds(advice({ appVersion: "0.4.0", serverVersion: "0.4.0", latest })), ["app@0.5.0", "server@0.5.0"]);
  assert.deepStrictEqual(kinds(advice({ appVersion: "0.5.0", serverVersion: "0.4.0", latest })), ["server@0.5.0"]);
  assert.deepStrictEqual(kinds(advice({ appVersion: "0.5.0", serverVersion: "0.5.0", latest })), []);
  // Sin consultar releases: solo se compara app y servidor.
  assert.deepStrictEqual(kinds(advice({ appVersion: "0.4.0", serverVersion: "0.3.2", latest: null })), ["server@0.4.0"]);
  assert.deepStrictEqual(kinds(advice({ appVersion: "0.4.0", serverVersion: "0.4.1", latest: null })), ["app@0.4.1"]);
  // Sin servidor o con un servidor que no dice su versión: solo la app.
  assert.deepStrictEqual(kinds(advice({ appVersion: "0.4.0", serverVersion: null, latest })), ["app@0.5.0"]);
  assert.match(advice({ appVersion: "0.5.0", serverVersion: "0.4.0", latest })[0].text, /docker compose pull/);
});
test("la app y el servidor comparten número de versión", () => {
  assert.strictEqual(require("../server/package.json").version, require("../package.json").version);
});

test("versiones de dev: se ordenan por número de build y van antes que su estable", () => {
  assert.strictEqual(compareVersions("0.4.0-dev.41", "0.4.0-dev.42"), -1);
  assert.strictEqual(compareVersions("0.4.0-dev.100", "0.4.0-dev.99"), 1);
  assert.strictEqual(compareVersions("0.4.0-dev.42", "0.4.0"), -1);
  assert.strictEqual(compareVersions("0.4.0-dev.42", "0.3.2"), 1);
  assert.strictEqual(compareVersions("v0.4.0-dev.42", "0.4.0-dev.42"), 0);
  assert.ok(isPrerelease("0.4.0-dev.1") && !isPrerelease("0.4.0"));
});
test("canal: la app estable solo ve estables; la de dev ve también los de dev", () => {
  const list = [
    { tag_name: "v0.3.2", html_url: "s" },
    { tag_name: "v0.4.0-dev.41", html_url: "d41" },
    { tag_name: "v0.4.0-dev.42", html_url: "d42" },
    { tag_name: "dev", html_url: "viejo" }
  ];
  assert.deepStrictEqual(latestRelease(list), { version: "0.3.2", url: "s" });
  assert.deepStrictEqual(latestRelease(list, { includeDev: true }), { version: "0.4.0-dev.42", url: "d42" });
  assert.deepStrictEqual(latestRelease([...list, { tag_name: "v0.4.0", html_url: "e" }], { includeDev: true }), { version: "0.4.0", url: "e" });
  // App de dev: avisa del dev más nuevo y del servidor atrasado; estable sin dev más nuevo no avisa.
  const latest = { version: "0.4.0-dev.42", url: "d42" };
  const kinds = a => a.map(x => `${x.kind}@${x.version}`);
  assert.deepStrictEqual(kinds(advice({ appVersion: "0.4.0-dev.41", serverVersion: "0.4.0-dev.40", latest })), ["app@0.4.0-dev.42", "server@0.4.0-dev.42"]);
  assert.deepStrictEqual(kinds(advice({ appVersion: "0.4.0-dev.42", serverVersion: "0.4.0-dev.42", latest })), []);
});

test("canal elegido: main o dev; sin elegir, lo decide la versión de la app", () => {
  const { effectiveChannel } = require("../src/updates");
  assert.strictEqual(effectiveChannel("", "0.4.0-dev.5"), "dev");
  assert.strictEqual(effectiveChannel("", "0.3.2"), "main");
  assert.strictEqual(effectiveChannel("dev", "0.3.2"), "dev");
  assert.strictEqual(effectiveChannel("main", "0.4.0-dev.5"), "main");
  assert.strictEqual(effectiveChannel("otro", "0.3.2"), "main");
});
test("canal main con una app de dev: ofrece volver a la estable", () => {
  const latest = { version: "0.3.2", url: "s" };
  const a = advice({ appVersion: "0.4.0-dev.52", latest, channel: "main" });
  assert.strictEqual(a.length, 1);
  assert.ok(a[0].switch && a[0].version === "0.3.2");
  assert.deepStrictEqual(advice({ appVersion: "0.4.0-dev.52", latest, channel: "dev" }), []);
  assert.deepStrictEqual(advice({ appVersion: "0.3.2", latest, channel: "main" }), []);
});
test("resumen de la actualización: notas de los releases intermedios y commits, sin merges ni notas genéricas", () => {
  const { summarize, commitLine, notesLines } = require("../src/updates");
  assert.strictEqual(commitLine("feat(server): usar el login de Claude Code\n\ncuerpo"), "Usar el login de Claude Code");
  assert.strictEqual(commitLine("Merge pull request #24 from x/y"), null);
  assert.deepStrictEqual(notesLines("## v1\n\n- **Uno**\n- `dos`\n```\n- no\n```\ntexto"), ["Uno", "dos"]);
  assert.deepStrictEqual(notesLines("Compilación automática de la rama dev (abc). No es estable."), []);
  const releases = [
    { tag_name: "v0.3.1", body: "- vieja", html_url: "u31" },
    { tag_name: "v0.3.2", body: "- arreglo A\n- arreglo B", html_url: "u32" },
    { tag_name: "v0.4.0-dev.52", body: "Compilación automática de la rama dev (941fed7).", html_url: "u52" }
  ];
  const commits = [{ commit: { message: "fix(windows): ícono en la barra" } }, { commit: { message: "Merge pull request #23" } }];
  const s = summarize({ from: "0.3.1", to: "0.4.0-dev.52", releases, commits });
  assert.deepStrictEqual(s.items, ["arreglo A", "arreglo B", "Ícono en la barra"]);
  assert.strictEqual(s.url, "u52");
  assert.strictEqual(s.downgrade, false);
  // De dev a main (versión menor): solo las notas de la de destino, sin commits.
  const d = summarize({ from: "0.4.0-dev.52", to: "0.3.2", releases, commits });
  assert.deepStrictEqual(d.items, ["arreglo A", "arreglo B"]);
  assert.ok(d.downgrade);
  assert.strictEqual(summarize({ from: "0.3.1", to: "0.3.2", releases, max: 1 }).more, 1);
});
