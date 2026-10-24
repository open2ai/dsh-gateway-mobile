# Known limitations

- **Quick Tunnel**: no SLA, random hostname on each restart (browser cookies are
  host-scoped, so the phone must re-pair), 200 in-flight requests, no SSE
  (`/plugins/events` HMR degrades), and Cloudflare can read plaintext.
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

- Phone PWA pages are cached by a service worker for the app shell. Asset URLs carry a
  `?v=` query and the cache name is bumped on every UI change; after editing phone assets,
  bump those versions (and `CACHE` in `web/sw.js`) so installed PWAs pick the new files up.

See [deviations.md](./deviations.md) for differences from the original product documents.
