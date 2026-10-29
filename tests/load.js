// Carga los archivos reales del modelo (renderer/panel) en un mismo ámbito (como importScripts) y exporta sus símbolos.
// No modifica los archivos: extrae los nombres de nivel superior (function X / const X) con una regex.
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "renderer", "panel");

function load(files = ["util.js", "core.js", "model.js"], globals = {}) {
  const src = files.map(f => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
  const names = new Set();
  for (const m of src.matchAll(/^(?:async\s+)?function\s+(\w+)|^const\s+(\w+)|^let\s+(\w+)/gm)) names.add(m[1] || m[2] || m[3]);
  for (const m of src.matchAll(/^const\s+\w+\s*=\s*[^;\n]*?,\s*(\w+)\s*=/gm)) names.add(m[1]); // const A = 1, B = 2
  const argNames = Object.keys(globals);
  const fn = new Function(...argNames, `${src}\nreturn {${[...names].map(n => `${n}: typeof ${n} === "undefined" ? undefined : ${n}`).join(",")}};`);
  return fn(...argNames.map(k => globals[k]));
}
module.exports = { load, ROOT };
