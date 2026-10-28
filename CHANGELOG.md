# Changelog

[English](./CHANGELOG.md) | [中文](./CHANGELOG.zh.md)

## 0.1.0 — 2026-10-23

First working implementation of the DSH Gateway Mobile plugin: a loopback gateway with Cloudflare Quick Tunnel, one-time device pairing, HMAC cookie sessions, and HTTP/WebSocket reverse proxying for DSH.

Ships the admin console and phone PWA pages (zh/en, dark/light) covering pairing, device revoke and permanent delete, logs, settings, OAuth binding and diagnostics, plus 51 automated tests and a real-DSH integration script.

- Added Phase 1 WeChat ClawBot/iLink channel: QR login, encrypted credential persistence, long-poll receive, text-send API and an admin WeChat connect panel.
- Added Phase 2 WeChat → DSH bridge: messages enter a dedicated persisted DSH session, follow committed assistant events, and send the final text back with the inbound `context_token`.
- Added DSH approval forwarding to WeChat: agent-scoped prompts show a random approval ID and accept replies `允许 <id>` / `拒绝 <id>`, with timeout rejection and fail-closed handling.
- Added inbound WeChat images: CDN download, dual-format AES-128-ECB key handling, media-type sniffing, attachment admission as DSH image prompt parts.
- Changed WeChat QR binding to require loopback-admin approval: a confirmed scan stays pending with a masked account ID, full `ilink_user_id` is never persisted or logged, and only approval saves credentials and starts polling.
- Added cross-session WeChat completion notifications: watches all top-level DSH sessions, merges completions for 5s, enforces 60s per-session and 15s global cooldowns, caps at 30/hour by default, skips child/WeChat sessions, and persists a pending outbox until a fresh `context_token` is available.
- Added the admin WeChat notification switch and recent-delivery history, persisted in `weixin-notify-state.json`.
- Added cross-session WeChat approvals with an independent 60/hour quota, separate approval history, and session/tool context in the prompt; replies are simply `Y`/`N` (or 允许/拒绝), while the approval ID stays internal. Approval prompts do not consume the 30/hour completion notification quota.
- Changed the default completion-notification pacing to 5s merge / 60s per-session / 15s global / 30 per hour.
- Added live completion-notification policy settings (merge window, per-session cooldown, global interval, hourly cap) persisted in `weixin-notify-state.json` and applied without a restart.
- Added WeChat forwarding for `ask_user_question` prompts: single and multi-question batches are answered sequentially, with option-number, option-label, multi-select, custom-text, and "skip" replies supported.
- Added late-answer support for timed `ask_user_question`: after the foreground wait expires, a later WeChat reply is submitted through `userQuestions.answer(agent, callId, answer)` while the session remains live.
