# Usage Monitor · servidor

Servicio pequeño (Node 20, sin dependencias) que consulta el uso de tu cuenta de Claude cada minuto y lo
sirve por HTTP. La app lo muestra con la fuente **Servidor propio (URL)**; otras herramientas (Home Assistant,
Grafana, scripts…) pueden leer el mismo JSON.

Es opcional: la app funciona sin él con Claude Code o con su propia ventana de claude.ai.

## Cómo accede a tu cuenta

Elige una de dos:

- **A) Login de Claude Code (recomendado si Claude Code está instalado en esa máquina).** El servidor lee
  `~/.claude/.credentials.json`, el mismo login que usa Claude Code, y consulta el uso con él. No hay nada que copiar
  ni que caduque: Claude Code renueva el acceso mientras lo usas, y si pasas horas sin usarlo en esa máquina el
  servidor lo renueva él mismo y lo guarda en el mismo archivo (Claude Code lo relee al cambiar). Solo renueva cuando el
  acceso ya venció, así que no compite con una sesión de Claude Code en uso. Con `CLAUDE_CREDENTIALS_RENEW=false` solo
  lee; entonces deja de actualizar si Claude Code pasa unas horas sin usarse ahí. Sirve en Linux y Windows; en macOS
  Claude Code guarda el login en el llavero y no en ese archivo.
- **B) Cookie de claude.ai.** El valor de la cookie `sessionKey` (navegador con claude.ai abierto → herramientas de
  desarrollo, F12 → Application/Storage → Cookies → `https://claude.ai` → `sessionKey`). Caduca cada pocas semanas o
  al cerrar sesión en ese navegador; entonces hay que copiarla de nuevo.

Las dos ven el uso de toda la cuenta, no solo el de esa máquina: cuenta lo que gastes desde cualquier equipo, la web o
la app de escritorio.

## Puesta en marcha (Docker Compose)

La imagen está en `ghcr.io/ignaciovillela/usage-monitor-server` (amd64 y arm64): `latest` y `X.Y.Z` con cada release,
`dev` (siempre la última de la rama dev) y `X.Y.Z-dev.N` (una compilación de dev concreta) con cada cambio en dev. Para probar
dev cambia `:latest` por `:dev` en el compose; la app de dev muestra la misma versión `X.Y.Z-dev.N` y avisa si hay una más nueva.
Solo necesitas este archivo, [`docker-compose.yml`](docker-compose.yml) (sirve igual como stack en Dockge o Portainer).
Viene preparado para la opción A; pega el `API_TOKEN` y ejecuta `docker compose up -d`:

```yaml
# Usage Monitor · servidor (opcional). Copia este archivo tal cual (también sirve como stack en Dockge o Portainer),
# elige cómo accede a tu cuenta (A o B), pega el API_TOKEN y ejecuta: docker compose up -d
services:
  usage-monitor:
    image: ghcr.io/ignaciovillela/usage-monitor-server:latest   # :dev para probar la rama dev
    # build: .                                                   # o compílala desde el repo (dentro de server/)
    container_name: usage-monitor
    restart: unless-stopped
    ports:
      - "8787:8787"

    # A) Login de Claude Code de esta máquina (recomendado si Claude Code está instalado aquí; no caduca).
    #    El contenedor usa el usuario 1000; si el tuyo tiene otro número (comando: id -u), cámbialo.
    #    En Dockge o Portainer escribe la ruta completa en vez de ~ (p. ej. /home/tu-usuario/.claude).
    user: "1000:1000"
    volumes:
      - ~/.claude:/claude   # con escritura: si el acceso vence porque no usas Claude Code aquí, el servidor lo renueva

    environment:
      CLAUDE_CREDENTIALS_FILE: /claude/.credentials.json
      # CLAUDE_CREDENTIALS_RENEW: "false"   # solo leer, sin renovar (puedes montar ~/.claude:/claude:ro)

      # B) O la cookie «sessionKey» de claude.ai (navegador → herramientas de desarrollo → Cookies → claude.ai).
      #    Borra lo de A (user, volumes y CLAUDE_CREDENTIALS_FILE). Caduca cada pocas semanas.
      # CLAUDE_SESSION_KEY: "sk-ant-sid01-..."

      # Obligatorio. Lo genera la app: Ajustes y datos → Servidor propio → «Generar» → «Copiar».
      # "none" lo desactiva (solo en una red de confianza, nunca con una URL online).
      API_TOKEN: "pega-aquí-el-token"

      # Opcionales:
      # POLL_SECONDS: "60"          # cada cuánto consulta el uso (mínimo 30)
      # REFRESH_MIN_SECONDS: "15"   # mínimo entre recargas pedidas desde la app
      # CLAUDE_ORG_ID: ""           # solo con B, si tienes varias organizaciones
```

Abre `http://<ip-del-servidor>:8787/` en el navegador (también desde el móvil): es una página para ver el uso que pide el
token la primera vez y lo recuerda en ese navegador. Desde la terminal:
`curl -H "Authorization: Bearer <tu token>" http://localhost:8787/usage`.
Si prefieres no dejar los secretos en el compose, ponlos en un `.env` (ver [`.env.example`](.env.example)) y cambia
`environment:` por `env_file: .env`.

Para compilarla tú mismo desde el repo, cambia `image:` por `build: .` en el compose (está comentado) y usa
`docker compose up -d --build` dentro de `server/`.

Sin Docker: `CLAUDE_CREDENTIALS_FILE=~/.claude/.credentials.json API_TOKEN=… node server.js` (o `CLAUDE_SESSION_KEY=…` en vez de `CLAUDE_CREDENTIALS_FILE`).

En la app: panel → **Ajustes y datos** → Fuente de datos **Servidor propio (URL)** → URL local
`http://<ip-del-servidor>:8787/usage`, una URL online opcional (p. ej. detrás de tu proxy inverso o túnel), el token y
**Guardar y probar**. La app usa la local y, si no responde, la online. También se puede fijar con
`USAGE_MONITOR_REMOTE_URL`, `USAGE_MONITOR_REMOTE_URL_ONLINE` y `USAGE_MONITOR_REMOTE_TOKEN`.

El servidor informa su versión (campo `version` y header `X-Usage-Monitor-Version`); la app la muestra y avisa si
conviene actualizarlo. Para actualizar: `docker compose pull && docker compose up -d`.

## API

| Ruta | Auth | Respuesta |
|---|---|---|
| `GET /` | no | Página web para ver el uso (estática; pide los datos a `/usage` con el token). |
| `GET /usage` | `Bearer API_TOKEN` | `{ version, source, fetchedAt, usage, error, errorAt }`; `source` es `claude-code` o `claude.ai` y `usage` trae `five_hour`, `seven_day` y `seven_day_*`. 503 si aún no hay datos. |
| `POST /usage` | `Bearer API_TOKEN` | Igual que `GET`, pero antes consulta el uso al momento (la flecha de recargar de la app). Como mucho una consulta cada `REFRESH_MIN_SECONDS` (15 s); dentro de ese margen devuelve lo último. |
| `GET /health` | no | `{ version, ok, source, fetchedAt, error }` sin datos de uso. |

La app acepta también una URL que devuelva directamente el JSON de claude.ai o el de la línea de estado de Claude Code
(`{ rate_limits: … }`), así que puedes servir los datos con otra herramienta. Si esa URL no acepta `POST` (404/405/501), la app recarga con `GET`.

## Seguridad y límites

- El login de Claude Code y `CLAUDE_SESSION_KEY` dan acceso a tu cuenta. Quedan solo en el servidor; la app nunca los ve.
- Con la opción A el contenedor monta `~/.claude` con escritura para poder guardar el acceso renovado. Solo toca
  `.credentials.json` (y un archivo temporal junto a él al guardarlo).
- `API_TOKEN` es obligatorio: sin él el servidor no arranca. `API_TOKEN=none` lo desactiva a propósito; úsalo solo en una red de confianza y nunca con la URL online.
- Si el acceso deja de valer, `/usage` devuelve `error` y la app lo muestra: con A, vuelve a iniciar sesión en Claude Code
  en esa máquina (`claude` → `/login`); con B, copia la cookie de nuevo y reinicia el contenedor.
- Con B, claude.ai está detrás de Cloudflare; si bloquea las consultas desde tu IP verás «sin JSON (posible verificación de Cloudflare)».
- Las dos opciones usan endpoints internos (el de `/usage` de Claude Code y el de la web de claude.ai) que no están
  documentados y pueden cambiar.
