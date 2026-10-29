// Arma build/icon.ico (Windows) a partir de los PNG que genera `electron . --make-icon`.
// Un .ico es una cabecera + un directorio + imágenes; aquí cada imagen es un PNG completo (válido desde Windows Vista).
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "build");
const sizes = [16, 32, 48, 64, 128, 256];
const images = sizes.map(n => ({ n, data: fs.readFileSync(path.join(dir, `icon-${n}.png`)) }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
let offset = 6 + 16 * images.length;
const entries = images.map(({ n, data }) => {
  const e = Buffer.alloc(16);
  e[0] = n === 256 ? 0 : n; e[1] = n === 256 ? 0 : n;      // 0 significa 256
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);           // planos, bits por píxel
  e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
  offset += data.length;
  return e;
});
fs.writeFileSync(path.join(dir, "icon.ico"), Buffer.concat([header, ...entries, ...images.map(i => i.data)]));
console.log("build/icon.ico creado");
