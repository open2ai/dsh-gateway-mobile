# 已知限制

[English](./limitations.md) | 中文

- **Quick Tunnel**：无 SLA，每次重启域名随机（浏览器 cookie 按 host 隔离，因此手机必须重新
  配对），200 个在途请求上限，不支持 SSE（`/plugins/events` 的 HMR 会退化），且 Cloudflare
  可以看到明文。管理后台现在会提示 hostname 变化（`previousUrl`/`urlChangedAt`）并自动刷新
  过期的配对码，但手机仍需重新配对。
- **Named Tunnel 健康检查**：cloudflared 以回环 metrics 监听器启动，其 `/ready` 端点最多
  轮询 20 秒；各 cloudflared 版本的 `/ready` 语义**需要验证**，端口冲突只能通过
  `tunnel.metricsPort` 解决。
- **微信 owner 迁移**：对 0.1.4 之前创建的凭证是 trust-on-first-use——升级后第一条入站消息
  会成为 owner。
- **审计导出**：合并内存环与 JSONL 日志及其轮转文件，覆盖跨重启的保留窗口
  （`log.maxFiles` × `log.maxBytes`）；比轮转文件更早的条目会丢失。
- **弱网**：PWA 页面由 service worker 缓存，但 API/WebSocket 流量从不缓存；GET 请求带指数
  退避重试，UI 会显示离线/上次同步状态。目前还没有离线聊天或排队 prompt。
- 手机端 UI 是官方 DSH Web UI 加网关页面；专用的手机聊天 UI 暂缓。
- 自定义 `/mobile/ws` 聊天协议仍是骨架（chat、审批与文件消息返回 `NOT_SUPPORTED`）。
- Quick Tunnel hostname 变化时必须更新 OAuth 回调 URL；需要稳定 OAuth 时请使用 Named
  Tunnel 或 `gateway.publicUrl`。
- 设备存储是 JSON（单用户、原子重写），不是 SQLite；已撤销/过期记录会保留在
  `devices.json`，直到在管理后台删除或清理，且不计入活跃设备上限。
- 只有在配置了 `tunnel.sha256`（或已知哈希）时才会固定 cloudflared 的哈希。
- 手机 PWA 页面由 service worker 缓存 app shell；资源 URL 带 `?v=` 查询参数，缓存名随构建
  版本自动变化，无需手工 bump（见 [development.zh.md](./development.zh.md)）。

与原始产品文档的差异见 [deviations.zh.md](./deviations.zh.md)。
