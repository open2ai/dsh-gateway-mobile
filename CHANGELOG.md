# Changelog

[English](./CHANGELOG.md) | [中文](./CHANGELOG.zh.md)

## 0.2.0-next.0 - 2026-11-10

Workbench preview: the gateway console becomes a page inside the DSH Web UI.

- Adds a DSH browser half (`dsh.client`, `exports["./client"]`, `lib/client.js`) built by the new
  `scripts/build-client.mjs`; it registers a full-page `main` panel `gateway-mobile-workbench` plus
  a left-sidebar entry, mirroring the official Plugins/Schedules pages.
- Adds host bridge routes on the DSH Connection service (`ctx.connection.fetch.register`): `read/ping`
  for both desktop and paired phones, plus local-only `read/pairing`, `read/devices`, `read/logs`,
  `read/settings` and `POST admin/pairing/regenerate`. Same-origin, authenticated by DSH's browser
  session, and no loopback HTTP hop back into the gateway.
- The gateway now marks every forwarded request with `x-dsh-gateway-proxied` (stripping caller-supplied
  copies) and refuses the workbench local-only prefixes before proxying, so a paired phone cannot reach
  pairing codes, device lists, logs, settings or management actions even though it opens the same UI.
  The workbench bridge enforces the same split again (fail-closed) as defense in depth.
- Workbench UI (Phase 1/2): tabs for overview, pairing (QR + 8-character code + regenerate + copy link),
  devices, logs and editable settings. The overview also offers local tunnel controls (start/stop/restart).
  Settings (session lifetime, pairing TTL, tunnel/WeChat switches, log level, proxy timeout) save through
  local-only `POST /api/gateway-mobile/admin/settings`; tunnel actions use `POST .../admin/tunnel`.
  Phones see the overview only. The page uses DSH's semantic theme tokens (`--dsw-alias-label-*`,
  `--dsw-alias-bg-layer-*`, `--dsw-alias-border-*`, state colors), so it follows DSH light/dark appearance.
- Settings are grouped into cards: 插件版本, 隧道与配对 (tunnel/proxy switch, session lifetime, pairing TTL),
  微信 (channel + completion-notification policy: debounce, per-session cooldown, global interval, hourly cap),
  and 日志. WeChat settings use local-only `read/weixin` and `POST admin/weixin`.
- New 安全与维护 card: secret-key status and rotation (`read/keys`, `POST admin/key/rotate`),
  OAuth identity allowlist editing (`read/oauth`, `POST admin/oauth`, persisted in `admin-settings.json`),
  and audit-log JSON export (`read/audit`). All routes stay loopback-only.
- WeChat QR login, pending-connection approval, logout and approval history are now available in the
  workbench (local-only `admin/weixin/login` GET/POST, `admin/weixin/approve`, `admin/weixin/logout`,
  `read/weixin/approvals`). The standalone console remains as a compatibility fallback.
- The workbench now covers the admin-console maintenance flows; the standalone page can be retired
  after the remaining device rename/revoke actions move over.
- Layout follows the DSH main-panel page contract: header and tabs stay frozen, only the tab content
  scrolls, and tables/logs keep one-line cells where they must not wrap.
- Version bumped to `0.2.0-next.0` for the npm `next` dist-tag; `engines.dsh` stays pinned to `0.2.2-rc.1`.
- Activation needs one `dsh web` restart after `npm run build` (DSH caches client bundle manifests until restart).

## 0.1.4 - 2026-11-09

No version bump: a hardening/maintainability pass that keeps every existing API
backward compatible (additive fields and endpoints only).

- The DSH plugin page shows a curated introduction instead of the full README: `locale/zh.json` and `locale/en.json` declare `meta.title`/`meta.description`/`meta.detail`, rendered from `docs/DETAIL.zh.md` and `docs/DETAIL.md`; Chinese UIs default to Chinese.
- **WeChat owner trust boundary**: approving the QR login records a salted owner hash (the raw WeChat id is never persisted), and only the owner may drive DSH or answer approvals by default; `weixin.allowOtherUsers`/`weixin.allowedUsers` widen it, unauthorized senders are rejected and audited, and legacy credentials migrate on the first message.
- **WeChat channel state machine**: `WeixinStatus` gains `state` (disabled/idle/connecting/connected/degraded/expired), `lastPollAt`, `lastOkAt`, `failures`, `contextAgeMs`, `owner`; two consecutive `-14` responses are required to expire the session, contexts expire after 30 minutes, and send failures are classified (`weixinSendFailureReason`).
- **Message reliability**: inbound WeChat messages are deduplicated by `message_id`, stray `Y/N/number` replies without pending work are intercepted, and completion notices go to the owner context with classified retries, backoff and a visible permanent-failure counter.
- **Pairing continuity**: the pairing payload adds `status`, `previousUrl` and `urlChangedAt`; the admin console shows a re-pair banner when the public URL changes and refreshes an expired code automatically.
- **Authentication hardening**: `auth.oauthAllowedUsers` allowlist (error `4010`), `secret-keys.json` multi-key storage with `kid` and `POST /admin/key/rotate` (old sessions/ciphertext keep working), and pairing codes no longer reach logs in plaintext.
- **Service dependencies**: `inject` keeps `webServer`/`connection` plus `sessionController`/`workspaceRegistry` (the WeChat bridge and workspace resolver need them; Cordis has no optional inject form and `ctx.get()` cannot see a sibling-provided service without the declaration); `userQuestions` remains a probed optional capability, and the capability matrix reports what was resolved.
- **Operations**: `/health?deep=1` per-component readiness (required vs optional, 503 on failure), filtered `GET /admin/audit`, `GET /admin/capabilities`, asynchronous size-rotated logging, `npm run doctor`, and `npm run hmr-check`.
- **Named Tunnel**: real connector health through the metrics `/ready` endpoint; a connector that never becomes ready is reported as `degraded` instead of connected, and URL changes are recorded and broadcast.
- **Route split**: the mobile API moved to `src/routes/*` (public/session/devices/admin/weixin/oauth); `gateway.ts` keeps request admission, authentication, static assets, WebSocket and proxy orchestration.
- **PWA build versioning and weak networks**: `build:web` writes `web/assets/build.json` (content-hash manifest), the gateway injects `?v=<hash>` into served HTML, and `sw.js` derives its cache name and shell list from the build version instead of manual bumps; GET requests retry with exponential backoff and the UI shows online/offline and last-sync state.
- **Runtime switches**: the Settings tab can toggle the tunnel and WeChat channel, change the log level, and set the DSH proxy timeout; changes apply immediately, persist to `admin-settings.json`, and are restored on restart.
- **Cross-restart audit**: `/admin/audit` merges the in-memory ring with `gateway.log` and its rotated files, so entries from earlier processes are exportable.
- **Documentation/packaging consistency**: `npm run check-docs` validates version references and the distribution manifest; `scripts/pack.mjs` now derives its file list from `package.json.files`, so the zip matches npm.
- **Simplified overview**: the overview shows the status chips (gateway/tunnel/DSH/WeChat) plus alert/capability hints, with the KPI cards, quick actions and a request-trend chart (7/14/30-day switch) displayed directly (the collapsible "activity" header is gone); the capability matrix, deep-health checks and tunnel controls moved into **Help → Diagnostics**; logs are only shown in the Logs tab.
- **Bilingual documentation**: every English document under `docs/` gained a `*.zh.md` counterpart with a language switch at the top, plus a [docs/README.zh.md](docs/README.zh.md) index; the README now links the guides.
- Admin console: overview split into "Runtime status"/"Activity", a sectioned WeChat tab, a new "Help" tab, plus deep health, audit export, key rotation and the capability matrix.

## 0.1.3 - 2026-11-05

- Added compatibility with DSH `0.2.2-rc.1`; bumped the plugin to `0.1.3`.

## 0.1.2 - 2026-11-03

- Added compatibility with DSH `0.2.1-rc.5`; bumped the plugin to `0.1.2`.

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
