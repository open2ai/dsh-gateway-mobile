# 架构

[English](./architecture.md) | 中文

## 运行时拓扑

```
┌──────────────┐  HTTPS   ┌────────────────────┐  出站连接   ┌──────────────────────────────┐
│ 手机 (PWA)   │ ───────► │ Cloudflare 边缘    │ ◄────────── │ cloudflared（子进程）        │
└──────────────┘          │ Quick Tunnel       │             └──────────────┬───────────────┘
                          └────────────────────┘                            │ HTTP/WS
                                                                            ▼
                                                          ┌───────────────────────────────────┐
                                                          │ 127.0.0.1:3081                    │
                                                          │ dsh-gateway-mobile                │
                                                          │  ├─ Host/Origin 校验              │
                                                          │  ├─ 会话鉴权 + 限流               │
                                                          │  ├─ /mobile/** PWA + JSON API     │
                                                          │  ├─ /mobile/ws 控制通道           │
                                                          │  └─ 反向代理（HTTP + WS）         │
                                                          └───────────────┬───────────────────┘
                                                                          │ Host=127.0.0.1:3080
                                                                          │ Cookie=<网关持有的 DSH cookie>
                                                                          ▼
                                                          ┌───────────────────────────────────┐
                                                          │ 127.0.0.1:3080  dsh web           │
                                                          │ (owner 会话、工具、审批)          │
                                                          └───────────────────────────────────┘
```

DSH 从不监听公网接口。唯一的公开组件是 Cloudflare Quick Tunnel，它终止在插件的回环
监听器上。

## 模块

| 模块 | 职责 |
|---|---|
| `lib/index.js` | Cordis 入口；构建服务、启动网关、后台启动隧道、注册 disposer |
| `lib/config.js` | 默认值、嵌套合并、校验（回环 host、named 模式 token、OAuth 要求） |
| `lib/tunnel.js` | `cloudflared` 生命周期、URL 解析、重连退避、状态、Named Tunnel 的 metrics `/ready` 健康检查 |
| `lib/cloudflared.js` | 二进制解析（config → env → PATH → cache → download）、SHA-256 校验、版本探测 |
| `lib/pairing.js` | 一次性 8 位配对码、TTL、已用码跟踪、自动生成下一个码、日志脱敏 |
| `lib/sessions.js` | kid 作用域的 HMAC cookie payload、多密钥验签、常量时间比较、过期 |
| `lib/settings.js` | 仅回环访问的持久化管理端覆盖（会话/配对生命周期 + 运行时开关，`admin-settings.json`） |
| `lib/devices.js` | JSON 设备注册表、设备上限、撤销/全部撤销、已撤销/过期记录的永久删除、静默过期、OAuth 绑定、在线 socket 跟踪 |
| `lib/util.js` | MIME 类型、cookie 解析/序列化、UA 指纹、IP/协议辅助函数 |
| `lib/ratelimit.js` | 滑动窗口 API 限流与配对锁定 |
| `lib/proxy.js` | DSH cookie 提供方（通过 `connection.authenticatedUrl` 换取 token）、HTTP 代理、WebSocket 升级代理、请求头重写 |
| `lib/gateway.js` | HTTP 服务器、host/origin 校验、鉴权、静态 PWA、`/mobile/ws`、DSH 代理；分发到路由模块 |
| `lib/routes/*` | 声明式路由模块：public、session、devices、admin（健康/能力/审计/密钥轮换）、weixin、oauth |
| `lib/weixin*.js` | 微信 ClawBot/iLink 通道、owner 信任边界、DSH 桥接、完成通知 |
| `lib/oauth.js` | GitHub/Gitee 授权码流程、state HMAC、用户信息获取、白名单、绑定 |
| `lib/ws.js` | 用于 `/mobile/ws` 的最小 RFC 6455 服务器（text/ping/pong/close） |
| `lib/store.js` | 原子 JSON 文件、AES-256-GCM secret box（kid 作用域多密钥存储与轮换） |
| `lib/logger.js` | 控制台 + 内存环 + 脱敏审计日志、异步按大小轮转的 JSONL、审计查询 |
| `lib/stats.js` | 管理后台用的按天/按设备请求计数（`stats.json`） |
| `lib/errors.js` | 产品错误码与中英文文案 |

## 启动顺序

1. Cordis 在 `dsh-web-app` 之后加载 `gateway-mobile` 行（bundle patch）。
2. `normalizeConfig` 校验；数据目录、密钥、日志、设备存储初始化；持久化的 `admin-settings.json` 覆盖应用到认证生命周期；探测可选的 DSH 服务（`sessionController`、`workspaceRegistry`、`userQuestions`）并记录进能力矩阵。
3. 生成配对码并以脱敏形式（`****-XY`）记录日志；管理页在回环地址上**无需会话**即可访问。
4. 网关监听 `gateway.host:gateway.port`（仅回环）。
5. 若 `tunnel.enabled`，后台运行 `TunnelManager.start()`：解析/下载 cloudflared、启动 Quick/Named Tunnel、解析 URL 或等待 Named 的 metrics `/ready` 探测，发出 `connected`/`degraded`。
6. 隧道 URL 就绪后，管理页展示二维码/配对 URL。
7. 释放时：关闭网关、停止隧道、清理定时器、销毁代理 agent、冲刷日志队列。

## 请求路径

1. **Host 校验**：`Host` 必须是回环（直连）或当前隧道 host / 配置的公开 host，否则 403。
2. **Origin 校验**：若存在 `Origin`，其 authority 必须等于 `Host`；`Sec-Fetch-Site: cross-site` 拒绝。
3. **公开路由**：`/health`、配对状态/验证、OAuth 回调、静态配对页/资源。
4. **会话**：校验 `dsh_session` HMAC，检查设备是否活跃/未撤销/未过期，可选的 OAuth 门槛。
5. **仅本机**：`/mobile/admin`、管理 API、日志额外限制为来自回环**且未经代理**的请求（没有 `cf-*`/`x-forwarded-*`）。
6. **CSRF**：修改型 `/mobile/api/v1/*` 需要 `X-Requested-With: XMLHttpRequest`。
7. **代理**：剥离客户端 cookie，把 `Host`/`Origin` 重写为 DSH 的回环 authority，注入网关持有的 DSH cookie，转发 `X-Forwarded-*`，流式返回响应。
8. **升级**：同样鉴权；DSH 的 `/api/remote.mux` 帧被不透明地管道转发（网关从不解析 DSH 的业务协议）。

## 获取 DSH cookie

`dsh web` 仍由它自己的签名 cookie 鉴权。插件：

1. 调用 `ctx.connection.authenticatedUrl(ctx.webServer.getOrigin() + '/')` 获取带 token 的 URL；
2. 以 `redirect: manual` 请求它；
3. 捕获 `Set-Cookie` 并保存在内存；
4. 把该 cookie 注入代理请求；
5. 上游 GET/HEAD 返回 401 时失效、重新换取一次并重试。

手机永远看不到 DSH 的 cookie。这使网关可以保留自己的设备/会话模型，同时 DSH 的信任
边界与 cookie 受众仍然有效（Host 被重写为回环 authority）。

## 存储

```
$DSH_HOME/gateway-mobile/
├── secret-keys.json # AES-256-GCM/HMAC 密钥，含 kid、active key 与轮换历史（0600）
├── secret.key       # 旧版单密钥；迁移为 k1 并保留以便回滚（0600）
├── devices.json     # 设备注册表（原子重写；已撤销/过期记录可删除）
├── admin-settings.json # 持久化的会话/配对生命周期与运行时开关覆盖（可选）
├── weixin-bot.json  # 加密的微信凭证 + owner 哈希（不落原始 user id）
├── weixin-notify-state.json # 通知策略、队列与最近推送
├── stats.json       # 按天/按设备请求计数
├── gateway.log      # 结构化日志/审计 JSONL（按大小轮转为 .1 … .N）
└── cloudflared/     # 自动下载时缓存的二进制
```

## 故障行为

| 故障 | 行为 |
|---|---|
| cloudflared 缺失/下载失败 | 网关继续在回环运行；隧道状态 `error`；管理端可重试 |
| 隧道断开 | 状态 `reconnecting`；有上限的指数退避直到 `maxRetries`；之后 `error` |
| DSH 3080 不可用 | 代理返回 5xx 与 `PROXY_ERROR`；会话/鉴权不受影响 |
| DSH 重启（cookie 失效） | 首个 GET/HEAD 401 触发 cookie 重新换取并重试一次 |
| 设备被撤销 | 会话以 `3001` 失败；在线 socket 销毁；WebSocket 关闭码 4002；记录保留直到删除 |
| 对活跃设备请求删除/清理 | `4009`；记录与会话保持不变 |
| Host 变化（Quick Tunnel 重启） | 旧 host 请求 403；浏览器 cookie 按 host 隔离 → 需重新配对 |
| 插件被释放 | 关闭服务器、停止隧道、清理定时器 |
