# DSH Mobile & WeChat Gateway

Expose your local `dsh web` to a phone through an outbound **Cloudflare Quick Tunnel**; optionally connect **WeChat ClawBot/iLink** to handle approvals, answer questions, and receive completion notices. DSH itself keeps listening on loopback only.

## What it solves

- Continue a DSH session from a phone when you are away from the LAN and have no public IP.
- Answer approvals and questions from your phone, and get completion notices pushed to WeChat.
- Avoid exposing DSH's cookie or port to the public internet.

## Highlights

- **Phone access** — the admin console issues a one-time pairing code; scan and enter the 8-character code. Each device gets its own HMAC session with sliding renewal, rename, revoke, and silent expiry.
- **WeChat channel** — scan to log in to ClawBot/iLink; text and images bridge both ways to a dedicated DSH session; only the bound WeChat account may send messages, answer approvals or receive notices by default; approvals reply `Y`/`N`, and `ask_user_question` accepts option numbers, option text, multi-select `1,3`, custom text, or skip.
- **Completion notices** — cross-session pushes with a merge window, per-session cooldown, global interval, and hourly cap, all tunable in the admin console.
- **Operations panel** — tunnel start/stop/reconnect and status, WeChat runtime state and owner, device list, logs, connection diagnostics, deep health checks, audit export, key rotation, a help tab, dark theme, and a Chinese/English UI.

## Requirements

- DSH `0.2.2-rc.1` (exact `engines.dsh` match).
- cloudflared (the plugin tries to download it when missing).
- The admin console is loopback-only: `http://127.0.0.1:3081/mobile/admin`.

## Security model

- DSH never listens publicly; the gateway terminates the public entry and proxies to DSH only after verifying the device session.
- DSH's browser cookie stays inside the local plugin process and is never sent to devices.
- Full WeChat user IDs are neither persisted nor logged; the bot token is stored encrypted; a QR login can only be approved from the loopback admin console.
- Quick Tunnel is a Cloudflare testing/development facility; for long-term use prefer a Named Tunnel or your own reverse proxy.

## Limitations

Known limitations and deviations live in the repository's `docs/limitations.md` and `docs/deviations.md`.
