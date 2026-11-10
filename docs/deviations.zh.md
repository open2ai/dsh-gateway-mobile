# 与 `pre_docs1`（v2.0）的偏差

[English](./deviations.md) | 中文

实现遵循产品意图，但源文档假设的是另一代 DSH，并且包含与 DSH `0.2.2-rc.1` 不匹配的 API 草案。本文件记录所有实质性适配，以免后续维护者把代码“修”回文档的样子。

## 平台 / 插件 API

| 文档假设 | DSH 0.2.2-rc.1 中的实际情况 | 实现 |
|---|---|---|
| `require('cordis')`、`exports.*`、`exports.Config`、`ctx.plugin.config` | DSH 是 ESM + Cordis 4；插件导出 `name`、`inject`、`apply(ctx, config)` | `lib/index.js` 使用 ESM 导出；config 是 `apply` 的第二个参数 |
| `inject: { db: true, i18n: true }` | 基础 web profile 中没有 `db`/`i18n` 服务 | `inject = ['webServer', 'connection']`；不使用 DB/i18n 服务 |
| `ctx.get('dsh/session')`、`ctx.get('apiproxy')` | 不属于随附的 web profile | 未使用；网关对协议保持透明 |
| `ctx.get('webserver')` / `apiProxy.serveStatic` | 服务是 `ctx.webServer`；静态文件服务由 `dsh-host-frontend-static` 负责 | 网关是 3091 上的**旁路 HTTP server**，自行提供 `/mobile` 页面 |
| `ctx.on('dsh/session-created')`、`approval-requested` | 基础 web profile 中没有这类 Cordis 事件 | 推迟；审批仍以官方 DSH UI 为准 |
| DSH `>=1.5.0`；`cordis.patch.yml` 新 API | 实际安装/验证的是 `0.2.2-rc.1` | `engines.dsh: 0.2.2-rc.1`；bundle patch 使用当前 loader |
| `package.json` `peerDependencies.dsh` | `dsh` 不是包名；CLI 是 `@deepseek-ai/dsh` | 仅使用 `engines.dsh` 范围 |

## Cookie / 认证

| 文档 | 实现 | 原因 |
|---|---|---|
| 会话 cookie `Path=/mobile` | `Path=/` | cookie 认证的是**被代理的 DSH 路由**（`/`、`/api`、`/plugins`），而不只是 `/mobile` |
| 会话 cookie 24h | 默认 86400s（可配置） | 符合 FR-04；旧配置示例中的 30 天可通过 `auth.sessionMaxAge` 获得 |
| HMAC payload base64 JSON | base64url + `.` + HMAC-SHA256，常量时间比较 | 等价格式，解析更严格 |
| 配对令牌 15 分钟 | 默认 900s | 相同 |
| 密钥使用 AES-256-GCM | `secret.key` + AES-256-GCM 辅助类（`SecretBox`）用于持久化的密文；会话使用 HMAC | 目前不持久化任何敏感配置 |
| 配对码 8 位数字/字母 | 从无歧义字母表取 8 个字符（`A-Z2-9` 去掉 I/O/0/1），显示为 `XXXX-XXXX` | 易用 + 减少输错 |
| 管理 API 仅限回环 | 回环**且非代理**；管理页面 + `/admin/*` 和 `/logs` 在首次运行时无需会话 | 首次运行的二维码需要在任何设备存在前可见 |

## 手机 UI / 协议

| 文档 | 实现 | 状态 |
|---|---|---|
| 独立的 `/mobile` 会话列表/聊天/审批 UI | PWA 外壳，通过已认证的代理打开官方 DSH Web UI；`/mobile` 包含配对/状态/设备/OAuth/管理页面 | **推迟**（见 `lib/gateway.js` `/mobile/ws`） |
| 自定义 WebSocket 协议（`chat.send`、`chat.delta`、`approval.request`、文件分块） | `/mobile/ws` 实现握手/认证/`ping`/`status.get`；聊天/审批/文件类型返回 `1008` | **推迟** |
| `GET /sessions`、`GET /models`、`POST /sessions/{id}/continue`、模型切换 | 返回 `1008 NOT_SUPPORTED` 并提示使用 DSH UI | **推迟**；DSH 内部的 Remote API 与版本强相关，不是稳定的 REST 接口 |
| SSE 流式支持 | DSH 不需要（它使用 WS mux）。Quick Tunnel 本就不支持 SSE | 说明 |
| 30s WS 心跳 | `/mobile/ws` 心跳可配置（默认 30s）；DSH 自身的 mux 心跳为 2s，被透明代理 | 已实现 |
| PWA 安装 | Manifest + service worker + 图标 | 已实现（基础） |
| zh/en i18n | `web/src/common.ts` 与 `lib/errors.js` 中的内联词典；API 错误使用 `Accept-Language` | 已实现 |
| 服务端渲染 | 静态 HTML 页面（无 SSR） | 偏差；页面很小，但浏览器资源通过 esbuild 从 TypeScript 构建 |

## 隧道

| 文档 | 实现 | 备注 |
|---|---|---|
| 自动下载 cloudflared、SHA-256 校验、缓存 | 解析顺序：配置 → `CLOUDFLARED_PATH` → PATH → 缓存 → 下载（固定版本 `2026.10.3`）。仅当设置了 `tunnel.sha256`（或已知哈希）时才强制哈希校验；否则记录观测到的哈希并告警 | 发布产物中没有官方的 `.sha256` 资产；生产环境请通过配置固定 |
| 强制 HTTP/2 | 默认 `--protocol http2` | 可配置为 `quic` |
| 重连最多 10 次 | 封顶指数退避，最多 10 次，之后进入 `error` | 已实现 |
| URL 变化时通知已配对设备 | 日志 + 在 `/mobile/ws` 广播状态；手机必须重新配对，因为 cookie 按 host 隔离 | 部分实现 |
| Named Tunnel v0.4 | 基础的 `mode: named` + token/domain 支持 | 占位；未被测试覆盖 |

## TLS 上游

当证书为自签名或 Node 不信任时，`dsh web --tls-cert/--tls-key`（HTTPS 监听器）不受内部 cookie 交换或代理 agent 支持。请让 DSH 保持纯 HTTP 回环，由 Cloudflare 终止 TLS（默认），或提供受信任的证书并把 `proxy.upstream` 指向 `https://…`。这是当前限制，不是静默回退。

## 存储 / 基础设施

| 文档 | 实现 |
|---|---|
| 设备使用数据库/ORM | 使用 JSON 存储并原子重写（`devices.json`） |
| 平台钥匙串 / DPAPI | 随机密钥文件 `0600` + AES-GCM 辅助类；Windows ACL 由操作系统负责 |
| `dist/` 构建 + zip | TypeScript 服务端编译（`tsc`）+ 浏览器打包（`esbuild`）；`scripts/pack.mjs` 生成 zip/tarball |
| CI 工作流 | 未包含；`npm test` 与 `scripts/integration-check.mjs` 是准入门槛 |

## 需求状态

| FR | 状态 |
|---|---|
| FR-01 内置 HTTP/WS 网关、请求头纠正、统一认证 | ✅ |
| FR-02 Quick Tunnel、HTTP/2、重连、状态、启停、管理后台二维码 | ✅（Named Tunnel 为基础支持） |
| FR-03 手机专用 UI、PWA | 🔶 PWA 页面 + `/mobile/shell` 全屏官方 DSH UI；专用聊天/会话 UI 推迟 |
| FR-04 一次性配对、二维码/fragment、cookie、设备名 | ✅ |
| FR-05 GitHub/Gitee OAuth、最小 scope、可选要求、解绑 | ✅（需要真实提供商凭证才能演练） |
| FR-06 设备列表/撤销/全部撤销/过期/永久删除记录 | ✅ |
| FR-07 失败关闭（fail-closed）、限流、Host/Origin、本地管理隔离、加密存储 | ✅（AES 辅助类；不持久化 OAuth secret） |
| FR-08 状态/日志/token 统计/更新提醒 | 🔶 状态/日志 + 按天/按设备请求统计；token 用量聚合与更新提醒推迟 |
