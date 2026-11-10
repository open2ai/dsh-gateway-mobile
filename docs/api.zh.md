# API

[English](./api.md) | 中文

基础路径：`/mobile/api/v1`。所有 JSON 响应均采用：

```json
{ "code": 0, "message": "success", "data": {} }
```

- `code`：产品错误码（`0` 表示成功）。
- `message`：本地化文案（默认中文，可通过 `Accept-Language` 请求英文）。
- `data`：由端点决定；错误响应可能包含 `retryAfter`、`remainingAttempts`。

改变状态的请求（`POST`/`PUT`/`PATCH`/`DELETE`）需要携带
`X-Requested-With: XMLHttpRequest`（公开的配对端点除外，配对页面本来就会发送该请求头）。

已认证的 API 响应会带上 `X-RateLimit-Limit`/`X-RateLimit-Remaining`；被限流的响应还会附加
`Retry-After`。

## 错误码

| 错误码 | 名称 | HTTP | 含义 |
|---|---|---|---|
| 0 | success | 200 | 成功 |
| 1001 | invalid_params | 400/413/415 | 参数错误/缺失/过大/内容类型不正确 |
| 1002 | invalid_pairing_code | 400 | 不是 8 位字母数字 |
| 1003 | invalid_device_id | 400 | 未知或格式错误的设备 ID |
| 1004 | invalid_oauth_state | 400 | OAuth state 不匹配/已过期 |
| 1005 | invalid_confirm_text | 400 | `REVOKE ALL` / `DELETE REVOKED` 不匹配 |
| 1006 | device_limit_reached | 403 | 达到 `maxDevicesPerUser` 上限 |
| 1007 | csrf_failed | 403 | 缺少 `X-Requested-With` |
| 1008 | not_supported | 501 | 功能暂缓（sessions/models、聊天 WebSocket） |
| 2001 | unauthenticated | 401 | 无会话 cookie |
| 2002 | session_expired | 401 | cookie 已过期 |
| 2003 | session_invalid | 401 | 签名/载荷错误 |
| 2004 | pairing_token_expired | 410 | TTL 到期 |
| 2005 | pairing_token_used | 409 | 配对码已被使用 |
| 3001 | device_revoked | 403 | 设备已撤销 |
| 3002 | device_expired | 403 | 静默过期 |
| 3003 | permission_denied | 403 | 远程设备访问了管理/本地 API |
| 3004 | oauth_required | 403 | 启用了 `requireOAuth` 但未绑定 |
| 4001 | rate_limited | 429 | 超出 API 窗口限制或配对锁定 |
| 4002 | pairing_failed | 400 | 配对码错误 |
| 4003 | oauth_callback_error | 400 | 提供商返回错误 |
| 4004 | oauth_token_exchange_failed | 400 | code→token 交换失败 |
| 4005 | oauth_user_info_failed | 400 | 获取用户信息失败 |
| 4006 | redirect_uri_mismatch | 400 | 回调 URI 不匹配（Gitee 要求逐字节一致） |
| 4007 | tunnel_not_connected | 503 | 无隧道且代理无法连接 DSH |
| 4008 | oauth_not_configured | 400 | 提供商未配置客户端凭据 |
| 4009 | device_not_deletable | 409 | 设备仍处于活动状态；请先撤销再删除记录 |
| 4010 | oauth_not_allowed | 403 | OAuth 身份不在 `auth.oauthAllowedUsers` 中 |
| 5001 | internal_error | 500 | 未处理异常 |
| 5002 | tunnel_start_failed | 500 | cloudflared 启动失败 |
| 5003 | proxy_error | 502/504 | 上游错误/超时 |
| 5004 | storage_error | 500 | 预留 |
| 5005 | cloudflared_download_failed | 500 | 下载/哈希校验/执行失败 |

## 端点

### 健康检查

`GET /health`（公开），也可通过 `/mobile/api/v1/health` 访问：

```json
{ "code": 0, "data": { "ok": true, "version": "0.1.4", "time": "2026-10-24T07:00:00.000Z" } }
```

`GET /health?deep=1`（也可用 `/mobile/api/v1/admin/health`，仅回环）返回各组件就绪状态，
必需组件不可用时返回 503：

```json
{ "code": 0, "data": {
  "ok": true, "version": "0.1.4", "startedAt": "…", "uptime": 42, "serverTime": "…",
  "checks": [
    { "name": "gateway", "ok": true, "data": { "port": 3091 } },
    { "name": "storage", "ok": true, "data": { "dataDir": "…" } },
    { "name": "dsh-upstream", "ok": true, "detail": "HTTP 401", "data": { "origin": "http://127.0.0.1:3080" } },
    { "name": "tunnel", "ok": true, "optional": true, "detail": "connected" },
    { "name": "weixin", "ok": true, "optional": true, "detail": "connected" },
    { "name": "capabilities", "ok": true, "optional": true, "data": { "controller": true } }
  ]
} }
```

`optional: true` 的检查只上报，不影响整体 `ok`；隧道启用时隧道检查为必需项。

### 配对

`GET /pairing/status`（公开）

```json
{ "code": 0, "data": { "valid": true, "expiresIn": 872, "used": false } }
```

`POST /pairing/verify`（公开，限流）

```json
{ "pairingToken": "KR4ZAJF9", "deviceName": "我的手机" }
```

成功后会设置 `dsh_session` cookie（`Path=/`、`HttpOnly`、`SameSite=Strict`，隧道上启用
`Secure`）并返回：

```json
{ "code": 0, "data": { "deviceId": "dev_…", "expiresAt": "…", "requireOAuth": false, "oauthProviders": ["github"] } }
```

错误：`1002`、`2004`、`2005`、`4001`（锁定，带 `retryAfter`）、`4002`。

<a id="local-admin-loopback-only-no-session-required"></a>
### 本地管理（仅回环，无需会话）

`GET /admin/pairing`

```json
{ "code": 0, "data": {
  "code": "KR4Z-AJF9", "codeRaw": "KR4ZAJF9", "expiresIn": 872,
  "expiresAt": "…", "pairingUrl": "https://…/mobile/pair#pairing=KR4ZAJF9",
  "qrSvg": "<svg…>", "tunnel": { "state": "connected", "url": "https://…" },
  "status": { "valid": true, "expiresIn": 872, "used": false },
  "previousUrl": "", "urlChangedAt": 0
} }
```

当重连导致公网基础 URL 变化（Quick Tunnel 主机名变化）时会设置
`previousUrl`/`urlChangedAt`；管理后台会为它们显示常驻的“重新配对”横幅。

`POST /admin/pairing/regenerate` — 生成新的配对码/二维码。

`GET /admin/capabilities`（仅回环）— 已解析到的可选 DSH 服务：

```json
{ "code": 0, "data": {
  "controller": true, "workspaceRegistry": true, "userQuestions": true,
  "weixin": true, "tunnel": { "enabled": true, "mode": "quick" }
} }
```

`GET /admin/audit?action=&since=&limit=`（仅回环）— 过滤后的审计记录。`action` 为事件名的
大小写不敏感前缀（如 `pairing` 会匹配 `pairing.issued` 和 `pairing.consumed`），
`since` 接受 epoch 毫秒或 ISO 时间戳，`limit` 默认为 100（最大 500）：

```json
{ "code": 0, "data": { "entries": [ { "timestamp": "…", "level": "audit", "message": "pairing.consumed" } ], "total": 1 } }
```

`POST /admin/key/rotate`（仅回环，CSRF）— 轮换 AES/HMAC 密钥：

```json
{ "code": 0, "data": { "rotated": true, "activeKid": "k2", "keyIds": ["k2", "k1"], "sessionsInvalidated": 0 } }
```

最多保留最新的五个密钥；现有会话与已存储密文继续可用。

`POST /admin/tunnel/start|stop|restart` — 返回隧道状态。

`GET /logs?limit=50` — 最近的日志条目。

`GET /admin/stats?days=7` — 按天/按设备的请求计数。

`GET /admin/settings` — 生效的认证有效期与运行时开关：

```json
{ "code": 0, "data": {
  "sessionMaxAge": 86400, "pairingTokenExpiry": 900,
  "limits": { "sessionMin": 300, "sessionMax": 7776000, "pairingMin": 30, "pairingMax": 86400 },
  "runtime": { "tunnelEnabled": true, "weixinEnabled": true, "logLevel": "info", "proxyRequestTimeoutMs": 0 },
  "restartRequired": []
} }
```

`POST /admin/settings` — 运行时更新，持久化到 `<dataDir>/admin-settings.json`：

```json
{ "sessionMaxAge": 604800, "tunnelEnabled": false, "logLevel": "debug", "proxyRequestTimeoutMs": 15000 }
```

所有字段均为可选且可混合；取值必须合法（日志级别为 debug/info/warn/error 之一；代理超时为
0…3600000 ms）。返回更新后的设置。修改配对 TTL 会签发新的配对码；隧道/微信开关会立即启动或
停止对应进程。仅限本地/回环；无需重启。

`GET /admin/audit?action=&since=&limit=` 也会读取轮换后的 JSONL 文件，因此会返回更早进程写入的
条目（最多 `log.maxFiles` 次轮换）。

### 会话

`POST /session/refresh` — 轮换 `dsh_session` cookie（同一设备）并返回新的过期时间。

`GET /me`

```json
{ "code": 0, "data": {
  "device": { "deviceId": "dev_…", "deviceName": "…", "isOnline": true, "oauthBindings": [] },
  "requireOAuth": false, "oauthProviders": ["github"], "publicBase": "https://…"
} }
```

`GET /status` — 网关/隧道/代理/活动设备/统计信息，另含 `capabilities`；微信通道挂载时还包含
`weixin`/`notifier`（通过会话认证时再加当前设备）。

`POST /logout` — 清除 cookie（设备记录保留）。

### 设备

`GET /devices` — 会话认证：仅当前设备；回环：全部；`?all=1` 包含已撤销和已过期的记录。

`PATCH /devices/{deviceId}` — 请求体 `{"deviceName":"…"}`；本人或回环。

`POST /devices/{deviceId}/revoke` — 本人或回环；关闭 socket，下一次请求返回 `3001`。

`POST /devices/revoke-all`（仅回环）— 请求体 `{"confirmText":"REVOKE ALL"}`。

`DELETE /devices/{deviceId}`（仅回环）— 永久删除已撤销/已过期的设备记录；设备仍处于活动状态时返回 `4009`。

`POST /devices/purge`（仅回环）— 永久删除所有已撤销/已过期的记录；请求体 `{"confirmText":"DELETE REVOKED"}` → `{ "deleted": n }`。

### OAuth（可选）

`GET /oauth/providers` → `{ providers: ["github"] }`

`GET /oauth/authorize?provider=github&deviceId=dev_…` → `{ authorizeUrl }`

`POST /oauth/callback`（请求体 `{provider, code, state}`）→ 绑定摘要。

`POST /oauth/unbind`（请求体 `{provider}`）。

`GET /auth/{provider}/callback` — 浏览器弹窗端点；交换 code、绑定设备，并返回一个小 HTML 页面，
该页面向 opener 发送 `{type:'dsh-oauth', ok}`。

### 微信管理（仅回环）

`GET /admin/weixin` — 通道状态以及通知状态：

```json
{ "code": 0, "data": {
  "enabled": true, "connected": true, "state": "connected", "accountId": "…",
  "cursor": "…", "received": 12, "lastPollAt": 1762750000000, "lastOkAt": 1762750000000,
  "failures": 0, "contextAgeMs": 5400, "allowOtherUsers": false,
  "owner": { "masked": "wxid_ab***cd", "boundAt": 1762740000000 },
  "notify": { "enabled": true, "debounceMs": 5000, "perSessionIntervalMs": 60000,
              "globalIntervalMs": 15000, "maxPerHour": 30 }
} }
```

`state` 取值为 `disabled | idle | connecting | connected | degraded | expired`；轮询连续出现 `-14`
失败会把通道标记为 `expired`，需要重新扫码登录。`owner` 是审批时记录的、与哈希绑定的脱敏身份；
原始微信用户 ID 永不落盘。

`POST /admin/weixin/login`、`GET /admin/weixin/login`、`POST /admin/weixin/approve`、
`POST /admin/weixin/logout` — 扫码登录生命周期。

`GET|POST /admin/weixin/notify` — 通知策略。

`GET /admin/weixin/approvals` — 最近的审批历史。

### 暂缓功能

`GET /sessions` 与 `GET /models` 返回 `1008`，并提示使用内嵌的 DSH UI。

## WebSocket `/mobile/ws`

- 握手需要 `dsh_session` cookie；失败会以 **4001** 关闭。
- 子协议：请求时使用 `dsh-mobile-v1`。
- 服务端会发送 `ready` 消息：

```json
{ "type": "ready", "payload": { "protocolVersion": 1, "deviceId": "dev_…", "gatewayVersion": "0.1.4", "publicBase": "…", "tunnel": {} } }
```

- 支持的上行类型：`ping` → `pong`；`status.get` → `gateway.status`。
- `chat.send`、`chat.stop`、`approval.respond`、`file.upload` 会返回 `error` 消息，错误码
  `1008`（该网关未实现聊天协议）。
- 未知类型以 **4003** 关闭；已撤销设备以 **4002** 关闭；服务端关闭以 **1001** 关闭。

## 网关页面

`/mobile/pair`、`/mobile/`（首页）、`/mobile/devices`、`/mobile/oauth`、`/mobile/admin`（仅回环）、
`/mobile/shell`（官方 DSH UI 的全屏同源 iframe）。

## DSH 代理

所有非 `/mobile/**`、非 `/auth/**` 的请求都会在认证后走代理，包括 `/api`、`/api/remote.mux`、
`/plugins/**` 以及 SPA。该代理对协议透明：它从不解析 DSH 的 Remote 帧。
