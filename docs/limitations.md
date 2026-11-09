# Known limitations

[English](./limitations.md) | [中文](./limitations.zh.md)

- **Quick Tunnel**: no SLA, random hostname on each restart (browser cookies are
  host-scoped, so the phone must re-pair), 200 in-flight requests, no SSE
  (`/plugins/events` HMR degrades), and Cloudflare can read plaintext. The admin console
  now flags the hostname change (`previousUrl`/`urlChangedAt`) and auto-refreshes an
  expired pairing code, but the phone still has to pair again.
- **Named Tunnel health**: cloudflared is started with a loopback metrics listener and its
  `/ready` endpoint is polled for up to 20 s; the `/ready` payload semantics across
  cloudflared versions **need verification**, and port conflicts are resolved only through
  `tunnel.metricsPort`.
- **WeChat owner migration** is trust-on-first-use for credentials created before 0.1.4:
  the first inbound message after upgrading becomes the owner.
- **Audit export** merges the in-memory ring with the JSONL log and its rotated files, so
  it covers the retention window (`log.maxFiles` × `log.maxBytes`) across restarts;
  entries older than the rotated files are gone.
- **Weak networks**: PWA pages are cached by the service worker, but API/WebSocket traffic
  is never cached; GET requests retry with exponential backoff and the UI shows
  offline/last-sync state. There is no offline chat or queued prompt yet.
- The mobile UI is the official DSH Web UI plus gateway pages; a dedicated mobile chat UI
  is deferred.
- The custom `/mobile/ws` chat protocol is a skeleton (`NOT_SUPPORTED` for chat, approval
  and file messages).
- OAuth callback URLs must be updated when the Quick Tunnel hostname changes; use a Named
  Tunnel or `gateway.publicUrl` for stable OAuth.
- The device store is JSON (single user, atomic rewrites), not SQLite; revoked/expired
  records stay in `devices.json` until deleted or purged from the admin console and do not
  count against the active-device limit.
- cloudflared's hash is only pinned when `tunnel.sha256` (or a known hash) is configured.

See [deviations.md](./deviations.md) for differences from the original product documents.
