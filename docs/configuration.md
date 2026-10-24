# Configuration

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
    auth:
      pairingTokenExpiry: 900
      sessionMaxAge: 86400
      requireOAuth: false
      oauthProviders: ['github']
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
    log:
      level: 'info'
      maxEntries: 100
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
