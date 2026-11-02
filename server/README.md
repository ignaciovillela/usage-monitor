# Usage Monitor · servidor

Servicio pequeño (Node 20, sin dependencias) que consulta el uso de claude.ai con tu sesión cada minuto y lo
sirve por HTTP. La app lo muestra con la fuente **Servidor propio (URL)**; otras herramientas (Home Assistant,
Grafana, scripts…) pueden leer el mismo JSON.

Es opcional: la app funciona sin él con Claude Code o con su propia ventana de claude.ai.

## Puesta en marcha (Docker Compose)

La imagen está en `ghcr.io/ignaciovillela/usage-monitor-server` (amd64 y arm64): `latest` y `X.Y.Z` con cada release,
`dev` con cada cambio en la rama dev (para probar; cambia `:latest` por `:dev` en el compose).
Solo necesitas este archivo, [`docker-compose.yml`](docker-compose.yml) (sirve igual como stack en Dockge o Portainer).
Completa `CLAUDE_SESSION_KEY` y `API_TOKEN` y ejecuta `docker compose up -d`:

```yaml
# Usage Monitor · servidor (opcional). Copia este archivo tal cual (también sirve como stack en Dockge o Portainer),
# completa las dos líneas de environment y ejecuta: docker compose up -d
services:
  usage-monitor:
    image: ghcr.io/ignaciovillela/usage-monitor-server:latest   # :dev para probar la rama dev
    # build: .                                                   # o compílala desde el repo (dentro de server/)
    container_name: usage-monitor
    restart: unless-stopped
    ports:
      - "8787:8787"
    environment:
      # Cookie «sessionKey» de claude.ai (navegador → herramientas de desarrollo → Cookies → claude.ai).
      # Da acceso a tu cuenta: queda solo en este servidor. Caduca cada cierto tiempo.
      CLAUDE_SESSION_KEY: "sk-ant-sid01-..."
      # Obligatorio. Lo genera la app: Ajustes y datos → Servidor propio → «Generar» → «Copiar».
      # "none" lo desactiva (solo en una red de confianza, nunca con una URL online).
      API_TOKEN: "pega-aquí-el-token"
      # Opcionales:
      # POLL_SECONDS: "60"          # cada cuánto consulta claude.ai (mínimo 30)
      # REFRESH_MIN_SECONDS: "15"   # mínimo entre recargas pedidas desde la app
      # CLAUDE_ORG_ID: ""           # si tienes varias organizaciones
```

Abre `http://<ip-del-servidor>:8787/` en el navegador (también desde el móvil): es una página para ver el uso que pide el
token la primera vez y lo recuerda en ese navegador. Desde la terminal:
`curl -H "Authorization: Bearer <tu token>" http://localhost:8787/usage`.
Si prefieres no dejar los secretos en el compose, ponlos en un `.env` (ver [`.env.example`](.env.example)) y cambia
`environment:` por `env_file: .env`.

Para compilarla tú mismo desde el repo, cambia `image:` por `build: .` en el compose (está comentado) y usa
`docker compose up -d --build` dentro de `server/`.

Sin Docker: `CLAUDE_SESSION_KEY=… API_TOKEN=… node server.js`.

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
| `GET /usage` | `Bearer API_TOKEN` | `{ version, fetchedAt, usage, error, errorAt }`; `usage` es la respuesta de claude.ai (`five_hour`, `seven_day`, `seven_day_*`). 503 si aún no hay datos. |
| `POST /usage` | `Bearer API_TOKEN` | Igual que `GET`, pero antes consulta claude.ai al momento (la flecha de recargar de la app). Como mucho una consulta cada `REFRESH_MIN_SECONDS` (15 s); dentro de ese margen devuelve lo último. |
| `GET /health` | no | `{ version, ok, fetchedAt, error }` sin datos de uso. |

La app acepta también una URL que devuelva directamente el JSON de claude.ai o el de la línea de estado de Claude Code
(`{ rate_limits: … }`), así que puedes servir los datos con otra herramienta. Si esa URL no acepta `POST` (404/405/501), la app recarga con `GET`.

## Seguridad y límites

- `CLAUDE_SESSION_KEY` da acceso a tu cuenta. Queda solo en el servidor; la app nunca la ve.
- `API_TOKEN` es obligatorio: sin él el servidor no arranca. `API_TOKEN=none` lo desactiva a propósito; úsalo solo en una red de confianza y nunca con la URL online.
- La sesión caduca: `/usage` devolverá `error` y la app lo mostrará. Renueva la cookie y reinicia el contenedor.
- claude.ai está detrás de Cloudflare; si bloquea las consultas desde tu IP verás «sin JSON (posible verificación de Cloudflare)».
- Usa un endpoint interno de claude.ai que no está documentado y puede cambiar.
