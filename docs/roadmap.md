# dsh-gateway-mobile Roadmap

[English](./roadmap.md) | [中文](./roadmap.zh.md)

> For the plugin author, running on one machine. Baseline: plugin `0.1.4` (in the working tree, with `locale/` and `docs/DETAIL.*`), DSH `0.2.2-rc.1`. This document covers only concrete next steps; it does not repeat shipped features.

## Overall assessment

The plugin is past the "does it work" stage: Quick Tunnel, one-time pairing, device sessions, DSH proxying, and the WeChat login/bridge/approval/question/notification paths all exist with automated tests, and 0.1.4 adds the bilingual DSH plugin-page introduction. The bottlenecks are now about surviving long-running use: WeChat has no sender trust boundary, channel state and `context_token` expiry can only be guessed from logs, a Quick Tunnel hostname change forces re-pairing, authentication lacks an OAuth allowlist and key rotation, and `inject` declares DSH's optional services as hard dependencies, so one DSH upgrade can stop the plugin from loading. Treat 0.1.5 as an API-neutral security/stability patch and 0.2.0 as the maintainability and mobile-experience pass; a dedicated chat UI and multi-user are not goals yet.

## Priority legend

- **P0**: leaving it undone will hurt, or will make every later change more expensive.
- **P1**: visible day-to-day experience and operability.
- **P2**: shape decisions that need validation of DSH capabilities and real needs first.

## Current state and non-goals

Already working, therefore not "to do": Quick Tunnel lifecycle and reconnects, one-time pairing plus device revoke/expiry, HMAC sessions with sliding renewal, DSH HTTP/WS proxying, the six-section admin console, phone PWA pages, GitHub/Gitee OAuth binding, WeChat QR login with encrypted credentials, text/image bridging, approval and question forwarding, late answers for timed questions, cross-session notices with pacing controls, request statistics, i18n, and theming.

Out of scope: bypassing DSH approvals or sandboxes, exposing DSH's port directly, depending on undocumented DSH Remote REST/internal protocols, or keeping a second copy of models/sessions inside the plugin. Each would overturn the current trust model for little gain.

## P0 Stability / security / maintainability

### P0-1 WeChat sender trust boundary

**Problem**: `WeixinChannel.#acceptMessage()` calls the bridge for any `from_user_id`, `WeixinBridge.handle()` feeds it to DSH as a prompt, and `WeixinNotifier.flush()` sends to `channel.lastInbound` rather than the account that owns the bot. Anyone who can message the bot can drive a DSH session, join approvals, and may receive completion notices. Credentials store no owner today.

**Approach**: Record the owner at `approveLogin()`; keep the full ID in memory and persist only an HMAC/SHA-256 fingerprint. Reject non-owners by default with a short reply, behind `weixin.allowOtherUsers` (default false) and an optional `allowedUsers` list. Store `contexts` as `{ token, at }` and notify only the owner's context. For legacy credentials, treat the first inbound message after upgrade as the owner, audit it, and show a masked account plus "re-bind" in the admin console.

**Scope**: medium (`src/weixin.ts`, `src/weixin-bridge.ts`, `src/weixin-notifier.ts`, `src/config.ts`, `src/gateway.ts`, `web/src/admin.ts`).

**Risk**: family or a secondary account may be locked out; migration must run once, only when no owner exists, with a clear admin explanation.

### P0-2 WeChat channel state machine and context-token lifetime

**Problem**: `#pollLoop()` deletes credentials and stops polling on `ret=-14`, forcing a new QR scan. Other failures only bump `failures` with fixed 2s/30s backoff, and the operator can only infer state from `lastError`. `sendText()` does not distinguish token expiry, network errors, and server rejection; `contexts` have no timestamp, so notifications can retry a stale token forever.

**Approach**: Make `WeixinChannel` an explicit state machine (`connected` / `degraded` / `expired`), clearing credentials only after two consecutive `-14` responses. Add `lastPollAt`, `lastOkAt`, `failures`, and `contextAge` to `status()`. Classify send failures; on token errors mark the context stale and tell the admin to send the bot a message. Add "log in again". Retry notifications with exponential backoff and only the owner's valid context.

**Scope**: medium (`src/weixin.ts`, `src/weixin-notifier.ts`, the `/admin/weixin` routes in `src/gateway.ts`, `web/src/admin.ts`).

**Risk**: iLink error codes and the exact meaning of `-14` are undocumented, so expiry conditions need real-device verification (**needs verification**). Do not treat transient network failures as logout.

### P0-3 Public entry and pairing continuity

**Problem**: Quick Tunnel gets a new hostname on every restart, cookies are host-scoped, and the phone must re-pair. The change is visible only in `gateway.log` and the `/mobile/ws` status broadcast. `PairingManager` does not reissue an expired code (`status()` reports `valid:false`), so pairing stays broken until someone clicks "regenerate". `tunnel.mode: 'named'` only concatenates `--token run` and assumes the URL after a fixed `sleep(1200)`, with no connector health check.

**Approach**: (a) on a URL change, issue a new code and, if the WeChat owner context exists, push "new address + one-time pairing link" behind a config switch; (b) refresh an expired code when the admin page is visible (or show an explicit expired/refresh state); (c) show a persistent notice and QR on the overview page; (d) add a real Named Tunnel health check (cloudflared metrics/connector state), complete validation/docs for `tunnel.domain` and `gateway.publicUrl`, and remove the fixed sleep.

**Scope**: medium (`src/tunnel.ts`, `src/pairing.ts`, `src/gateway.ts`, `web/src/admin.ts`, reusing the send path in `src/weixin.ts`).

**Risk**: pushing a pairing link over WeChat hands the entry point to that account, so it must be opt-in, short-TTL, single-use, and audited. Named Tunnel needs a real domain and Cloudflare account and cannot be fully unit-tested (**needs verification**).

### P0-4 Authentication and device security closure

**Problem**: `auth.requireOAuth` requires binding *any* GitHub/Gitee account, with no allowlist, so the second factor is effectively "sign up and you're in". One `secret.key` signs sessions and encrypts WeChat credentials with no version or rotation path; rotating it silently invalidates every device. Pairing codes are written in plaintext to `gateway.log` by `PairingManager.issue()` and the startup log in `src/index.ts`, so exporting logs leaks a valid code. Audit data is only a 100-entry memory ring plus JSONL, with keyword search but no stable action-based filter or export. The pairing lockout key is `IP|UA`, so changing the UA resets the counter.

**Approach**: Add `auth.oauthAllowedUsers` (provider + login/userId), checked at bind time and on later requests. Give `secret.key` a `kid`, keep old keys for decryption, add a "rotate key" admin action with confirmation and a re-pair warning. Log only the last two characters or a hash of pairing codes. Add a loopback-only `GET /admin/audit?action=&since=` export. Key pairing lockout on IP alone with increasing delay.

**Scope**: medium (`src/config.ts`, `src/oauth.ts`, `src/devices.ts`, `src/store.ts`, `src/sessions.ts`, `src/pairing.ts`, `src/gateway.ts`, `web/src/admin.ts`).

**Risk**: a misconfigured allowlist locks the owner out; document a loopback recovery path. Key rotation is destructive and needs explicit confirmation plus a data-directory backup.

### P0-5 Declare only genuinely required services

**Problem**: `inject = ['webServer', 'connection', 'sessionController', 'workspaceRegistry']` in `src/index.ts`. Every name in a Cordis 4 `inject` array is required (`registry.d.ts` defines `Inject` as an array or an intercept-config map, with no optional form). If DSH renames or removes any one, the whole plugin fails to load, including the loopback gateway and pairing page. `WeixinBridge` and `WeixinNotifier` already tolerate a missing `controller`.

**Approach**: Keep only `webServer` and `connection` in `inject`; read `sessionController`, `workspaceRegistry`, and `userQuestions` with `ctx.get()` and probe capabilities at startup. Expose a capability matrix (controller / workspace / userQuestions / weixin) in `/status` and the admin overview, degrading WeChat bridging with a visible reason. Add a "missing optional services" profile variant to `scripts/integration-check.mjs`.

**Implemented outcome**: the probe cannot work that way — Cordis's `ctx.get()` only resolves services declared in `inject` for the calling fiber (the `internal/service` store is keyed through the isolate map created by injection), so `sessionController`/`workspaceRegistry` returned false while DSH was healthy. They are required again; `userQuestions` stays an optional probed capability and the matrix reports the resolved values.

**Scope**: small-medium (`src/index.ts`, `src/gateway.ts`, `web/src/admin.ts`, `scripts/integration-check.mjs`).

**Risk**: whether `ctx.get()` sees an undeclared service, and when, needs verification (**needs verification**). Silent degradation looks like breakage, so capability state must be explicit.

### P0-6 Compatibility checks: DSH upgrades and HMR

**Problem**: Each DSH upgrade changes `engines.dsh` and runs unit tests, while `scripts/integration-check.mjs` is manual. There is no smoke test for a linked install under HMR. The plugin owns port 3081 and a cloudflared child; a reload window where the old disposer has not finished can produce `EADDRINUSE` or an orphan cloudflared (**needs verification**: whether `ctx.effect` async cleanup is awaited during reload).

**Approach**: Split the integration check into `smoke` (current) and `capability` (missing optional services, no WeChat config, `tunnel.enabled:false`). Add `scripts/hmr-check.mjs`: start dsh web with the plugin linked, touch `lib/index.js`, assert the port works, exactly one cloudflared exists, and old WS connections close. Record the tested DSH version matrix in the release checklist.

**Scope**: small (`scripts/`, `docs/development.md`, `package.json` scripts).

**Risk**: HMR behavior depends on the DSH version (**needs verification**). On Windows the child tree needs `taskkill /T`; the scripts already have a precedent.

### P0-7 Gateway maintainability and log retention

**Problem**: `src/gateway.ts` is 1372 lines with 40-plus inline route branches; adding one admin endpoint touches routing, the auth allowlist, and the frontend. `src/logger.ts` calls `appendFileSync` per entry and `gateway.log` grows without bound; `maxEntries` only caps the memory ring, so logs are hard to read and long runs can block requests.

**Approach**: Split routing into `src/routes/{pairing,devices,weixin,admin,oauth,session}.ts` plus one `Router` table (path, method, local-only, CSRF, handler), leaving Host/Origin/auth/proxy orchestration in `gateway.ts`. Move logging to an async queue with size rotation (for example 5 MB x 3, `log.retentionDays`) and redact pairing codes. Add a loopback-only `GET /mobile/api/v1/admin/diagnostics` returning versions, capability matrix, tunnel/WeChat state, recent errors, and the log tail, with an "export diagnostics" action.

**Scope**: medium (`src/gateway.ts` split, `src/logger.ts`, `web/src/admin.ts`, `test/`).

**Risk**: a route split can drop an auth check; use `gateway.test.js` for regression and add a "non-loopback admin access" case. Diagnostic bundles must be redacted: no tokens, pairing codes, or WeChat IDs.

## P1 Experience

### P1-1 Weak networks, offline, and PWA updates

**Problem**: `web/src/app.ts` polls every 15 seconds and only shows a toast on failure; `shell.ts` hides loading unconditionally after 12 seconds with no fallback when the iframe fails; `sw.js` cache lists and page `?v=` queries are bumped by hand (as `docs/development.md` says), so a forgotten bump leaves installed PWAs on old code.

**Approach**: Add connection state and exponential backoff to `web/src/common.ts`, listening to `online/offline`. Show "last synced/offline" in `app.ts`; offer retry and diagnostics after a `shell.ts` timeout. Emit `web/assets/manifest.json` (filename + hash) from `scripts/build-web.mjs`, inject `?v=` server-side, and key `sw.js` `CACHE` on the build id. Announce state changes with `aria-live`.

**Scope**: small-medium (`web/src/common.ts`, `app.ts`, `shell.ts`, `web/sw.js`, `scripts/build-web.mjs`, static injection in `src/gateway.ts`).

**Risk**: changing the service-worker strategy can blank the page; keep `skipWaiting` and a rollback note. The injection path must still allow opening `web/` directly for debugging.

### P1-2 Message reliability

**Problem**: Inbound messages are not de-duplicated by `message_id`, so long-poll replays create duplicate prompts and approval cards. With no pending approval, `Y`/`N` (or `1` with no pending question) is forwarded by `WeixinBridge.handle()` to DSH as a normal message. Notification failures are only requeued, with no permanent/transient distinction.

**Approach**: Keep an LRU of recent `message_id` values in `WeixinChannel`. In `handleApprovalReply`/`handleQuestionReply`, answer "nothing is pending" instead of enqueueing when no interaction is open. Classify `sendText` errors with one idempotent retry (`client_id` derived from content and message ID). Track `attempts/lastError` in the outbox and surface permanent failures as "undelivered" in the admin console.

**Scope**: small (`src/weixin.ts`, `src/weixin-bridge.ts`, `src/weixin-notifier.ts`, `web/src/admin.ts`).

**Risk**: a small dedupe window still allows replays, a large one costs memory. Filtering `Y` could block a user who really means it; intercept only while an interaction is pending.

### P1-3 Health checks and metrics

**Problem**: `/health` always returns 200 with `ok:true`, so a down tunnel, unreachable DSH, or invalid WeChat token is invisible. `stats.json` has only per-day/per-device request counts, no proxy 5xx, WS count, tunnel reconnects, or WeChat send failures, so the charts cannot localize a problem.

**Approach**: Add `/health?deep=1` (or `/health/ready`) with per-component status and a 503 when degraded. Extend `StatsStore` with counters retained 30 days. Add an "errors/reconnects" trend and "recent failures" list to the overview, plus a `checks` array in `/status`.

**Scope**: medium (`src/gateway.ts`, `src/stats.ts`, `web/src/admin.ts`, `docs/api.md`).

**Risk**: external monitors may use the deep check as liveness; document liveness versus readiness. Do not rename counters after release.

### P1-4 Admin information architecture and documentation entry

**Problem**: "Overview" puts tunnel, WeChat, KPIs, charts, and logs on one tab, too dense on narrow screens. The WeChat tab handles login, re-binding, notification policy, and approval history at once. There is no Help/About entry; `docs/DETAIL.zh.md` only appears on the DSH plugin page, so troubleshooting means returning to the repository. The admin console must stay loopback-only.

**Approach**: Split Overview into "Runtime state" (tunnel/WeChat/DSH/capability matrix) and "Activity" (charts/recent logs). Give WeChat secondary sections (connection / notifications / approvals). Add a read-only Help tab sourced from `docs/DETAIL.zh.md` plus common failures (pairing failure, tunnel down, WeChat without context) and config links. Use collapsible cards on narrow screens; phones get only their own state and diagnostics through `/mobile/`.

**Scope**: medium (`web/admin.html`, `web/src/admin.ts`, `web/assets/admin.css`, `docs/DETAIL.*`).

**Risk**: frontend-only work drifts from backend fields; reuse existing APIs. Help content needs versioning or it becomes another stale document.

### P1-5 Install and upgrade experience

**Problem**: `engines.dsh` is an exact match and Node must be >= 24, so a DSH upgrade can stop the plugin from loading, yet there is no self-check. `package.json` `files` ships only `docs/DETAIL.*` while `scripts/pack.mjs` copies all of `docs/`, so npm and zip differ. `docs/architecture-flow.md` says plugin 0.1.1/DSH 0.2.1-rc.4, `docs/api.md` examples say 0.1.0, and `docs/deviations.md` says 0.2.1-rc.2.

**Approach**: Add `scripts/doctor.mjs` (Node/DSH versions, cloudflared version and hash, port 3081, writable dataDir, profile row, DSH cookie exchange) with copyable output, exposed as `npm run doctor`. Align `files` with the pack list. Add `scripts/check-docs.mjs` for version references against `package.json`/`engines`, and `docs/upgrade.md`.

**Scope**: small (`scripts/`, `package.json`, `docs/`).

**Risk**: how doctor reads the installed DSH version depends on package layout (**needs verification**). An over-strict checker blocks releases; default to warnings, fail only with `--strict`.

### P1-6 Runtime switches and config application

**Problem**: The admin console can only change session lifetime, pairing TTL, and WeChat notification pacing live. `tunnel.enabled`, `weixin.enabled`, and `proxy.requestTimeoutMs` still need a profile edit and restart, so the obvious "turn off the public entry" or "pause WeChat" action is killing the process. `admin-settings.json` persists only the two `auth` fields.

**Approach**: Extend the online-editable whitelist (`tunnel.enabled`, `weixin.enabled`, `weixin.notify.enabled`, `log.level`, `proxy.requestTimeoutMs`) through the existing `SettingsStore` validation and persistence, applied to the in-memory `config` and restored by `applyToConfig` on restart. Mark restart-only fields in the UI. The tunnel switch must call `TunnelManager.start()/stop()`, not just flip a flag.

**Scope**: medium (`src/settings.ts`, `src/gateway.ts`, `src/index.ts`, `web/src/admin.ts`).

**Risk**: hot config diverges from the profile value, so show both. Keep `SettingsStore` validation aligned with `normalizeConfig` so it cannot persist a value startup would reject.

## P2 Long-term shape

### P2-1 Dedicated mobile chat and approval UI

**Problem**: `/mobile/ws` is still a skeleton (`chat.send`, `approval.respond` return `1008`), so the phone opens the official DSH UI, whose reconnect behavior and mobile layout are outside plugin control. The WeChat side already wires `sessionController.follow`, `approval/request`, `user-questions/request`, and `userQuestions.answer`, and that pipeline is reusable.

**Approach**: Add `src/mobile-session.ts` mapping `chat.send` to `controller.prompt`, `approval.respond` to the existing approval events, and `status.get` to `sessionController.list`. Add `resume(cursor)` and backpressure to `/mobile/ws`. Add `web/src/chat.ts` for a session list, message stream, and approval cards, keeping an "open full DSH UI" entry.

**Scope**: large (`src/ws.ts`, `src/gateway.ts`, a new module, `web/`).

**Risk**: duplicates the official UI and raises maintenance cost; Quick Tunnel limits and the lack of SSE remain. Start with a small approval/question loop before full chat.

### P2-2 Multiple devices / multiple users

**Problem**: Every device shares one DSH owner identity. `maxDevicesPerUser:10` is only a device count and cannot separate family or colleagues; true multi-user needs DSH non-owner peers and Remote access control.

**Approach**: First implement gateway-side "least privilege per device" (read-only device, approval-only device) through route allowlists without changing the DSH identity. Then evaluate whether DSH's `remoteAccess`/peer model (`@deepseek-ai/dsh-api-remote-access`) can authorize non-owner sessions, and whether `connection`/`sessionController` expose peer identity (**needs verification**). Document the current single-user model.

**Scope**: large (`src/devices.ts`, `src/sessions.ts`, `src/proxy.ts`, `src/gateway.ts`, dependent on DSH).

**Risk**: gateway-side "read-only" cannot cover every DSH API; one missed write endpoint breaks the guarantee. DSH peer support is not stable (**needs verification**), so do not promise multi-user.

### P2-3 Tunnel provider abstraction and a stable entry

**Problem**: `src/tunnel.ts` hard-codes Quick Tunnel process management, URL parsing, and reconnects; Named Tunnel is only a `--token run` placeholder. Long-term self-hosting means hostname churn or your own reverse proxy.

**Approach**: Extract a `TunnelProvider` interface (start/stop/status/publicBase/health) with `quick` and `named` implementations. Add connector health (cloudflared metrics port) and a domain/DNS checklist to Named. Keep `tunnel.enabled:false` plus `gateway.publicUrl` for self-hosted proxies. Evaluate Tailscale/FRP only as third-party providers.

**Scope**: medium (`src/tunnel.ts` split, `src/config.ts`, `docs/configuration.md`).

**Risk**: Named Tunnel needs a real account and domain, so automation can only mock it (**needs verification**). Abstracting too early causes rework; finish two implementations first.

### P2-4 Internationalization and accessibility

**Problem**: Phone pages have inline zh/en dictionaries, while the admin console is zh-CN only (as `docs/admin-console.md` states). `web/src/common.ts` dictionaries and `src/errors.ts` messages are two sources. Pairing pages, modals, and approval cards have no systematic keyboard/screen-reader/contrast check.

**Approach**: Extract a shared word list (`web/src/i18n.ts` or build-time JSON) reused by the admin console. Generate frontend dictionaries from `errors.ts`. Add focus management and `aria-*` to the pairing page, approval cards, and modals. Honor `prefers-reduced-motion`. Record an accessibility checklist in `docs/`.

**Scope**: medium (`web/src/common.ts`, `web/src/admin.ts`, `src/errors.ts`, CSS).

**Risk**: dictionary migration will miss keys; admin translation adds copy-review cost, so start with high-frequency screens.

## Verification checklist

These depend on external DSH or iLink behavior. Validate each with a minimal script before baking it into an implementation assumption:

- ~~Whether Cordis `ctx.get()` sees a service not declared in `inject`, and when.~~ **Resolved**: it does not see sibling-provided services without an `inject` declaration; `ctx.get()` only resolves services mapped into the calling fiber's isolate scope.
- Whether DSH HMR awaits `ctx.effect` async disposers and releases port 3081 immediately.
- Whether iLink `getupdates` `ret=-14` only means "login invalid", or a recoverable token-expiry code exists.
- Whether cloudflared exposes a stable local metrics/connector-health endpoint to replace the Named Tunnel fixed sleep.
- Whether the DSH web profile exposes a non-owner peer identity to plugins (the prerequisite for multi-user).
- A reliable way to read the actual DSH version from inside the plugin (needed by doctor and compatibility notices).

## Acceptance bar

Every item, when implemented, needs three things: an automated test (or a branch in `scripts/integration-check.mjs`), a visible state or error in the admin console, and a runnable note in `docs/`. If any is missing, leave it for later.

## Shipped in 0.1.4 (2026-11-09, version unchanged)

The patch-level items and most of the "next version" items were implemented in one backward-compatible pass (additive fields/endpoints only):

- **P0-1** owner trust boundary (with `allowOtherUsers`/`allowedUsers`, audited legacy migration)
- **P0-2** WeChat channel state machine, context-token lifetime, classified send failures
- **P0-3** automatic pairing-code refresh, tunnel URL-change banner, Named Tunnel metrics `/ready` health
- **P0-4** `auth.oauthAllowedUsers`, `secret-keys.json` multi-key + `/admin/key/rotate`, pairing-code log redaction, `/admin/audit` export
- **P0-5** capability matrix (controller / workspace / userQuestions / weixin) with `userQuestions` probed as optional; the other services stay declared in `inject` (see the P0-5 outcome above)
- **P0-6** `npm run hmr-check` smoke script (skips without dsh)
- **P0-7** route split into `src/routes/*`, asynchronous size-rotated logging
- **P1-1/P1-2**: message dedupe and stray-reply interception, GET exponential backoff with online/offline state, build-time asset hashes (`build.json`), `sw.js` cache versioning, app/shell weak-network states
- **P1-3** `/health?deep=1` per-component readiness
- **P1-4** admin IA: runtime/activity split, WeChat sub-sections, Help tab
- **P1-5** `npm run doctor`, `npm run check-docs`, `scripts/pack.mjs` aligned with `package.json.files`, doc version references fixed
- **P1-6** runtime switches: tunnel/WeChat/log level/proxy timeout read-write at runtime and restored on restart
- **P0-4 follow-up**: cross-restart audit export (in-memory ring + rotated JSONL files)
- **P2-3** Named Tunnel health check and degraded semantics

## Remaining scope

### 0.1.5 (optional patch)

- **P0-4 wrap-up**: IP-only pairing lockout with increasing delay (still `IP|UA`).
- **Log volume**: audit export reads `maxFiles+1` files synchronously; move to streaming.
- **P1-2 wrap-up**: offline queue/outbox (only read retries exist today).

### 0.2.0 (one iteration)

1. **P2-1** full mobile chat/approval UI (watch the official DSH UI on a phone first).
2. **P2-2** multi-user: wait for DSH peer/`remoteAccess` to stabilize in the web profile.
3. **P2-4** full admin English translation: cover pairing, approvals, and error copy first.
4. **P2-3 wrap-up**: evaluate Tailscale/FRP-style third-party providers (not in the core package).

