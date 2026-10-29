// Carga util.js, core.js y model.js (renderer/panel) en un mismo ámbito, como importScripts en el service worker.
// No se modifican: se extraen los nombres de nivel superior con una regex.
const fs = require("fs");
const path = require("path");

function loadShared() {
  const dir = path.join(__dirname, "..", "renderer", "panel");
  const src = ["util.js", "core.js", "model.js"].map(f => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  const names = new Set();
  for (const m of src.matchAll(/^(?:async\s+)?function\s+(\w+)|^const\s+(\w+)|^let\s+(\w+)/gm)) names.add(m[1] || m[2] || m[3]);
  for (const m of src.matchAll(/^const\s+\w+\s*=\s*[^;\n]*?,\s*(\w+)\s*=/gm)) names.add(m[1]);
  const exportList = [...names].map(n => `${n}: typeof ${n} === "undefined" ? undefined : ${n}`).join(",");
  return new Function(`${src}\nreturn {${exportList}};`)();
}
module.exports = loadShared();
