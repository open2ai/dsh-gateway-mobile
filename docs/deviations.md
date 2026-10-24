# Deviations from `pre_docs1` (v2.0)

The implementation follows the product intent, but the source documents assume a
different DSH generation and include API sketches that do not match DSH `0.2.1-rc.2`.
This file records every material adaptation so future maintainers do not "fix" the code
back to the document.

## Platform / plugin API

| Document assumption | Reality in DSH 0.2.1-rc.2 | Implementation |
|---|---|---|
| `require('cordis')`, `exports.*`, `exports.Config`, `ctx.plugin.config` | DSH is ESM + Cordis 4; plugins export `name`, `inject`, `apply(ctx, config)` | `lib/index.js` uses ESM exports; config is the `apply` second argument |
| `inject: { db: true, i18n: true }` | No `db`/`i18n` services in a base web profile | `inject = ['webServer', 'connection']`; no DB/i18n services |
| `ctx.get('dsh/session')`, `ctx.get('apiproxy')` | Not part of the shipped web profile | Not used; the gateway is protocol-opaque |
| `ctx.get('webserver')` / `apiProxy.serveStatic` | Service is `ctx.webServer`; static serving is owned by `dsh-host-frontend-static` | Gateway is a **sidecar HTTP server** on 3081 and serves its own `/mobile` pages |
| `ctx.on('dsh/session-created')`, `approval-requested` | No such Cordis events in the base web profile | Deferred; the official DSH UI remains the source of approvals |
| DSH `>=1.5.0`; `cordis.patch.yml` new API | Installed/verified `0.2.1-rc.2` | `engines.dsh: >=0.2.1-rc.2 <0.3.0`; bundle patch uses the current loader |
| `package.json` `peerDependencies.dsh` | `dsh` is not a package name; the CLI is `@deepseek-ai/dsh` | `engines.dsh` range only |

## Cookie / auth

| Document | Implementation | Why |
|---|---|---|
| Session cookie `Path=/mobile` | `Path=/` | The cookie authenticates the **proxied DSH routes** (`/`, `/api`, `/plugins`), not only `/mobile` |
| Session cookie 24h | default 86400s (configurable) | Matches FR-04; the older config example's 30 days is available via `auth.sessionMaxAge` |
| HMAC payload base64 JSON | base64url + `.` + HMAC-SHA256, constant-time compare | Equivalent format with stricter parsing |
| Pairing token 15 min | default 900s | Same |
| AES-256-GCM for secrets | `secret.key` + AES-256-GCM helper (`SecretBox`) for persisted secrets; session uses HMAC | No sensitive config is persisted today |
| Pairing code 8 digits/alnum | 8 chars from an unambiguous alphabet (`A-Z2-9` minus I/O/0/1), `XXXX-XXXX` display | Usability + fewer typos |
| Admin APIs only loopback | loopback **and not proxied**; admin page + `/admin/*` and `/logs` work without a session on first run | First-run QR needs to be visible before any device exists |

## Mobile UI / protocol

| Document | Implementation | Status |
|---|---|---|
| Independent `/mobile` session list/chat/approval UI | PWA shell that opens the official DSH Web UI through the authenticated proxy; `/mobile` contains pairing/status/devices/OAuth/admin pages | **Deferred** (see `lib/gateway.js` `/mobile/ws`) |
| Custom WebSocket protocol (`chat.send`, `chat.delta`, `approval.request`, file chunks) | `/mobile/ws` implements handshake/auth/`ping`/`status.get`; chat/approval/file types return `1008` | **Deferred** |
| `GET /sessions`, `GET /models`, `POST /sessions/{id}/continue`, model switch | Return `1008 NOT_SUPPORTED` with a hint to use the DSH UI | **Deferred**; DSH's internal Remote API is version-specific and not a stable REST surface |
| SSE streaming support | Not needed for DSH (it uses a WS mux). Quick Tunnel does not support SSE anyway | Note |
| 30s WS heartbeat | `/mobile/ws` heartbeat configurable (default 30s); DSH's own mux heartbeat is 2s and is proxied opaquely | Implemented |
| PWA install | Manifest + service worker + icons | Implemented (basic) |
| zh/en i18n | Inline dictionaries in `web/src/common.ts` and `lib/errors.js`; `Accept-Language` for API errors | Implemented |
| Server-side rendering | Static HTML pages (no SSR) | Deviation; pages are small, but browser assets are TypeScript-built via esbuild |

## Tunnel

| Document | Implementation | Notes |
|---|---|---|
| Auto-download cloudflared, SHA-256 verify, cache | Resolver: config → `CLOUDFLARED_PATH` → PATH → cache → download (pinned version `2026.10.3`). Hash verification enforced only when `tunnel.sha256` (or a known hash) is set; otherwise it records the observed hash and warns | No official `.sha256` asset was available from the release; pin via config for production |
| Force HTTP/2 | Default `--protocol http2` | Configurable `quic` |
| Reconnect max 10 | Capped exponential backoff, max 10, then `error` | Implemented |
| Notify paired devices on URL change | Logs + status broadcast on `/mobile/ws`; phones must re-pair because cookies are host-scoped | Partial |
| Named Tunnel v0.4 | Basic `mode: named` + token/domain support | Placeholder; not covered by tests |

## TLS upstream

`dsh web --tls-cert/--tls-key` (an HTTPS listener) is not supported by the internal
cookie exchange or proxy agent when the certificate is self-signed or not trusted by
Node. Keep DSH on plain HTTP loopback and let Cloudflare terminate TLS (the default), or
provide a trusted certificate and set `proxy.upstream` to `https://…`. This is a current
limitation, not a silent fallback.

## Storage / infra

| Document | Implementation |
|---|---|
| Database/ORM for devices | JSON store with atomic rewrite (`devices.json`) |
| Platform keychain / DPAPI | Random key file `0600` + AES-GCM helper; Windows ACLs are the OS' responsibility |
| `dist/` build + zip | TypeScript server compile (`tsc`) + browser bundle (`esbuild`); `scripts/pack.mjs` creates a zip/tarball |
| CI workflow | Not included; `npm test` and `scripts/integration-check.mjs` are the gates |

## Requirement status

| FR | Status |
|---|---|
| FR-01 built-in HTTP/WS gateway, header correction, unified auth | ✅ |
| FR-02 Quick Tunnel, HTTP/2, reconnect, status, start/stop, QR in admin | ✅ (Named Tunnel basic) |
| FR-03 mobile-specific UI, PWA | 🔶 PWA pages + `/mobile/shell` full-screen official DSH UI; dedicated chat/session UI deferred |
| FR-04 one-time pairing, QR/fragment, cookie, device name | ✅ |
| FR-05 GitHub/Gitee OAuth, minimal scope, optional requirement, unbind | ✅ (needs real provider credentials to exercise) |
| FR-06 device list/revoke/revoke-all/expiry/permanent record deletion | ✅ |
| FR-07 fail-closed, rate limit, Host/Origin, local admin isolation, encrypted storage | ✅ (AES helper; no persisted OAuth secrets) |
| FR-08 status/logs/token stats/update reminder | 🔶 status/logs + per-day/per-device request stats; token usage aggregation and update reminder deferred |
