# Architecture

## Runtime topology

```
┌──────────────┐  HTTPS   ┌────────────────────┐  outbound   ┌──────────────────────────────┐
│ Phone (PWA)  │ ───────► │ Cloudflare edge    │ ◄────────── │ cloudflared (child process)  │
└──────────────┘          │ Quick Tunnel       │             └──────────────┬───────────────┘
                          └────────────────────┘                            │ HTTP/WS
                                                                             ▼
                                                         ┌───────────────────────────────────┐
                                                         │ 127.0.0.1:3081                    │
                                                         │ dsh-gateway-mobile                │
                                                         │  ├─ Host/Origin fence             │
                                                         │  ├─ session auth + rate limit     │
                                                         │  ├─ /mobile/** PWA + JSON API     │
                                                         │  ├─ /mobile/ws control channel    │
                                                         │  └─ reverse proxy (HTTP + WS)     │
                                                         └───────────────┬───────────────────┘
                                                                         │ Host=127.0.0.1:3080
                                                                         │ Cookie=<gateway-held DSH cookie>
                                                                         ▼
                                                         ┌───────────────────────────────────┐
                                                         │ 127.0.0.1:3080  dsh web           │
                                                         │ (owner session, tools, approvals) │
                                                         └───────────────────────────────────┘
```

DSH never listens on a public interface. The only public component is the Cloudflare
Quick Tunnel terminating at the plugin's loopback listener.

## Modules

| Module | Responsibility |
|---|---|
| `lib/index.js` | Cordis entry; builds services, starts the gateway, starts the tunnel in the background, registers disposers |
| `lib/config.js` | Defaults, nested merge, validation (loopback host, named-mode token, OAuth requirement) |
| `lib/tunnel.js` | `cloudflared` lifecycle, URL parsing, reconnect backoff, status, named-mode placeholder |
| `lib/cloudflared.js` | Binary resolution (config → env → PATH → cache → download), SHA-256 check, version probe |
| `lib/pairing.js` | One-time 8-char codes, TTL, used-code tracking, automatic next code |
| `lib/sessions.js` | HMAC-signed cookie payloads, constant-time verify, expiry |
| `lib/settings.js` | Persistent loopback-only admin overrides for session/pairing lifetimes (`admin-settings.json`) |
| `lib/devices.js` | JSON registry, device limit, revoke/revoke-all, permanent deletion of revoked/expired records, silent expiry, OAuth bindings, live socket tracking |
| `lib/util.js` | MIME types, cookie parsing/serialisation, UA fingerprints, IP/protocol helpers |
| `lib/ratelimit.js` | Sliding-window API limiter and pairing lockout |
| `lib/proxy.js` | DSH cookie provider (token exchange via `connection.authenticatedUrl`), HTTP proxy, WebSocket upgrade proxy, header rewrite |
| `lib/gateway.js` | HTTP server, routing, static PWA, admin API, mobile API, device lifecycle endpoints, OAuth callback, `/mobile/ws` |
| `lib/oauth.js` | GitHub/Gitee authorization-code flow, state HMAC, user-info fetch, bind |
| `lib/ws.js` | Minimal RFC 6455 server for `/mobile/ws` (text/ping/pong/close) |
| `lib/store.js` | Atomic JSON files, AES-256-GCM secret box |
| `lib/logger.js` | Console + ring buffer + redacted audit log |
| `lib/stats.js` | Per-day/per-device request counters (`stats.json`) for the admin dashboard |
| `lib/errors.js` | Product error codes and zh/en messages |

## Startup sequence

1. Cordis loads the `gateway-mobile` row (bundle patch) after `dsh-web-app`.
2. `normalizeConfig` validates; data dir, secret key, logger, device store initialize; persisted `admin-settings.json` overrides are applied to auth lifetimes.
3. Pairing code is generated and logged; admin page is available on loopback **without a session**.
4. Gateway listens on `gateway.host:gateway.port` (loopback only).
5. If `tunnel.enabled`, `TunnelManager.start()` runs in the background: resolve/download cloudflared, spawn Quick Tunnel, parse the URL, emit `connected`.
6. The admin page shows the QR/pairing URL once the tunnel URL is known.
7. On dispose: close gateway, stop tunnel, stop cleanup timers, destroy proxy agent.

## Request path

1. **Host fence**: `Host` must be loopback (direct) or the current tunnel host / configured public host. Otherwise 403.
2. **Origin fence**: if `Origin` is present its authority must equal `Host`; `Sec-Fetch-Site: cross-site` is rejected.
3. **Public routes**: `/health`, pairing status/verify, OAuth callback, static pair/assets.
4. **Session**: verify `dsh_session` HMAC, check device active/not revoked/not expired, optional OAuth gate.
5. **Local-only**: `/mobile/admin`, admin APIs, logs are additionally restricted to requests that are loopback **and not proxied** (`cf-*`/`x-forwarded-*` absent).
6. **CSRF**: mutating `/mobile/api/v1/*` requires `X-Requested-With: XMLHttpRequest`.
7. **Proxy**: strip client cookies, rewrite `Host`/`Origin` to DSH's loopback authority, inject the gateway-held DSH cookie, forward `X-Forwarded-*`, stream the response.
8. **Upgrade**: same auth; DSH's `/api/remote.mux` frames are piped opaquely (the gateway never parses DSH's business protocol).

## DSH cookie acquisition

`dsh web` remains authenticated by its own signed cookie. The plugin:

1. calls `ctx.connection.authenticatedUrl(ctx.webServer.getOrigin() + '/')` to get a tokenized URL;
2. fetches it with `redirect: manual`;
3. captures `Set-Cookie` and keeps it in memory;
4. injects that cookie into proxied requests;
5. on an upstream 401 for a GET/HEAD, invalidates, re-exchanges once, and retries.

The phone never sees DSH's cookie. This is what allows the gateway to keep its own
device/session model while DSH's trust fence and cookie audience stay valid (Host is
rewritten to the loopback authority).

## Storage

```
$DSH_HOME/gateway-mobile/
├── secret.key       # 32 random bytes, base64; HMAC/AES key (0600)
├── devices.json     # device registry (atomic rewrite; revoked/expired records removable)
├── admin-settings.json # persisted session/pairing lifetime overrides (optional)
├── stats.json       # per-day/per-device request counters
├── gateway.log      # structured log/audit JSONL
└── cloudflared/     # cached binary when auto-download is used
```

## Failure behavior

| Failure | Behavior |
|---|---|
| cloudflared missing/download fails | Gateway keeps running on loopback; tunnel state `error`; admin can retry |
| Tunnel drops | State `reconnecting`; capped exponential backoff up to `maxRetries`; then `error` |
| DSH 3080 unavailable | 5xx from proxy with `PROXY_ERROR`; session/auth unaffected |
| DSH restarts (cookie invalid) | First GET/HEAD 401 triggers cookie re-exchange and one retry |
| Device revoked | Sessions fail with `3001`; live sockets destroyed; WebSocket close 4002; the record stays until deleted |
| Delete/purge requested for an active device | `4009`; the record and session are left untouched |
| Host changed (Quick Tunnel restart) | Old host requests 403; browser cookie is host-scoped → re-pair |
| Plugin disposed | Server closed, tunnel stopped, timers cleared |
