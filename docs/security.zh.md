# 安全说明

[English](./security.md) | 中文

## 资产

| 资产 | 暴露面 |
|---|---|
| 主机 shell（agent 以当前 Windows 用户身份运行） | 网关/会话被窃取即整机失陷 |
| `$DSH_HOME` 凭证与会话日志 | 源代码、密钥、对话历史 |
| DSH 所有者 cookie / 启动令牌 | 完整的所有者 API 访问权限 |
| 手机配对码 / 会话 cookie | 网关访问权，进而可访问 DSH |
| 微信所有者身份（仅加盐哈希） | 可驱动 DSH 会话并回答审批 |
| `secret-keys.json` | 可解密持久化的微信凭证并为会话签名 |
| 审批通道 | 可批准危险命令 |
| OAuth client secret | 提供商账号被滥用（仅主机侧） |

## 信任边界

1. **手机 ↔ Cloudflare 边缘**：公网 TLS；Cloudflare 终止 TLS，可看到明文。这是 Quick Tunnel 的固有特性。
2. **Cloudflare 边缘 ↔ 本地网关**：出站隧道；Cloudflare 向 `127.0.0.1:3081` 发起请求。
3. **网关 ↔ DSH**：回环；网关持有 DSH 的 cookie，并把 Host/Origin 改写成 DSH 的回环 authority。
4. **DSH ↔ 不可信网页/文件内容**：提示词注入边界；网关无法修复，只能减少审批失误。

## 已实现的管控

| 管控 | 位置 |
|---|---|
| 网关仅绑定回环（配置校验） | `config.js` 拒绝非回环 host |
| Host 允许列表（回环、当前隧道 host、配置的公网 host） | `gateway.js#hostInfo` |
| Origin authority 匹配 + `Sec-Fetch-Site` 校验 | `gateway.js#checkOrigin` |
| 一次性配对码（8 位、TTL、单次使用、自动轮换） | `pairing.js` |
| 配对失败锁定（默认 5 次 / 5 分钟） | `ratelimit.js`、`gateway.js` |
| HMAC-SHA256 会话 cookie、常量时间校验、过期 | `sessions.js` |
| 每个请求重新检查设备状态；撤销时关闭 socket | `devices.js`、`gateway.js` |
| 状态变更 API 的 CSRF 请求头 | `gateway.js#assertCsrf` |
| 滑动窗口 API 限流 | `ratelimit.js` |
| 仅本机的管理/日志 API 与管理页面 | `gateway.js#hostInfo` + `#authenticate` 路由检查 |
| 设备记录永久删除仅限回环、仅限已撤销/过期记录、受 CSRF 防护 | `gateway.js` 设备路由 + `devices.js#remove/purgeInactive` |
| Body 大小限制 + JSON 大小限制 | `proxy.js`、`gateway.js#readJson` |
| DSH cookie 仅保留在进程内；客户端 cookie 被剥离 | `proxy.js` |
| 日志/审计脱敏 | `logger.js` |
| 配置中的秘密数据绝不复制到手机 UI | `oauth.js`、`gateway.js` |
| 微信所有者绑定：首个通过审批的账号成为唯一发送者（磁盘上仅加盐哈希） | `weixin.ts`、`weixin-bridge.ts` |
| 微信发送者允许列表（`allowOtherUsers`、`allowedUsers`），并审计被拒绝的发送者 | `weixin.ts` |
| OAuth 身份允许列表（`auth.oauthAllowedUsers`） | `oauth.ts` |
| 按 kid 区分的 AES-256-GCM/HMAC 密钥，支持轮换与五把密钥的保留窗口 | `store.ts`、`sessions.ts` |
| 日志与审计中的配对码脱敏（`****-XY`） | `pairing.ts`、`index.ts` |
| 过滤后的审计导出（仅回环） | `logger.ts`、`routes/admin.ts` |
| 本地管理后台初始化（无会话）仅限回环 + 非代理请求 | `gateway.js#authenticate` |

## 配对与会话生命周期

```
admin page (loopback) ──pairing code/QR──► phone
phone ──POST pairing/verify──► gateway
  ├─ consume code (single use, TTL)
  ├─ register device (max devices, name/UA/IP)
  └─ issue dsh_session (HMAC; 24h default)
phone ──cookie──► gateway ──deviceActive?──► proxy/authz
revoke ──► device.revoked, sockets closed, next request 3001
admin (loopback) ──► delete/purge ──► record removed from devices.json
```

已撤销的记录会保留，以维持审计轨迹与设备列表的完整性；它们只能从回环管理后台被**永久**删除（`DELETE /devices/{id}` 或 `POST /devices/purge`），并且 API 拒绝删除仍处于活动状态的设备（`4009`）。

DSH 所有者 cookie **不**在这条链路中。丢失手机只会暴露该设备的网关会话；撤销该设备即可使其失效。DSH 所有者仍可通过删除 `client-connection/browser-session` 并重启 DSH 来全局撤销。

## Quick Tunnel 特有风险

- Cloudflare 可看到明文（聊天、命令、文件）。不要用于必须对 Cloudflare 保密的内容；改用自建边缘的 Named Tunnel 或私有网络。
- 主机名在重启后会变化。浏览器 cookie 按 host 隔离，因此手机必须重新配对；原生 shell 可以跨 host 持久化设备令牌。
- 不支持 SSE：DSH 的 `/plugins/events` HMR 流会降级；首次页面加载仍可通过注入的 boot graph 完成。
- 无 SLA、200 个在途请求；Cloudflare 可能限流。
- 这是测试/开发设施，不是生产级暴露机制。

## 微信发送者信任边界

批准扫码登录会将该微信账号记录为通道**所有者**：持久化的是加盐 SHA-256 哈希加脱敏标签，原始 `ilink_user_id` 只保留在内存中。每条入站消息在到达 DSH 前都会校验：

- 所有者被接受；
- 其他发送者默认被拒绝（记录审计，并一次性告知此 Bot 为私有）；
- `weixin.allowOtherUsers` 开放 Bot；`weixin.allowedUsers` 增加特定的哈希 ID。

在此边界之前创建的旧凭证采用首次使用即信任（trust-on-first-use）：升级后的第一条入站消息将成为所有者，迁移过程会记录审计。升级后请立即用你真正拥有的手机/账号发送一条消息；否则，任何在你之前就能给 Bot 发消息的人都可能抢占它。完成通知只发送到所有者的 context token，且 context 在 30 分钟无活动后过期。

## 密钥轮换

`<dataDir>/secret-keys.json` 最多保存五把 AES-256-GCM/HMAC 密钥，每把都有稳定 ID（`kid`）。会话 cookie 与加密的微信凭证会内嵌生成它们的 kid，因此在保留窗口期内旧 cookie 与旧密文仍可验证，新数据使用活动密钥。轮换（`POST /admin/key/rotate`）仅限回环且受 CSRF 防护；它**不会**使现有会话失效。旧 `secret.key` 文件会迁移为 `k1` 并原样保留以便回滚；轮换前请备份 `secret-keys.json`。

## 无会话的本地管理后台

首次运行流程在任何设备存在之前就需要配对二维码。因此管理页面和 `/admin/*` API 可在无会话的情况下**仅从回环**访问。这是有意为之的本地信任决策：任何能访问回环的本地进程本来就能读取 DSH 凭证和配置文件。经由隧道的请求始终携带公网 Host，且带有 `cf-*`/`x-forwarded-*` 请求头的请求绝不会被视为本地请求。

## Agent 执行安全

- 网关不会绕过 DSH 审批或沙箱预设。
- 审批提示由官方 DSH UI 渲染；网关只做代理。
- 对高风险工作，将会话设为 `read-only`/`workspace-write`，仅在刻意操作时使用 `danger-full-access`。
- 提示词注入仍是最大的残余风险；手机会话优先使用专用工作区，并在批准前审查命令。

## 运维检查清单

- [ ] `gateway.host` 保持为 `127.0.0.1`。
- [ ] `auth.requireOAuth` 的决定是刻意的；仅在确实使用时配置 OAuth secret。
- [ ] 通过可信渠道传递配对码（在你自己屏幕上的二维码）。
- [ ] 不使用时停止 Quick Tunnel（`/mobile/admin`）。
- [ ] 检查设备列表；撤销未知/旧设备，删除过期的已撤销记录。
- [ ] 固定 `cloudflared` 版本/哈希（`tunnel.binaryPath`/`tunnel.sha256`）。
- [ ] 检查日志中是否有反复的配对失败（`4001`/`4002`）。
- [ ] DSH 审批/沙箱设置适合手机使用。
- [ ] 如果无法接受 Cloudflare 可见性，改用 Named Tunnel/私有网络。

## 残余风险

- Cloudflare 边缘可见性（内容与元数据）。
- 手机失陷 / 手机未锁屏且会话仍活动。
- OAuth 提供商失陷或回调 URI 配置错误（Gitee 要求逐字节一致）。
- Quick Tunnel 可用性与主机名漂移。
- 本地用户/进程失陷时 JSON 设备存储的完整性。
