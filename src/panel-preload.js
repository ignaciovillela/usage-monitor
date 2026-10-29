// Hace que el popup (escrito contra la API de chrome.storage) funcione dentro de la app: le da un objeto `chrome` mínimo
// (storage.local, onChanged, runtime.sendMessage) cuyos datos vienen del proceso principal.
const { ipcRenderer } = require("electron");
const listeners = new Set();
ipcRenderer.on("storage-changed", (_event, changes) => listeners.forEach(fn => { try { fn(changes, "local"); } catch (_) { /* un oyente roto no debe frenar a los demás */ } }));
// Chromium ya define window.chrome, así que contextBridge no puede sustituirlo; como el panel solo carga archivos
// locales de la app, se asigna directamente (la ventana usa contextIsolation: false).
window.chrome = {
  storage: {
    local: {
      get: keys => ipcRenderer.invoke("storage-get", keys === undefined ? null : keys),
      set: obj => ipcRenderer.invoke("storage-set", obj),
      remove: keys => ipcRenderer.invoke("storage-remove", keys)
    },
    onChanged: { addListener: fn => listeners.add(fn) }
  },
  runtime: {
    sendMessage: (message, callback) => { ipcRenderer.invoke("runtime-message", message).then(r => callback && callback(r)); },
    lastError: undefined
  }
};
