# Security notes

## Assets

| Asset | Exposure |
|---|---|
| Host shell (agent runs as the current Windows user) | Full machine compromise if the gateway/session is stolen |
| `$DSH_HOME` credentials and session logs | Source code, keys, conversation history |
| DSH owner cookie / launch token | Full owner API access |
| Phone pairing code / session cookie | Access to the gateway, hence DSH |
| Approval channel | Can approve dangerous commands |
| OAuth client secrets | Provider account abuse (host-side only) |

## Trust boundaries

1. **Phone ↔ Cloudflare edge**: public TLS; Cloudflare terminates TLS and can see plaintext. This is inherent to Quick Tunnel.
2. **Cloudflare edge ↔ local gateway**: outbound tunnel; Cloudflare originates requests to `127.0.0.1:3081`.
3. **Gateway ↔ DSH**: loopback; gateway holds DSH's cookie and rewrites Host/Origin to DSH's loopback authority.
4. **DSH ↔ untrusted web/file content**: prompt-injection boundary; the gateway cannot fix it, only reduce approval mistakes.

## Controls implemented

| Control | Where |
|---|---|
| Gateway binds loopback only (validated config) | `config.js` rejects non-loopback hosts |
| Host allowlist (loopback, current tunnel host, configured public host) | `gateway.js#hostInfo` |
| Origin authority match + `Sec-Fetch-Site` check | `gateway.js#checkOrigin` |
| One-time pairing code (8 chars, TTL, single use, auto-rotate) | `pairing.js` |
| Pairing failure lockout (default 5 attempts / 5 min) | `ratelimit.js`, `gateway.js` |
| HMAC-SHA256 session cookie, constant-time verify, expiry | `sessions.js` |
| Device status re-check on every request; revoke closes sockets | `devices.js`, `gateway.js` |
| CSRF header for state-changing API calls | `gateway.js#assertCsrf` |
| Sliding-window API rate limit | `ratelimit.js` |
| Local-only admin/log APIs and admin page | `gateway.js#hostInfo` + `#authenticate` route checks |
| Permanent device-record deletion loopback-only, revoked/expired records only, CSRF-guarded | `gateway.js` device routes + `devices.js#remove/purgeInactive` |
| Body limit + JSON size limit | `proxy.js`, `gateway.js#readJson` |
| DSH cookie kept in process; client cookies stripped | `proxy.js` |
| Redacted log/audit trail | `logger.js` |
| Config secret data never copied into the phone UI | `oauth.js`, `gateway.js` |
| Local admin bootstrap (no session) limited to loopback + non-proxied requests | `gateway.js#authenticate` |

## Pairing and session lifecycle

```
admin page (loopback) ──pairing code/QR──► phone
phone ──POST pairing/verify──► gateway
  ├─ consume code (single use, TTL)
  ├─ register device (max devices, name/UA/IP)
  └─ issue dsh_session (HMAC; 24h default)
phone ──cookie──► gateway ──deviceActive?──► proxy/authz
revoke ──► device.revoked, sockets closed, next request 3001
admin (loopback) ──► delete/purge ──► record removed from devices.json
```

Revoked records are kept so the audit trail and the device list stay intact; they can
only be **permanently** deleted from the loopback admin console (`DELETE /devices/{id}`
or `POST /devices/purge`), and the API refuses to delete a device that is still active
(`4009`).

The DSH owner cookie is **not** part of this chain. Losing a phone exposes only that
device's gateway session; revoking the device invalidates it. The DSH owner can still
be revoked globally by deleting `client-connection/browser-session` and restarting DSH.

## Quick Tunnel-specific risks

- Cloudflare sees plaintext (chat, commands, files). Do not use for content that must
  stay private from Cloudflare; use a Named Tunnel with your own edge or a private
  network instead.
- The hostname changes on restart. Browser cookies are host-scoped, so the phone must
  re-pair; a native shell could persist a device token across hosts.
- No SSE: DSH's `/plugins/events` HMR stream degrades; the first page load still works
  from the injected boot graph.
- No SLA, 200 in-flight requests; Cloudflare may throttle.
- It is a testing/development facility; not a production exposure mechanism.

## Local admin without a session

The first-run flow needs the pairing QR before any device exists. The admin page and
`/admin/*` APIs are therefore reachable from **loopback only** without a session. This
is a deliberate local-trust decision: any local process that can reach loopback can
already read the DSH credentials and profile files. Requests through the tunnel always
carry the public Host, and requests with `cf-*`/`x-forwarded-*` headers are never
treated as local.

## Agent execution safety

- The gateway does not bypass DSH approvals or sandbox presets.
- Approval prompts are rendered by the official DSH UI; the gateway only proxies them.
- For high-risk work, set the session to `read-only`/`workspace-write`, and use
  `danger-full-access` only with deliberate action.
- Prompt injection remains the top residual risk; prefer a dedicated workspace for
  mobile sessions and review commands before approving.

## Operational checklist

- [ ] `gateway.host` stays `127.0.0.1`.
- [ ] `auth.requireOAuth` decision is deliberate; OAuth secrets configured only if used.
- [ ] Pairing code delivered over a trusted channel (QR on your own screen).
- [ ] Quick Tunnel stopped when not in use (`/mobile/admin`).
- [ ] Device list reviewed; unknown/old devices revoked, stale revoked records deleted.
- [ ] `cloudflared` version/hash pinned (`tunnel.binaryPath`/`tunnel.sha256`).
- [ ] Logs checked for repeated pairing failures (`4001`/`4002`).
- [ ] DSH approval/sandbox settings appropriate for mobile use.
- [ ] If Cloudflare visibility is unacceptable, switch to Named Tunnel/private network.

## Residual risks

- Cloudflare edge visibility (content and metadata).
- Phone compromise / unlocked phone with an active session.
- OAuth provider compromise or misconfigured callback URI (Gitee is byte-exact).
- Quick Tunnel availability and hostname churn.
- JSON device store integrity if the local user/process is compromised.
