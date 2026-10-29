// Empaqueta la app para Windows (x64): dist/Usage Monitor-win32-x64/. Se ejecuta en Windows (lo hace el workflow de release).
const { execSync } = require("child_process");
const path = require("path");
const root = path.join(__dirname, "..");
const run = cmd => execSync(cmd, { cwd: root, stdio: "inherit", env: { ...process.env, USAGE_MONITOR_DATA: path.join(require("os").tmpdir(), "usage-monitor-icon-build") } });
console.log("→ ícono");
run("npx electron . --make-icon");
run("node scripts/make-ico.js");
console.log("→ app");
const ignore = "^/(selftest|dist|build|tests|docs|assets|\\.github|PRD\\.md|README.*|CONTRIBUTING\\.md|SECURITY\\.md|LICENSE)($|/)";
run(`npx @electron/packager . "Usage Monitor" --platform=win32 --arch=x64 --icon=build/icon.ico --out=dist --overwrite --ignore="${ignore}"`);
console.log("Listo: dist/Usage Monitor-win32-x64");
