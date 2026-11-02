# Usage Monitor · servidor

Servicio pequeño (Node 20, sin dependencias) que consulta el uso de claude.ai con tu sesión cada minuto y lo
sirve por HTTP. La app lo muestra con la fuente **Servidor propio (URL)**; otras herramientas (Home Assistant,
Grafana, scripts…) pueden leer el mismo JSON.

Es opcional: la app funciona sin él con Claude Code o con su propia ventana de claude.ai.

## Puesta en marcha (Docker Compose)

La imagen está en `ghcr.io/ignaciovillela/usage-monitor-server` (amd64 y arm64; se publica con cada release).
En el servidor solo necesitas `docker-compose.yml` y tu `.env`:

```sh
mkdir usage-monitor && cd usage-monitor
curl -fsSLO https://raw.githubusercontent.com/ignaciovillela/usage-monitor/main/server/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/ignaciovillela/usage-monitor/main/server/.env.example -o .env
# edita .env: CLAUDE_SESSION_KEY y API_TOKEN
docker compose up -d
curl -H "Authorization: Bearer $API_TOKEN" http://localhost:8787/usage
```

Para compilarla tú mismo desde el repo, cambia `image:` por `build: .` en el compose (está comentado) y usa
`docker compose up -d --build` dentro de `server/`.

Sin Docker: `CLAUDE_SESSION_KEY=… API_TOKEN=… node server.js`.

En la app: panel → **Ajustes y datos** → Fuente de datos **Servidor propio (URL)** → URL
`http://<tu-servidor>:8787/usage`, el token, y **Guardar y probar**. También se puede fijar con las variables
`USAGE_MONITOR_REMOTE_URL` y `USAGE_MONITOR_REMOTE_TOKEN`.

## API

| Ruta | Auth | Respuesta |
|---|---|---|
| `GET /usage` | `Bearer API_TOKEN` | `{ fetchedAt, usage, error, errorAt }`; `usage` es la respuesta de claude.ai (`five_hour`, `seven_day`, `seven_day_*`). 503 si aún no hay datos. |
| `POST /usage` | `Bearer API_TOKEN` | Igual que `GET`, pero antes consulta claude.ai al momento (la flecha de recargar de la app). Como mucho una consulta cada `REFRESH_MIN_SECONDS` (15 s); dentro de ese margen devuelve lo último. |
| `GET /health` | no | `{ ok, fetchedAt, error }` sin datos de uso. |

La app acepta también una URL que devuelva directamente el JSON de claude.ai o el de la línea de estado de Claude Code
(`{ rate_limits: … }`), así que puedes servir los datos con otra herramienta. Si esa URL no acepta `POST` (404/405/501), la app recarga con `GET`.

## Seguridad y límites

- `CLAUDE_SESSION_KEY` da acceso a tu cuenta. Queda solo en el servidor; la app nunca la ve.
- Pon `API_TOKEN` y no expongas el puerto a internet (usa tu VPN o red local).
- La sesión caduca: `/usage` devolverá `error` y la app lo mostrará. Renueva la cookie y reinicia el contenedor.
- claude.ai está detrás de Cloudflare; si bloquea las consultas desde tu IP verás «sin JSON (posible verificación de Cloudflare)».
- Usa un endpoint interno de claude.ai que no está documentado y puede cambiar.
