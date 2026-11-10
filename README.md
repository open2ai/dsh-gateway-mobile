# dsh-gateway-mobile

[English](./README.md) | [中文](./README.zh.md)

A DSH host plugin that exposes your local `dsh web` session through an outbound **Cloudflare Quick Tunnel**, with one-time phone pairing and an optional **WeChat ClawBot/iLink** connection. DSH keeps listening on loopback; the plugin runs its own loopback gateway (default `127.0.0.1:3091`) and never exposes DSH's cookie.

Status: **v0.2.0-next.0** (workbench preview). Quick Tunnel is a Cloudflare testing/development facility.

## Quick start

Requires DSH `0.2.2-rc.1`, Node 24+, and cloudflared (auto-download fallback).

```powershell
npm install
npm run build
dsh plugin --profile web add <path-to-this-repo>
dsh --profile web --no-open
```

Open `http://127.0.0.1:3091/mobile/admin` on the computer, scan the QR with the phone, and enter the 8-character pairing code. The admin console is loopback-only.

## WeChat

In the admin console, open **WeChat**, generate the QR code, scan it with WeChat, and approve the connection on the computer. Send the bot one message after connecting so it has a `context_token`.

Then you can use WeChat for:

- **Approvals** — reply `Y` to allow or `N` to reject.
- **Questions** — reply with an option number, option text, custom text, or `1,3` for a multi-select question; reply `跳过` to skip.
- **Plan review** — handled through the same question flow.
- **Completion notices** — enable and tune them in **Settings → WeChat connection & notifications**. Defaults: 5s merge, 60s per-session cooldown, 15s global interval, 30 per hour.

WeChat handles an approval or question only while it has a valid inbound context; otherwise the phone/desktop DSH Web UI handles it. The full WeChat user ID is never persisted or logged, and the bot token is stored encrypted. Only the loopback admin can approve a QR login.

## What it does

- Quick Tunnel lifecycle (HTTP/2) with reconnect, start/stop/restart, and status
- Named Tunnel connector health via the metrics `/ready` endpoint (degraded instead of a false "connected")
- One-time pairing codes, per-device HMAC sessions, sliding renewal
- Device list with rename, revoke, cleanup, and silent expiry
- WeChat text/image chat bridged to a dedicated DSH session, owner-only by default
- WeChat approvals, questions, plan review, and timed-question late answers
- Cross-session completion notifications with merge/cooldown/rate limits
- Admin console: overview (status chips + KPI/quick actions/request trend chart with 7/14/30-day switch), pairing, WeChat, devices, logs, settings, help with diagnostics
- **DSH Web UI workbench (preview)** — a “移动端网关” page and left-sidebar entry inside DSH Web UI (status overview + links to the standalone console), backed by same-origin `/api/gateway-mobile/read/*` routes; the standalone console stays available
- `/health?deep=1` readiness, filtered audit export, key rotation, and a capability matrix
- `npm run doctor` environment check and `npm run hmr-check` reload smoke test
- Mobile opens the official DSH Web UI

## Documentation

The full documentation index is [docs/README.md](./docs/README.md) (English and Chinese).
Frequently used guides:

- [Architecture](./docs/architecture.md) · [Architecture flows](./docs/architecture-flow.md)
- [API](./docs/api.md) · [Configuration](./docs/configuration.md) · [Security](./docs/security.md)
- [Admin console](./docs/admin-console.md) · [Mobile workspace](./docs/mobile-workspace.md)
- [Development](./docs/development.md) · [Known limitations](./docs/limitations.md) · [Deviations](./docs/deviations.md)

## Roadmap

Next steps, priorities, and open questions are in [docs/roadmap.md](./docs/roadmap.md).

## License

MIT. See [LICENSE](./LICENSE).
