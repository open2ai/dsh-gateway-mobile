# dsh-gateway-mobile

[English](./README.md) | [中文](./README.zh.md)

A DSH host plugin that exposes your local `dsh web` session to **paired mobile devices** through an outbound **Cloudflare Quick Tunnel**. DSH keeps listening on loopback; the plugin runs its own loopback gateway (default `127.0.0.1:3081`), authenticates every request with a per-device session, and proxies to DSH without exposing DSH's cookie to the phone.

Status: **v0.1.0**. Quick Tunnel is a Cloudflare testing/development facility.

## Quick start

Requires DSH `0.2.1-rc.2` , Node 22+, and cloudflared (auto-download fallback).

From a fresh clone, install dependencies and build once:

```powershell
npm install
npm run build
```

Then add the plugin:

```powershell
dsh plugin --profile web add xxxpath/dsh-gateway-mobile
dsh --profile web --no-open
```

Open `http://127.0.0.1:3081/mobile/admin` (alias `/admin`) on the computer, scan the QR with the phone, and enter the 8-character code. The admin console is loopback-only.

## What it does

- Quick Tunnel lifecycle (HTTP/2) with reconnects, start/stop/restart and status
- One-time pairing codes, per-device HMAC sessions, sliding renewal
- Device list with rename, single/batch revoke, permanent cleanup of revoked records, silent expiry
- WeChat ClawBot/iLink channel: QR login stays pending until the loopback admin approves the scan, the full WeChat user ID is never persisted or logged, encrypted credential persistence, long-poll receive, text and inbound-image conversation with a dedicated DSH session, and approval prompts answerable in WeChat
- Cross-session WeChat completion notifications: watches all top-level DSH sessions/workspaces, 5s merge window, 30s per-session cooldown, 10s global interval, hard cap 20/hour, and excludes the WeChat-created session
- Cross-session approval notifications: any workspace approval can be answered from WeChat, with an independent 60/hour approval quota and a separate approval history (`weixin-approval-history.json`)
- Admin console: overview, pairing, WeChat connect, devices, logs, settings
- Mobile UI opens the official DSH Web UI; native chat UI and `/mobile/ws` chat protocol are deferred

## License

MIT. See [LICENSE](./LICENSE).
