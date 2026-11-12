// Actualizar desde la app: elige el instalador del release para este sistema, lo descarga informando el progreso y
// comprueba su sha256 (GitHub lo publica como «digest» de cada archivo). Instalarlo lo hacen los scripts de scripts/.
const fs = require("fs");
const crypto = require("crypto");

const ASSETS = { win32: /windows-x64\.zip$/, darwin: /macos-arm64\.dmg$/ };
function pickAsset(assets, platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch !== "arm64") return null;      // solo se publican builds de Apple Silicon
  if (platform === "win32" && arch !== "x64") return null;
  const re = ASSETS[platform];
  return (re && (Array.isArray(assets) ? assets : []).find(a => a && re.test(a.name))) || null;
}

// onProgress(recibidos, total) como mucho cada 200 ms y al terminar. signal: AbortSignal para cancelar.
async function download(asset, dest, { onProgress = () => {}, signal, userAgent = "usage-monitor" } = {}) {
  const res = await fetch(asset.url, { headers: { "User-Agent": userAgent }, signal });
  if (!res.ok || !res.body) throw new Error(`No se pudo descargar ${asset.name} (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length")) || asset.size || 0;
  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(dest);
  const done = new Promise((resolve, reject) => { out.once("finish", resolve); out.once("error", reject); });
  let received = 0, last = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise(r => out.once("drain", r));
      const now = Date.now();
      if (now - last > 200) { last = now; onProgress(received, total); }
    }
    out.end();
    await done;
  } catch (e) {
    out.destroy();
    fs.rmSync(dest, { force: true });
    throw e;
  }
  onProgress(received, total);
  const want = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || "");
  if (want && hash.digest("hex") !== want[1].toLowerCase()) {
    fs.rmSync(dest, { force: true });
    throw new Error("El archivo descargado no coincide con el publicado (sha256). No se instaló nada.");
  }
  return dest;
}

module.exports = { pickAsset, download };
