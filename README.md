# dsh-gateway

An authenticated reverse proxy for the DSH web GUI that turns remote access into plain local traffic — remote sessions behave exactly like local ones.

DSH's web server **intentionally refuses to bind anything but 127.0.0.1** (`dsh web --host 0.0.0.0` is rejected — it would expose remote code execution to the network), and its `/api` layer runs a loopback trust fence (validating `Host` and `Origin`). dsh-gateway sits in front of both:

```
remote browser ──HTTPS(optional)──> dsh-gateway (0.0.0.0:8642, password auth)
                                        │  Host   ← 127.0.0.1:<dshPort>
                                        │  Origin ← stripped
                                        ▼
                                 DSH web (127.0.0.1:<dshPort>)
```

Every forwarded request gets `Host` rewritten to the local target and `Origin` stripped, so DSH's fence treats each remote request as a plain local one — indistinguishable from opening a browser on the machine. All traffic is streamed end to end with zero buffering (DSH accepts request bodies up to 160 MiB; large uploads/downloads and SSE pass through untouched), and WebSocket upgrades (`/api/events.mux`, `/api/events.host`) are bridged as raw bidirectional socket tunnels.

## Authentication

- **Browsers**: any unauthenticated visit → 302 to the built-in login page → password → an HMAC-SHA256-signed `HttpOnly; SameSite=Lax` session cookie (default 7d). No dependencies, no external assets.
- **Programmatic access**: `Authorization: Bearer <password>`.
- **WebSockets**: upgrade handshakes are gated by the same cookie (browsers attach it automatically); unauthenticated upgrades get 401.
- Login is rate-limited per IP (10 attempts / 10 min), the `next` parameter is open-redirect guarded, and the gateway session cookie is never forwarded to DSH.

## Install & usage

**Plugin mode (recommended)** — the gateway starts and stops with `dsh web`, no separate process to babysit:

```sh
dsh plugin --profile web add link:/path/to/dsh-gateway
dsh web                      # gateway auto-listens on 0.0.0.0:8642
```

The plugin injects the `webServer` service and starts the gateway against the real listening port once DSH is up (follows `--port 0` dynamic ports too). If the gateway port is busy it disables itself with a log line and leaves DSH running. Plugin config (in the profile's `cordis.patch.yml`):

```yaml
- id: web-gateway
  config:
    port: 8642
    host: 0.0.0.0
    password: ""        # empty → resolution order
    sessionTtlMs: 604800000
```

**CLI mode** (standalone process, for split deployments or ad-hoc use):

```sh
pnpm install
pnpm typecheck
pnpm test        # 14 smoke tests (WS tunnel, Host/Origin rewrite assertions)

dsh web --port 3080 &
node bin/dsh-gateway.mjs --target 3080          # listens on 0.0.0.0:8642
```

Password resolution order: `--password` → `$DSH_GATEWAY_PASSWORD` → `--password-file` → `~/.dsh-gateway/secret` (auto-generated random password on first run, printed once, file mode 0600).

### Options

| Flag | Description | Default |
| --- | --- | --- |
| `--target <url\|host:port\|port>` | local DSH address, e.g. `3080` / `127.0.0.1:3080` | required (or `DSH_GATEWAY_TARGET`) |
| `--host <addr>` / `--port <n>` | listen address / port | `0.0.0.0` / `8642` |
| `--password <secret>` | access password | see order above |
| `--password-file <path>` | read password from file | - |
| `--session-ttl <dur>` | session lifetime, e.g. `12h`, `7d` | `7d` |
| `--cert <p>` `--key <p>` | serve HTTPS directly | plain HTTP |
| `-q, --quiet` | silence the access log | - |

### Deployment shapes

- **Cloudflare Tunnel (recommended when you already run a named tunnel)**: point the `cloudflared` service URL at `http://127.0.0.1:8642`; TLS terminates at the edge.
- **LAN / VPS direct**: always add TLS — either `--cert/--key` or a Caddy/nginx layer in front. Over plain HTTP the password and cookie travel in cleartext.

## Relation to the dsh-remote-web-ui plugin

`@linxin666/dsh-remote-web-ui` is an application-layer solution (pairing/device management inside the DSH plugin system); dsh-gateway is a **network-layer** one — it does not touch DSH's plugin machinery and is version-agnostic. Any loopback HTTP+WS service can be "remotized" through it. The two can coexist; pick per scenario.

## Security notes

- The gateway grants everything a local DSH browser session has (including agent bash tools) — use a strong random password (the auto-generated one is fine).
- Never expose a plaintext gateway port to the public internet.
- Changing the password invalidates all sessions (the signing key is scrypt-derived from it).

## License

MIT
