const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { pickAsset, download } = require("../src/selfupdate");

const assets = [
  { name: "Usage-Monitor-v0.4.0-macos-arm64.dmg", url: "m" },
  { name: "Usage-Monitor-v0.4.0-windows-x64.zip", url: "w" }
];
test("elige el instalador de cada sistema (solo Windows x64 y macOS Apple Silicon)", () => {
  assert.strictEqual(pickAsset(assets, "win32", "x64").url, "w");
  assert.strictEqual(pickAsset(assets, "darwin", "arm64").url, "m");
  assert.strictEqual(pickAsset(assets, "darwin", "x64"), null);
  assert.strictEqual(pickAsset(assets, "win32", "arm64"), null);
  assert.strictEqual(pickAsset(assets, "linux", "x64"), null);
  assert.strictEqual(pickAsset(undefined, "win32", "x64"), null);
});

function serve(body) {
  return new Promise(resolve => {
    const srv = http.createServer((_q, res) => { res.writeHead(200, { "Content-Length": body.length }); res.end(body); });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}
test("descarga con progreso y comprueba el sha256; si no coincide, borra el archivo", async () => {
  const body = crypto.randomBytes(300000);
  const srv = await serve(body);
  const url = `http://127.0.0.1:${srv.address().port}/x.zip`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-dl-"));
  try {
    const good = `sha256:${crypto.createHash("sha256").update(body).digest("hex")}`;
    const seen = [];
    const f = await download({ name: "x.zip", url, digest: good }, path.join(dir, "a.zip"), { onProgress: (r, t) => seen.push([r, t]) });
    assert.deepStrictEqual(fs.readFileSync(f), body);
    assert.deepStrictEqual(seen[seen.length - 1], [body.length, body.length]);
    const bad = `sha256:${"0".repeat(64)}`;
    await assert.rejects(download({ name: "x.zip", url, digest: bad }, path.join(dir, "b.zip")), /sha256/);
    assert.ok(!fs.existsSync(path.join(dir, "b.zip")));
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("cancelar la descarga no deja el archivo a medias", async () => {
  const srv = await serve(crypto.randomBytes(5000000));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-dl-"));
  try {
    const ctrl = new AbortController();
    const p = download({ name: "x.zip", url: `http://127.0.0.1:${srv.address().port}/x.zip` }, path.join(dir, "c.zip"), { signal: ctrl.signal, onProgress: () => ctrl.abort() });
    await assert.rejects(p);
    assert.ok(!fs.existsSync(path.join(dir, "c.zip")));
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
