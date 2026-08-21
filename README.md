# dsh-gateway

[English](README.md) | [中文](README.zh.md)

An authenticated reverse proxy for the [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) Web GUI, packaged as a DSH plugin. It turns remote access into plain local traffic: remote sessions behave exactly like sitting at the machine.

```sh
dsh plugin --profile web add dsh-gateway   # or link:<local checkout>
dsh web                                     # gateway auto-listens on 0.0.0.0:8642
```

## Why

DSH's web server **intentionally refuses to bind anything but 127.0.0.1** — `dsh web --host 0.0.0.0` is rejected, because binding the harness (which can run arbitrary shell commands through its agent) to a network interface equals exposing remote code execution. On top of that, the `/api` layer runs a loopback trust fence that validates `Host` and `Origin` headers.

Both are good defaults. But sometimes you legitimately want to reach your own harness from your phone, another room, or another continent — over real TLS, with real authentication.

dsh-gateway sits in front of both layers:

```
remote browser ──HTTPS──> dsh-gateway (0.0.0.0:8642, password auth)
                               │  Host   ← 127.0.0.1:<dshPort>
                               │  Origin ← stripped
                               ▼
                        DSH web (127.0.0.1:<dshPort>)
```

Every forwarded request gets `Host` rewritten to the local target and `Origin` stripped, so DSH's fence treats each remote request as a plain local one — indistinguishable from a browser opened on the machine itself.

## Features

- **Plugin-native** — starts and stops with `dsh web`; no extra daemon, no supervisor, nothing to babysit. Follows dynamic ports (`--port 0`) automatically.
- **Password gate in front of everything** — built-in login page, HMAC-SHA256-signed `HttpOnly; SameSite=Lax` session cookie (default 7d), `Authorization: Bearer <password>` for programmatic access. WebSocket upgrades are gated by the same session (browsers attach the cookie automatically).
- **Static asset caching** — the upstream DSH web server sends no cache headers at all, so browsers re-download the entire JS/CSS bundle on every visit, which makes remote sessions feel sluggish. The gateway fills the gap with a safe, content-aware `Cache-Control` policy (see below). Repeat visits load from the browser cache: near-instant.
- **Zero runtime dependencies** — plain Node core (`node:http`, `node:crypto`, `node:net`, `node:tls`); nothing to audit, nothing to break.
- **True streaming** — request/response bodies are piped end to end, never buffered (DSH accepts request bodies up to 160 MiB; large uploads/downloads and SSE pass through untouched).
- **WebSocket tunneling** — upgrades (`/api/events.mux`, `/api/events.host`) are bridged as raw bidirectional socket tunnels, so the live UI works exactly as locally.
- **Hardened by default** — per-IP login rate limiting (10 attempts / 10 min), timing-safe password comparison, open-redirect guard on `next`, gateway session cookie never forwarded upstream, secrets stored `0600`.

### Cache policy

| Response | Policy |
| --- | --- |
| HTML | `no-store` — never cached; login state and UI freshness always correct |
| Static assets addressed by content hash — hash-named paths (`/assets/`, `/dist/`, `/static/`, `/vendor/`, `/favicon`) or hash query params (`?rev=<hash>`, `?v=<hash>`, …) | `public, max-age=31536000, immutable` — cached for a year; the hash is part of the URL, so an upstream update ships a new URL and takes effect immediately (upstream `no-cache` on such URLs is overridden) |
| Other static files (JS/CSS/images/fonts/wasm…, by content-type or extension) | `public, max-age=300` — short window, then revalidate |
| Everything else (API, streams) | untouched |

Applied only to successful (2xx/3xx) GET/HEAD responses; hash-addressed assets override an upstream `no-cache` (the hash makes it safe), everything else never overrides an upstream policy or `ETag`.

## Install

```sh
dsh plugin --profile web add link:/path/to/dsh-gateway
dsh web
```

The plugin injects the `webServer` service and starts the gateway once DSH is listening. If the gateway port is busy it disables itself with a log line and leaves DSH running.

Password resolution order: plugin config `password` → `$DSH_GATEWAY_PASSWORD` → `~/.dsh-gateway/secret` (auto-generated random password on first run, logged once, file mode 0600).

### Configuration

In the profile's `cordis.patch.yml`:

```yaml
- id: web-gateway
  config:
    enabled: true
    host: 0.0.0.0
    port: 8642
    password: ""            # empty → resolution order above
    sessionTtlMs: 604800000 # 7 days
```

### Deployment shapes

- **Cloudflare Tunnel (recommended)** — point the `cloudflared` service URL at `http://127.0.0.1:8642`; TLS terminates at the edge. Works with any reverse proxy (Caddy, nginx, Traefik) the same way.
- **LAN / VPS direct** — always put TLS in front (Caddy/nginx or a tunnel). Over plaintext HTTP the password and session cookie travel in cleartext.

### Verified end-to-end

The test suite (18 checks) covers the login flow, header rewrites (asserted upstream: `Host` rewritten, `Origin` stripped, gateway cookie withheld), the cache policy (immutable / hash-query override / revalidate / no-store), streaming, the WebSocket tunnel handshake and echo round-trip, and the auth gate on upgrades:

```sh
pnpm install
pnpm typecheck
pnpm test
```

## How it works

| Concern | Approach |
| --- | --- |
| Making DSH accept remote traffic | Proxy, not a bind change: DSH stays on loopback; `Host` is rewritten to `127.0.0.1:<port>` and `Origin` is dropped, so the loopback fence sees plain local requests |
| Auth | scrypt-derived key signs expiring session tokens (`<exp>.<hmac>`), stored in an `HttpOnly` cookie; Bearer password for scripts |
| WebSockets | Upgrades tunnel at the socket level — the gateway replays the handshake upstream and then pipes bytes both directions |
| Caching | Content-aware `Cache-Control` injection: hash-path assets immutable for a year, other static files revalidate after 5 min, HTML always no-store; upstream cache headers and `ETag`s pass through untouched |
| Lifetime | A cordis plugin keyed to the `webServer` service: listener registered as an effect, closed on fiber disposal; a busy port disables the gateway without touching DSH |

## Relation to dsh-remote-web-ui

`@linxin666/dsh-remote-web-ui` is an application-layer solution (pairing/device management inside the DSH plugin system). dsh-gateway is a **network-layer** one: a transport-level reverse proxy that remotizes the whole web GUI as-is, agnostic to DSH internals. The two can coexist; pick per scenario.

## Security notes

- The gateway grants everything a local DSH browser session has — including agent shell tools. Use a strong password (the auto-generated one is fine) and keep TLS in front.
- Changing the password invalidates all sessions instantly (the signing key is scrypt-derived from it).
- Never expose a plaintext gateway port to the public internet.

## Requirements

- Node.js >= 20
- DSH (`@deepseek-ai/dsh`) with the `web` profile

## License

MIT
