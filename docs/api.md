# API

Base path: `/mobile/api/v1`. All JSON responses use:

```json
{ "code": 0, "message": "success", "data": {} }
```

- `code`: product error code (`0` success).
- `message`: localized (zh default, en via `Accept-Language`).
- `data`: endpoint-specific; errors may include `retryAfter`, `remainingAttempts`.

State-changing requests (`POST`/`PUT`/`PATCH`/`DELETE`) require
`X-Requested-With: XMLHttpRequest` (except the public pairing endpoint, which the
pairing page sends anyway).

Authenticated API responses carry `X-RateLimit-Limit`/`X-RateLimit-Remaining`; a
limited response adds `Retry-After`.

## Error codes

| Code | Name | HTTP | Meaning |
|---|---|---|---|
| 0 | success | 200 | OK |
| 1001 | invalid_params | 400/413/415 | Bad/missing/oversized/incorrect content type |
| 1002 | invalid_pairing_code | 400 | Not 8 alphanumerics |
| 1003 | invalid_device_id | 400 | Unknown/malformed device id |
| 1004 | invalid_oauth_state | 400 | OAuth state mismatch/expired |
| 1005 | invalid_confirm_text | 400 | `REVOKE ALL` / `DELETE REVOKED` mismatch |
| 1006 | device_limit_reached | 403 | `maxDevicesPerUser` reached |
| 1007 | csrf_failed | 403 | Missing `X-Requested-With` |
| 1008 | not_supported | 501 | Feature deferred (sessions/models, chat WS) |
| 2001 | unauthenticated | 401 | No session cookie |
| 2002 | session_expired | 401 | Cookie expired |
| 2003 | session_invalid | 401 | Bad signature/payload |
| 2004 | pairing_token_expired | 410 | TTL elapsed |
| 2005 | pairing_token_used | 409 | Code already consumed |
| 3001 | device_revoked | 403 | Device revoked |
| 3002 | device_expired | 403 | Silent expiry |
| 3003 | permission_denied | 403 | Remote device hit an admin/local API |
| 3004 | oauth_required | 403 | `requireOAuth` and no binding |
| 4001 | rate_limited | 429 | API window exceeded or pairing lockout |
| 4002 | pairing_failed | 400 | Wrong pairing code |
| 4003 | oauth_callback_error | 400 | Provider returned an error |
| 4004 | oauth_token_exchange_failed | 400 | Code→token failed |
| 4005 | oauth_user_info_failed | 400 | User-info failed |
| 4006 | redirect_uri_mismatch | 400 | Callback URI mismatch (Gitee is byte-exact) |
| 4007 | tunnel_not_connected | 503 | No tunnel and proxy cannot reach DSH |
| 4008 | oauth_not_configured | 400 | Provider has no client credentials |
| 4009 | device_not_deletable | 409 | Device is still active; revoke it before deleting the record |
| 5001 | internal_error | 500 | Unhandled |
| 5002 | tunnel_start_failed | 500 | cloudflared failed |
| 5003 | proxy_error | 502/504 | Upstream error/timeout |
| 5004 | storage_error | 500 | Reserved |
| 5005 | cloudflared_download_failed | 500 | Download/hash/exec failed |

## Endpoints

### Health

`GET /health` (public), also available as `/mobile/api/v1/health`:

```json
{ "code": 0, "data": { "ok": true, "version": "0.1.0", "time": "2026-10-24T07:00:00.000Z" } }
```

### Pairing

`GET /pairing/status` (public)

```json
{ "code": 0, "data": { "valid": true, "expiresIn": 872, "used": false } }
```

`POST /pairing/verify` (public, rate-limited)

```json
{ "pairingToken": "KR4ZAJF9", "deviceName": "我的手机" }
```

Success sets `dsh_session` (`Path=/`, `HttpOnly`, `SameSite=Strict`, `Secure` on the
tunnel) and returns:

```json
{ "code": 0, "data": { "deviceId": "dev_…", "expiresAt": "…", "requireOAuth": false, "oauthProviders": ["github"] } }
```

Errors: `1002`, `2004`, `2005`, `4001` (lockout, with `retryAfter`), `4002`.

### Local admin (loopback only, no session required)

`GET /admin/pairing`

```json
{ "code": 0, "data": {
  "code": "KR4Z-AJF9", "codeRaw": "KR4ZAJF9", "expiresIn": 872,
  "expiresAt": "…", "pairingUrl": "https://…/mobile/pair#pairing=KR4ZAJF9",
  "qrSvg": "<svg…>", "tunnel": { "state": "connected", "url": "https://…" }
} }
```

`POST /admin/pairing/regenerate` — new code/QR.

`POST /admin/tunnel/start|stop|restart` — returns tunnel status.

`GET /logs?limit=50` — recent log entries.

`GET /admin/stats?days=7` — per-day/per-device request counters.

`GET /admin/settings` — effective auth lifetimes:

```json
{ "code": 0, "data": {
  "sessionMaxAge": 86400, "pairingTokenExpiry": 900,
  "limits": { "sessionMin": 300, "sessionMax": 7776000, "pairingMin": 30, "pairingMax": 86400 }
} }
```

`POST /admin/settings` — runtime update, persisted to `<dataDir>/admin-settings.json`:

```json
{ "sessionMaxAge": 604800, "pairingTokenExpiry": 900 }
```

Both fields are optional; values must be integers in the documented ranges. Returns the updated settings. Changing the pairing TTL issues a fresh pairing code. Local/loopback only; no restart required.

### Session

`POST /session/refresh` — rotates the `dsh_session` cookie (same device) and returns the new expiry.

`GET /me`

```json
{ "code": 0, "data": {
  "device": { "deviceId": "dev_…", "deviceName": "…", "isOnline": true, "oauthBindings": [] },
  "requireOAuth": false, "oauthProviders": ["github"], "publicBase": "https://…"
} }
```

`GET /status` — gateway/tunnel/proxy/active devices/statistics (+ current device when session-authenticated).

`POST /logout` — clears the cookie (device record is kept).

### Devices

`GET /devices` — session: current device only; loopback: all; `?all=1` includes revoked and expired records.

`PATCH /devices/{deviceId}` — body `{"deviceName":"…"}`; self or loopback.

`POST /devices/{deviceId}/revoke` — self or loopback; closes sockets, next request fails `3001`.

`POST /devices/revoke-all` (loopback) — body `{"confirmText":"REVOKE ALL"}`.

`DELETE /devices/{deviceId}` (loopback) — permanently removes a revoked/expired device record; returns `4009` while the device is still active.

`POST /devices/purge` (loopback) — permanently removes every revoked/expired record; body `{"confirmText":"DELETE REVOKED"}` → `{ "deleted": n }`.

### OAuth (optional)

`GET /oauth/providers` → `{ providers: ["github"] }`

`GET /oauth/authorize?provider=github&deviceId=dev_…` → `{ authorizeUrl }`

`POST /oauth/callback` (body `{provider, code, state}`) → binding summary.

`POST /oauth/unbind` (body `{provider}`).

`GET /auth/{provider}/callback` — browser popup endpoint; exchanges the code, binds the
device, returns a small HTML page that posts `{type:'dsh-oauth', ok}` to the opener.

### Deferred

`GET /sessions` and `GET /models` return `1008` with a hint to use the embedded DSH UI.

## WebSocket `/mobile/ws`

- Handshake requires the `dsh_session` cookie; failure closes with **4001**.
- Subprotocol: `dsh-mobile-v1` when requested.
- Server sends a `ready` message:

```json
{ "type": "ready", "payload": { "protocolVersion": 1, "deviceId": "dev_…", "gatewayVersion": "0.1.0", "publicBase": "…", "tunnel": {} } }
```

- Supported inbound types: `ping` → `pong`; `status.get` → `gateway.status`.
- `chat.send`, `chat.stop`, `approval.respond`, `file.upload` return an `error`
  message with code `1008` (this gateway does not implement the chat protocol).
- Unknown types close with **4003**; revoked device closes with **4002**; server
  shutdown closes with **1001**.

## Gateway pages

`/mobile/pair`, `/mobile/` (home), `/mobile/devices`, `/mobile/oauth`, `/mobile/admin` (loopback only), `/mobile/shell` (full-screen same-origin iframe of the official DSH UI).

## DSH proxy

Every non-`/mobile/**`, non-`/auth/**` request is proxied after authentication,
including `/api`, `/api/remote.mux`, `/plugins/**` and the SPA. The proxy is
protocol-opaque: it never parses DSH's Remote frames.
