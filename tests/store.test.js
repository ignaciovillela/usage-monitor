const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// store.js lee electron.app.getPath: se simula con un módulo mínimo para probar loadSettings sin Electron.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-store-"));
const Module = require("module");
const load = Module._load;
Module._load = function (request, ...rest) { return request === "electron" ? { app: { getPath: () => dir } } : load.call(this, request, ...rest); };
const store = require("../src/store");

test("ajustes heredados con source desconocido vuelven al valor por defecto y conservan el resto", () => {
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ source: "extension", shape: "pie2", alpha: 0.65 }));
  const s = store.loadSettings();
  assert.equal(s.source, "claude-code");
  assert.equal(s.shape, "pie2");
  assert.equal(s.alpha, 0.65);
});
test("source válido se respeta", () => {
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ source: "web" }));
  assert.equal(store.loadSettings().source, "web");
});
