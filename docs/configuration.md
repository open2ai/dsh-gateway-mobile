# Configuration

[English](./configuration.md) | [中文](./configuration.zh.md)

Configuration lives in the `config` object of the `gateway-mobile` row in your profile's
`cordis.patch.yml`. Defaults:

```yaml
- id: gateway-mobile
  config:
    enabled: true
    dataDir: ''                     # default: $DSH_HOME/gateway-mobile
    gateway:
      host: '127.0.0.1'             # loopback only
      port: 3081
      publicUrl: ''                 # optional: Named Tunnel / own reverse proxy
    tunnel:
      enabled: true
      mode: 'quick'                 # quick | named
      domain: ''                    # named: public hostname
      binaryPath: ''                # cloudflared path; empty = PATH/cache/download
      autoDownload: true
      version: '2026.10.3'
      sha256: ''                    # pin the downloaded binary
      protocol: 'http2'
      maxRetries: 10
      token: ''                     # named mode; prefer CLOUDFLARED_TUNNEL_TOKEN
      metricsPort: 0                # named health endpoint; 0 = gateway.port + 1000
      healthIntervalMs: 15000       # named connector health check interval
    auth:
      pairingTokenExpiry: 900
      sessionMaxAge: 86400
      requireOAuth: false
      oauthProviders: ['github']
      oauthAllowedUsers: []         # e.g. ['github:octocat']; empty = any bound account
      githubClientId: ''
      githubClientSecret: ''
      giteeClientId: ''
      giteeClientSecret: ''
    proxy:
      upstream: ''                  # empty = ctx.webServer.getOrigin()
      wsHeartbeatInterval: 30000
      maxRequestSize: 10485760
      requestTimeoutMs: 0
    security:
      rateLimitWindow: 300
      rateLimitMax: 300
      pairingMaxAttempts: 5
      pairingLockoutDuration: 300
      corsOrigins: []
      trustProxy: true
      secureCookies: 'auto'         # auto | always | never
    device:
      inactiveExpiryDays: 30
      maxDevicesPerUser: 10
    weixin:
      enabled: true
      allowOtherUsers: false        # only the bot owner may drive DSH by default
      allowedUsers: []              # extra allowed weixin user hashes
    log:
      level: 'info'
      maxEntries: 100
      maxBytes: 5242880             # rotate gateway.log at 5 MB
      maxFiles: 3                   # keep .1, .2, .3
```

`auth.pairingTokenExpiry` is the one-time code TTL (default 900s). `auth.sessionMaxAge` is
the paired-device cookie lifetime (default 86400s = 24h, validated up to 90 days). Active
sessions rotate the cookie after half their lifetime, so regular use does not require
re-pairing; idle sessions expire normally.

Both values can also be set per launch without editing the profile:

```powershell
$env:DSH_GATEWAY_SESSION_MAX_AGE = '604800'   # 7 days
$env:DSH_GATEWAY_PAIRING_TOKEN_EXPIRY = '900' # 15 minutes
dsh web --no-open
```

The admin console's Settings tab writes `<dataDir>/admin-settings.json`; stored values
override the profile config for the session and pairing lifetimes on the next start and
are applied immediately to newly issued cookies/codes. The API is documented in
[api.md](./api.md#local-admin-loopback-only-no-session-required).

`cloudflared` is resolved in this order: `tunnel.binaryPath` → `CLOUDFLARED_PATH` → `PATH`
→ cached download (`tunnel.version`). Auto-download is best-effort and warns when no
pinned hash is configured; for production set `tunnel.binaryPath` and `tunnel.sha256`.

## Named Tunnel health

In `tunnel.mode: 'named'` the manager starts cloudflared with a loopback metrics listener
(`tunnel.metricsPort`, default `gateway.port + 1000`) and polls its `/ready` endpoint for up
to 20 s. A connector that never becomes ready leaves the tunnel in `degraded` state instead
of pretending to be connected; `/health?deep=1` reports the same signal. The metrics
endpoint is bound to `127.0.0.1` only. Whether cloudflared exposes `/ready` across versions
**needs verification** — set `tunnel.metricsPort` explicitly if the default conflicts.

## WeChat sender policy

`weixin.allowOtherUsers` defaults to `false`: only the WeChat account that approved the QR
login (recorded as a salted hash, never the raw user id) can drive DSH, answer approvals or
receive completion notices. `weixin.allowedUsers` adds specific user id hashes to the
allowlist without opening the bot to everyone. Unauthorized senders are rejected, audited
and told once that they are not allowed.

## OAuth allowlist

When `auth.oauthAllowedUsers` is non-empty, a provider identity must match one of its
entries (`github:octocat`, `gitee:some-user`; the provider user id also works) or the bind
is rejected with `4010` / HTTP 403. Empty keeps the permissive behaviour of earlier
versions. The allowlist is checked when binding; tightening it does not unbind devices
that already bound an account.

## Runtime switches (no restart)

The admin console's **设置 → 运行开关** panel writes these to
`admin-settings.json` and applies them immediately through the live config; every one is
also restored on the next start:

| Key | Meaning |
|---|---|
| `tunnelEnabled` | start/stop the cloudflared process now |
| `weixinEnabled` | start/stop WeChat polling and notifications |
| `logLevel` | `debug` / `info` / `warn` / `error`; effective immediately |
| `proxyRequestTimeoutMs` | DSH upstream timeout (`0` = no timeout) |

```http
POST /mobile/api/v1/admin/settings
{ "tunnelEnabled": false, "logLevel": "debug", "proxyRequestTimeoutMs": 15000 }
```

`GET /admin/settings` returns the values under `runtime` next to the auth lifetimes and an
empty `restartRequired` list for fields that are hot-applied. The same endpoint still
accepts the auth fields (`sessionMaxAge`, `pairingTokenExpiry`) in the same request.

## Log retention

`log.maxEntries` bounds the in-memory ring used by `/logs`. `log.maxBytes` and
`log.maxFiles` rotate `<dataDir>/gateway.log` into `.1` … `.N`; writes are queued and
flushed on shutdown. `log.maxBytes` must be between 64 KiB and 1 GiB.

## Secret-key rotation

The admin console can rotate the AES-256-GCM/HMAC key without restarting. Keys live in
`<dataDir>/secret-keys.json` (`{version:2, active, keys:[…]}`) and the newest five are
retained so old ciphertext keeps decrypting and old session cookies keep verifying; new
tokens use the active kid. The source tree still accepts the legacy `secret.key` file and
migrates it as `k1`. Rotate from behind a trusted network: the endpoint is loopback-only
and CSRF-guarded, and a copy of `secret-keys.json` is a backup of every stored secret.
