# dsh-gateway-mobile

[English](./README.md) | [中文](./README.zh.md)

A DSH host plugin that exposes your local `dsh web` session through an outbound **Cloudflare Quick Tunnel**, with one-time phone pairing and an optional **WeChat ClawBot/iLink** connection. DSH keeps listening on loopback; the plugin runs its own loopback gateway (default `127.0.0.1:3081`) and never exposes DSH's cookie.

Status: **v0.1.1**. Quick Tunnel is a Cloudflare testing/development facility.

## Quick start

Requires DSH `0.2.1-rc.2`, Node 22+, and cloudflared (auto-download fallback).

```powershell
npm install
npm run build
dsh plugin --profile web add <path-to-this-repo>
dsh --profile web --no-open
```

Open `http://127.0.0.1:3081/mobile/admin` on the computer, scan the QR with the phone, and enter the 8-character pairing code. The admin console is loopback-only.

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
- One-time pairing codes, per-device HMAC sessions, sliding renewal
- Device list with rename, revoke, cleanup, and silent expiry
- WeChat text/image chat bridged to a dedicated DSH session
- WeChat approvals, questions, plan review, and timed-question late answers
- Cross-session completion notifications with merge/cooldown/rate limits
- Admin console: overview, pairing, WeChat, devices, logs, settings
- Mobile opens the official DSH Web UI

## License

MIT. See [LICENSE](./LICENSE).
