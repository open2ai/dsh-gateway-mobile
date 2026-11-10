# dsh-gateway-mobile 现有能力与可复用接口盘点

> 目的：为“把插件独立监控台（`/mobile/admin`）集成成 DSH Web UI 内的工作台”提供**插件侧事实基线**。本文只做只读分析，不包含产品代码改动。
>
> - 仓库：`F:\ai_workspace\dsh-gateway-mobile`，分支 `next`，HEAD `8783645`（工作树干净）。
> - 运行时实测：DSH `0.2.2-rc.1`（web profile，3080），插件 `0.1.4`（网关 3091，正在运行，隧道 connected）。
> - 分析日期：2026-11-10。对照资料：`docs/`（security / roadmap / admin-console / DETAIL / deviations / mobile-workspace / development / api）、`src/`、`web/`、`scripts/`、`test/`、本机已安装 DSH 包。
> - 证据写法：`path:line`。行号以当前 HEAD 为准。

---

## 0. 执行摘要（给决策者）

1. **管理台实际上有 7 个 tab，不是 6 个**（0.1.4 新增“帮助”）：概览、配对、微信、设备、日志、设置、帮助（`web/admin.html:46-54`、`web/admin.html:694-702`、`web/src/admin.ts:6`）。`docs/roadmap.zh.md:100` 的“6 个 tab”是 P1-4 落地前的描述，0.1.4 已按该条实现“帮助”tab（`docs/roadmap.zh.md:177`）。
2. **现有管理台与全部管理 API 都是“仅回环且非代理”**：判定依据是 `Host` 头（不是 socket 对端）+ 是否出现 `cf-*`/`x-forwarded-*` 代理头，`local = loopback && !proxied`（`src/gateway.ts:656-673`、`src/util.ts:176-195`、`src/gateway.ts:860-918`）；远端设备访问 `/mobile/admin` 直接 404（`src/gateway.ts:1100-1108`）。
3. **最危险的集成陷阱**：如果 DSH 宿主侧“把请求转发到 `127.0.0.1:3091`”，这一跳在网关看来是**纯回环、无代理头**，会被当成 `local`，等于把管理权限交给了任何能触发这条桥接的 DSH UI 使用者——包括经隧道打开同一 DSH UI 的手机。方案设计必须先解决“宿主桥接如何自证不是本地管理员”的问题（见 §5.5）。
4. **推荐方案：`b'` 同进程宿主路由 + 轻量服务门面（不是 HTTP 桥接，也不是重写 gateway.ts）**。网关插件与工作台宿主半侧本来就运行在同一个 DSH 宿主进程中（`src/index.ts:98-302` 直接持有 `Gateway` 实例）；`Gateway` 已把能力暴露为清晰方法（`statusPayload`、`pairingPayload`、`buildHealth`、`updateRuntimeSettings`、`tunnel`、`weixin*`、`devices`、`logger.queryAudit`……），路由模块只是薄封装（`src/routes/*.ts`，共 34 条已认证路由 + 7 条公共路由）。新增 `src/workbench/*` 做门面 + 宿主路由即可，**不需要重构 1442 行的 gateway.ts**（顺带修正：`docs/roadmap.zh.md:70` 说“1372 行”，当前实际 `src/gateway.ts` 为 1442 行）。
5. **跨源 fetch（方案 c）不可行**：网关的 `Origin` 必须与 `Host` 完全一致（`src/gateway.ts:675-688`），`Sec-Fetch-Site: cross-site` 直接拒绝；CORS 默认白名单为空（`src/gateway.ts:771-780`、`src/config.ts:158`）；会话 cookie `SameSite=Strict`（`src/gateway.ts:703-714`）；手机侧 `127.0.0.1:3091` 根本不可达。放宽这些限制等于打开 CSRF/本地管理暴露面。
6. **手机场景按“只读工作台”设计最稳**：手机经网关打开 DSH UI 时，网关会向 DSH 上游注入 `x-forwarded-for`/`x-real-ip`/`x-forwarded-proto`/`x-forwarded-host`（`src/proxy.ts:183-206`），并把客户端 cookie 替换成网关持有的 DSH owner cookie（`src/proxy.ts:188-195`）。网关与工作台宿主在同一进程，最可靠的做法是让网关在代理 `/gateway-mobile/*` 时附加**进程内 HMAC 设备标记头**，DSH 侧路由校验该标记并把请求降级为只读；本机直连（无标记）才允许管理写操作。
7. **必须继续 loopback-only 的能力**（有既有文档结论 + 代码证据）：配对码/二维码与重新生成、隧道启停/重启、微信扫码登录/审批/换绑/登出、密钥轮换、认证与运行时设置写入、审计导出、全部日志、设备永久删除/清空、设备全量列表。依据：`docs/security.zh.md:38,50,93`、`docs/roadmap.zh.md:100`、`docs/DETAIL.zh.md:28`、`docs/admin-console.zh.md:6`。
8. **可给已配对设备的能力**已经存在且边界清晰：`/mobile/api/v1/me`、`/status`、`/session/refresh`、`/logout`、自身设备的重命名/撤销、OAuth 绑定、以及经代理访问 DSH UI 本身（`src/routes/session.ts:10-60`、`src/routes/devices.ts:12-87`、`src/gateway.ts:834-851`）。工作台**不应新增**手机端远程能力。
9. **前端要新增 React 客户端半侧，构建需要“第二条产线”**：现有 `scripts/build-web.mjs:10-23` 只产出 ESM 浏览器包（`format:'esm'`、无 external、无 React）。DSH 客户端 bundle 的格式是 `window.__ModuleLoader__.load({ id, factory: (require) => { ... } })`（本机已安装的 `@deepseek-ai/dsh-experimental-client-ui-stats/lib/client.js:1-3`、`@deepseek-ai/dsh-client-ui-directory-picker-browse/lib/client.js:1-3`），因此新增 `scripts/build-client.mjs`：esbuild `format:'cjs'` + `external` 共享模块 + CJS 包裹，**不要动 build-web.mjs**。React 对齐 DSH 自带的 `react ^18.2.0`（上述包 `devDependencies`），React 必须 external、不打包。
10. **版本号**：`package.json` 与 git 历史一致，当前就是 `0.1.4`（`package.json:3`；`e7535e6` 把 `0.1.3→0.1.4`；`8783645` 是**同版本内**继续硬化，未再 bump；`CHANGELOG.zh.md:7` 明确“本版本不升版本号”）。但 `dist/dsh-gateway-mobile-0.1.4.zip` 是 `8783645` 之前构建的（详见 §8.1），**同版本号重打包会产生不同内容**。本次工作台是新增能力 + 新增客户端半侧，建议 `0.2.0-next.0`；若维持 `0.1.4` 会污染已存在的 0.1.4 分发物。注意 `npm run check-docs` 的版本正则目前只接受 `X.Y.Z`，预发布号需要同步改脚本（见 §8.4）。

---

## 1. 现状总览

### 1.1 运行时拓扑（实测 + 文档）

```
手机浏览器 ──HTTPS──> Cloudflare 边缘 ──出站隧道──> cloudflared 子进程
                                                     │ HTTP/WS
                                                     ▼
                                    ┌──────────────────────────────────┐
                                    │ 127.0.0.1:3091  Gateway          │
                                    │ Host/Origin 校验 → 会话/CSRF/限流 │
                                    │ /mobile/** PWA+JSON API          │
                                    │ /mobile/ws 控制通道              │
                                    │ 其余路径 → DSH 反向代理(HTTP+WS) │
                                    └───────────────┬──────────────────┘
                                                    │ Host=127.0.0.1:3080
                                                    │ Cookie=网关持有的 DSH owner cookie
                                                    ▼
                                    ┌──────────────────────────────────┐
                                    │ 127.0.0.1:3080  dsh web          │
                                    │ 官方 DSH Web UI / Remote mux     │
                                    └──────────────────────────────────┘
```

- 网关只绑定回环：`config.ts:349-351` 拒绝非回环 `gateway.host`；`cordis.patch.yml:10-13` 写死 `127.0.0.1:3091`。
- DSH 不暴露公网；公网入口由网关终止（`docs/architecture.zh.md:7-32`、`docs/security.zh.md:18-23`）。
- 实测（只读 `GET /health?deep=1`）：`version=0.1.4`、`gateway.port=3091`、`dsh-upstream=http://127.0.0.1:3080 (HTTP 401)`、`tunnel=mode quick/connected/health ok`、`weixin=connected`、`capabilities={controller:true, workspaceRegistry:true, userQuestions:true, weixin:true}`、`dataDir=C:\Users\admin\.dsh\gateway-mobile`。
- 插件安装形态：`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 含 `dsh-gateway-mobile`，依赖为 `link:F:/ai_workspace/dsh-gateway-mobile`；即**源码目录被 link 进 profile**，改 `lib/` 后由 DSH HMR/重启生效。

### 1.2 `src/`（发布产物 `lib/`）模块职责

| 模块 | 职责 | 关键证据 |
|---|---|---|
| `src/index.ts` | Cordis 入口；构造服务、启动网关、后台起隧道/微信、注册 disposer；从 `package.json` 读版本 | `index.ts:98-302`，版本 `index.ts:43-44`，服务依赖 `index.ts:41` |
| `src/config.ts` | 默认值、嵌套合并、校验（回环 host、named token、OAuth 配置、范围） | `config.ts:111-192`、`349-382` |
| `src/gateway.ts` | HTTP 服务器：Host/Origin 准入、会话、CSRF、静态页、`/mobile/ws`、DSH 代理编排；分发到路由 | 全文 1442 行；准入 `656-852`；认证 `860-918`；静态 `1090-1206`；WS `1212-1348` |
| `src/routes/router.ts` | 极简声明式路由 + `assertLocal` | `routes/router.ts:33-71` |
| `src/routes/public.ts` | 免认证路由：health、`/admin` 跳转、配对 status/verify、OAuth 回调 | `routes/public.ts:13-71` |
| `src/routes/session.ts` | 已配对会话：me/status/refresh/logout；sessions/models 返回 1008 | `routes/session.ts:10-60` |
| `src/routes/devices.ts` | 设备列表、重命名、撤销、全部撤销、永久删除、清理 | `routes/devices.ts:12-87` |
| `src/routes/admin.ts` | 仅回环：logs、stats、pairing、settings、tunnel、capabilities、health、audit、key rotate | `routes/admin.ts:14-152` |
| `src/routes/weixin.ts` | 仅回环：微信状态、扫码登录、审批、推送策略、审批历史、登出 | `routes/weixin.ts:12-116` |
| `src/routes/oauth.ts` | OAuth providers/authorize/callback/unbind | `routes/oauth.ts:16-71` |
| `src/pairing.ts` | 一次性 8 位配对码、TTL、已用码、自动续发、日志脱敏 | `pairing.ts:43-123` |
| `src/sessions.ts` | HMAC(kid) 会话 cookie payload、常量时间校验、滑动续期 | `sessions.ts`（被 `gateway.ts:703-740` 使用） |
| `src/devices.ts` | `devices.json` 设备注册表、上限、撤销/过期/永久删除、socket 跟踪 | `devices.ts:77-160`、持久化 `devices.ts:91` |
| `src/tunnel.ts` | cloudflared 生命周期、URL 解析、重连、Named metrics `/ready`、状态 | `tunnel.ts:150-217`、Host 列表 `167-185` |
| `src/cloudflared.ts` | 二进制解析/下载/SHA-256/版本探测 | `cloudflared.ts:24-154` |
| `src/proxy.ts` | DSH cookie 换取、HTTP 代理、WS 升级代理、Host/Origin/cookie/`X-Forwarded-*` 重写 | `proxy.ts:103-127`、`183-221`、`224-414` |
| `src/oauth.ts` | GitHub/Gitee 授权码流程、state HMAC、白名单 | 路由见 `routes/oauth.ts` |
| `src/weixin.ts` | iLink Bot 通道：扫码登录、凭证加密、轮询、owner 信任边界、发送 | `weixin.ts:298-554` 等（文件 856 行） |
| `src/weixin-bridge.ts` | 微信 → DSH 会话桥接、审批/提问、审批历史 | `weixin-bridge.ts:198-203` |
| `src/weixin-notifier.ts` | 跨会话完成通知、合并/冷却/限额、待发队列 | `weixin-notifier.ts:136-137` |
| `src/ws.ts` | `/mobile/ws` 最小 RFC6455 服务器 | `gateway.ts:1212-1348` |
| `src/logger.ts` | 控制台 + 内存环 + 脱敏审计 + 异步 JSONL 轮转 + 审计查询 | `index.ts:103-109`、`routes/admin.ts:19-23,131-142` |
| `src/stats.ts` | 按天/按设备请求统计 `stats.json` | `stats.ts:49` |
| `src/settings.ts` | `admin-settings.json` 持久化覆盖（认证生命周期 + 运行时开关） | `settings.ts:82` |
| `src/ratelimit.ts` | 滑动窗口限流 + 配对锁定 | `gateway.ts:268-276`、`960-967` |
| `src/store.ts` | 原子 JSON 文件、AES-256-GCM `SecretBox`、多 kid 轮换 | `store.ts:155-156` |
| `src/util.ts` | cookie/UA/IP/协议/MIME/回环与代理头判定 | `util.ts:120-221` |
| `src/errors.ts` | 产品错误码 + 中英文文案 + HTTP 映射 | `docs/api.zh.md:21-57` |

### 1.3 数据目录与持久化文件（实测 `C:\Users\admin\.dsh\gateway-mobile`）

| 路径 | 内容 | 来源 |
|---|---|---|
| `<dataDir>/devices.json` | 设备注册表（含已撤销/过期记录） | `devices.ts:91` |
| `<dataDir>/admin-settings.json` | 管理端覆盖：`auth.sessionMaxAge`/`auth.pairingTokenExpiry` + 运行时开关 | `settings.ts:82` |
| `<dataDir>/secret.key` | 旧版单密钥（迁移为 `k1` 保留） | `store.ts:155` |
| `<dataDir>/secret-keys.json` | 最多 5 把 kid 作用域 AES-GCM/HMAC 密钥 | `store.ts:156`、`docs/security.zh.md:87-89` |
| `<dataDir>/stats.json` | 按天/按设备请求计数 | `stats.ts:49` |
| `<dataDir>/gateway.log`（+`.1`…`.N`） | JSONL 运行/审计日志，`5MB × 3` 轮转 | `index.ts:108`、`config.ts:186-191` |
| `<dataDir>/cloudflared/<asset>` | 自动下载的 cloudflared 二进制缓存 | `cloudflared.ts:46` |
| `<dataDir>/weixin-bot.json` | 微信 Bot 凭证（加密 + owner 盐哈希） | `weixin.ts:253` |
| `<dataDir>/weixin-session.json` | 微信 ↔ DSH 专用会话映射 | `weixin-bridge.ts:198` |
| `<dataDir>/weixin-approval-history.json` | 微信审批历史 | `weixin-bridge.ts:203` |
| `<dataDir>/weixin-notify-state.json` / `weixin-notify-pending.json` | 通知策略状态 / 待发队列 | `weixin-notifier.ts:136-137` |
| `dataDir` 默认值 | `$DSH_HOME/gateway-mobile`（`DSH_HOME` 默认 `~/.dsh`） | `config.ts:379-382` |

> 与工作台相关：**这些文件都在宿主机上、且与 DSH 同进程可读**；工作台宿主半侧不需要新开持久化层，直接复用 `SettingsStore`/`DeviceManager` 等实例即可（见 §6.6）。

---

## 2. 网关 HTTP 面全表

入口顺序（`src/gateway.ts:742-852`）：

1. `Host` 解析与信任判定（`#hostInfo:656-673`）：必须是回环 host（`127.0.0.1`/`::1`/`localhost`）或当前隧道 host / `tunnel.domain` / `gateway.publicUrl` 的 host；两者都不是 → 403。
2. `Origin` 校验（`#checkOrigin:675-688`）：存在 `Origin` 时 authority 必须等于 `Host`；`Sec-Fetch-Site: cross-site` 拒绝。
3. 安全头 + CORS（`#securityHeaders:697-701`、`#applyCors:771-780`）。
4. 公共路由表（`publicRouter`，`#route:790-794`）。
5. 公共静态资源（`#isPublicStatic:945-954`）。
6. 首次运行本地引导：`/mobile/admin` 仅 `info.local` 可直出（`#route:802-807`）。
7. 会话认证（`#authenticate:860-918`；本地管理白名单见 §2.4）。
8. `/mobile/api/v1/*`：变更方法强制 CSRF（`#route:815-831`、`assertCsrf:938-943`），非本地走限流（`#route:817-828`），然后分发 `apiRouter`。
9. `/mobile/*` 静态页（远端 `/mobile/admin` 404，`#serveStatic:1100-1108`）。
10. 其余路径：必须设备会话 → 换取/刷新 DSH cookie → 反向代理（`#route:839-851`、`proxy.ts`）。

### 2.1 页面路由（`src/gateway.ts:71-85`，`#serveStatic:1090-1135`）

| 路径 | 文件 | 可见性 |
|---|---|---|
| `/mobile/pair`、`/mobile/pair/` | `pair.html` | 公共 |
| `/mobile/oauth`、`/mobile/oauth/` | `oauth.html` | 公共静态（认证失败时会被重定向到这里） |
| `/mobile/devices`、`/mobile/devices/` | `devices.html` | 需会话 |
| `/mobile/shell`、`/mobile/shell/` | `shell.html` | 需会话 |
| `/mobile/diag`、`/mobile/diag/` | `diag.html` | 需会话 |
| `/mobile/admin`、`/mobile/admin/` | `admin.html` | **仅回环**（远端 404） |
| `/mobile/`、`/mobile` | `app.html` | 需会话 |
| `/admin`、`/admin/` | 302 → `/mobile/admin` | 公共重定向（`routes/public.ts:30-45`） |
| `/mobile/assets/*`、`/mobile/manifest.webmanifest`、`/mobile/sw.js`、`/mobile/icon.svg` | 静态资源 | 公共；HTML 响应带 CSP（`gateway.ts:1185-1189`）；`?v=<hash>` 由 build.json 注入（`1143-1170`） |

CSP（网关自己发的 HTML）：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'`（`gateway.ts:1187`）。**注意**：DSH 内工作台页面最终受 DSH 的 CSP 约束，不是这条；但“服务端返回 SVG 二维码、客户端只渲染 markup”的方式两边都可行。

### 2.2 公共路由（`src/routes/public.ts`，无需会话）

| 方法 | 路径 | handler | 备注 |
|---|---|---|---|
| GET | `/health` | `health` | 浅 health；`?deep=1` 走深检（`public.ts:16-25`） |
| GET | `/mobile/api/v1/health` | 同上 | 同上 |
| GET | `/admin`、`/admin/` | 302 | → `/mobile/admin` |
| GET | `/mobile/api/v1/pairing/status` | `pairing.status()` | 只返回 `valid/expiresIn/used`，**不返回码**（`pairing.ts:88-93`） |
| POST | `/mobile/api/v1/pairing/verify` | `handlePairVerify` | 限流 + 锁定；成功后发 `dsh_session`（`gateway.ts:960-1008`） |
| GET | `/auth/(github\|gitee)/callback` | `handleOAuthCallback` | OAuth 浏览器回调（`gateway.ts:1039-1078`） |

> 公共路由先于 CSRF/认证执行；`pairing/verify` 因此不受 `x-requested-with` 约束（`docs/api.zh.md:15-16` 的例外说明）。

### 2.3 已认证 API（`src/routes/api.ts:14-22` 组合，共 34 条路由）

图例：**会话**=需 `dsh_session`；**本机**=仅 `local`（回环且无代理头，无需会话）；**CSRF**=POST/PATCH/DELETE 需 `x-requested-with: XMLHttpRequest`。

| 方法 | 路径 | 鉴权 | CSRF | 证据 |
|---|---|---|---|---|
| GET | `/mobile/api/v1/me` | 会话 | - | `routes/session.ts:13-23` |
| GET | `/mobile/api/v1/status` | 会话；本机白名单 | - | `routes/session.ts:25-32`、`gateway.ts:865-866` |
| POST | `/mobile/api/v1/session/refresh` | 会话 | ✔ | `routes/session.ts:34-41` |
| POST | `/mobile/api/v1/logout` | 会话 | ✔ | `routes/session.ts:43-50` |
| GET | `/mobile/api/v1/(sessions\|models)` | 会话 | - | 501/1008：提示用 DSH UI（`routes/session.ts:52-59`） |
| GET | `/mobile/api/v1/devices` | 会话；本机可见全部，`?all=1` 含撤销 | - | `routes/devices.ts:14-29` |
| PATCH | `/mobile/api/v1/devices/{dev_…}` | 本人或本机 | ✔ | `routes/devices.ts:31-42` |
| POST | `/mobile/api/v1/devices/{dev_…}/revoke` | 本人或本机 | ✔ | `routes/devices.ts:44-53` |
| POST | `/mobile/api/v1/devices/revoke-all` | **本机** + `REVOKE ALL` | ✔ | `routes/devices.ts:55-65` |
| DELETE | `/mobile/api/v1/devices/{dev_…}` | **本机**，仅撤销/过期记录 | ✔ | `routes/devices.ts:67-74` |
| POST | `/mobile/api/v1/devices/purge` | **本机** + `DELETE REVOKED` | ✔ | `routes/devices.ts:76-85` |
| GET | `/mobile/api/v1/logs` | **本机** | - | `routes/admin.ts:16-24`、`gateway.ts:864` |
| GET | `/mobile/api/v1/admin/stats` | **本机** | - | `routes/admin.ts:25-33` |
| GET | `/mobile/api/v1/admin/pairing` | **本机**，返回完整码+QR | - | `routes/admin.ts:34-41`、`gateway.ts:1010-1026` |
| POST | `/mobile/api/v1/admin/pairing/regenerate` | **本机** | ✔ | `routes/admin.ts:42-50` |
| GET | `/mobile/api/v1/admin/settings` | **本机** | - | `routes/admin.ts:51-62` |
| POST | `/mobile/api/v1/admin/settings` | **本机** | ✔ | `routes/admin.ts:63-92` |
| POST | `/mobile/api/v1/admin/tunnel/(start\|stop\|restart)` | **本机** | ✔ | `routes/admin.ts:93-108` |
| GET | `/mobile/api/v1/admin/capabilities` | **本机** | - | `routes/admin.ts:109-116` |
| GET | `/mobile/api/v1/admin/health`（`?deep=1`） | **本机** | - | `routes/admin.ts:117-130` |
| GET | `/mobile/api/v1/admin/audit?action=&since=&limit=` | **本机** | - | `routes/admin.ts:131-143` |
| POST | `/mobile/api/v1/admin/key/rotate` | **本机** | ✔ | `routes/admin.ts:144-151` |
| GET | `/mobile/api/v1/admin/weixin` | **本机** | - | `routes/weixin.ts:14-26` |
| POST | `/mobile/api/v1/admin/weixin/login` | **本机** | ✔ | `routes/weixin.ts:27-35` |
| GET | `/mobile/api/v1/admin/weixin/login` | **本机** | - | `routes/weixin.ts:36-44` |
| POST | `/mobile/api/v1/admin/weixin/approve` | **本机** | ✔ | `routes/weixin.ts:45-55` |
| GET | `/mobile/api/v1/admin/weixin/notify` | **本机** | - | `routes/weixin.ts:56-64` |
| POST | `/mobile/api/v1/admin/weixin/notify` | **本机** | ✔ | `routes/weixin.ts:65-97` |
| GET | `/mobile/api/v1/admin/weixin/approvals` | **本机** | - | `routes/weixin.ts:98-106` |
| POST | `/mobile/api/v1/admin/weixin/logout` | **本机** | ✔ | `routes/weixin.ts:107-115` |
| GET | `/mobile/api/v1/oauth/providers` | 会话 | - | `routes/oauth.ts:18-23` |
| GET | `/mobile/api/v1/oauth/authorize` | 会话；本人或本机 | - | `routes/oauth.ts:24-37` |
| POST | `/mobile/api/v1/oauth/callback` | 会话 | ✔ | `routes/oauth.ts:38-59` |
| POST | `/mobile/api/v1/oauth/unbind` | 会话 | ✔ | `routes/oauth.ts:60-69` |

补充：
- 所有 `/mobile/api/v1/*` 在认证后都会先过 CSRF（变更方法）与限流；本机请求跳过限流（`gateway.ts:815-828`）。
- 错误统一 `{code,message,data}` 信封；错误码表见 `docs/api.zh.md:21-57`（CSRF=1007、permission_denied=3003、oauth_required=3004 等）。
- 本机白名单在 `#authenticate` 中显式列出：`/mobile/api/v1/admin/*`、`/mobile/api/v1/logs`、`/mobile/api/v1/status`、`/mobile/api/v1/devices`、`/mobile/api/v1/devices/*`（`gateway.ts:861-870`）。**新增工作台宿主路由必须复用同一套“本机=回环且未代理”的定义，否则会出现两套不一致的 local 语义。**

### 2.4 `loopback-only` 判定细节（决定工作台桥接安全性的核心）

```ts
// src/gateway.ts:656-673
#hostInfo(req) {
  const hostHeader = String(req.headers.host ?? '').toLowerCase()
  ...
  const loopback = isLoopbackAddress(hostname)         // 只看 Host 头，不看 socket.remoteAddress
  const proxied  = isProxiedRequest(req)               // cf-connecting-ip / cf-ray / x-forwarded-host / x-forwarded-for
  const tunnel   = !loopback && tunnelHosts.has(hostname)
  const local    = loopback && !proxied
  if (!loopback && !tunnel) return null                // 403
}
```

```ts
// src/util.ts:176-195
isLoopbackAddress: 127.0.0.1 | ::1 | ::ffff:127.0.0.1 | 127.* | localhost
isProxiedRequest: cf-connecting-ip | cf-ray | x-forwarded-host | 非空 x-forwarded-for
```

推论（对工作台设计至关重要）：

1. **“local”不是网络对端概念，而是“Host 头看起来是回环 + 没有代理头”**。任何本机进程（包括 DSH 宿主）直连 3091 都属于 `local`。
2. 经 Cloudflare 的请求一定带 `cf-*` 头 → `local=false`；经普通自建反代且未配 `publicUrl` 时 Host 不是隧道 host → 直接 403（除非配置 `gateway.publicUrl`/`tunnel.domain`，`tunnel.ts:167-185`）。
3. 宿主内“HTTP 桥接 → 127.0.0.1:3091”如果不加额外标记，必然被判定为本地管理员（`local=true`）。这与请求最初来自桌面还是手机无关。
4. `requestIp` 在 `trustProxy=true`（默认，`config.ts:159`）时优先取 `cf-connecting-ip`/`x-forwarded-for`（`util.ts:120-128`），用于限流/设备记录；不参与 local 判定。

### 2.5 WebSocket 与 DSH 代理

- `/mobile/ws`：握手校验 `dsh_session` 与设备状态；失败以 4001/4002/4003 关闭；支持 `ping`/`status.get`，`chat.*`/`approval.respond`/`file.upload` 返回 1008（`gateway.ts:1248-1348`、`docs/api.zh.md:261-274`）。
- 所有非 `/mobile/**`、非 `/auth/**` 请求（含 `/api`、`/api/remote.mux`、`/plugins/**`、SPA）在设备认证后透明代理到 DSH；升级请求管道式转发（`gateway.ts:839-851,1212-1246`、`proxy.ts:328-414`）。
- 代理会：剥离客户端 cookie、`Host/Origin` 改写为 DSH 回环 authority、注入网关持有的 DSH cookie、注入 `x-forwarded-*`（`proxy.ts:183-206`）。

---

## 3. 现有 Web 客户端（`web/`）

### 3.1 页面与脚本

| 页面 | 脚本 | 作用 | 证据 |
|---|---|---|---|
| `web/admin.html` | `web/src/admin.ts`（2887 行） | 独立管理台（7 tab） | `admin.ts:6` |
| `web/app.html` | `app.ts` | 手机首页：网关/隧道状态、打开 DSH、登出 | `web/src/app.ts` |
| `web/pair.html` | `pair.ts` | 配对页：读 fragment 自动填码、8 位码提交、过期刷新 | `pair.ts:50-56,130-139` |
| `web/devices.html` | `devices.ts` | 手机端“我的设备”列表/重命名/撤销 | `web/src/devices.ts` |
| `web/oauth.html` | `oauth.ts` | OAuth 绑定弹窗/回调 | `web/src/oauth.ts` |
| `web/diag.html` | `diag.ts` | 手机端诊断 | `web/src/diag.ts` |
| `web/shell.html` | `shell.ts` | 全屏同源 iframe 打开官方 DSH UI（`/`） | `shell.ts:47-62` |
| `web/sw.js` | - | PWA service worker；缓存名/预缓存列表来自 `build.json` | `web/sw.js:1-40` |

公共库 `web/src/common.ts:379-428` 的 `api()`：统一 `x-requested-with: XMLHttpRequest`、`credentials:'same-origin'`、GET 指数退避（`common.ts:288-352`）、401/配对类错误跳 `/mobile/pair`。

### 3.2 管理台 7 个 tab（与后端端点对应）

| tab | 页面元素 | 主要接口 | 交互要点 | 证据 |
|---|---|---|---|---|
| 概览 overview | 4 个状态 chip（网关/隧道/DSH/微信）、异常条、能力提示、3 KPI、隧道面板、快捷操作、7/14/30 天趋势 | `GET /admin/health?deep=1`、`GET /status`、`GET /admin/stats?days=` | 进入即拉取；异常 chip 跳诊断；隧道启停/重启按钮；公网地址复制 | `admin.html:97-195`、`admin.ts:338-799,2645-2656` |
| 配对 pair | `<div id="qr">`、8 位码、有效期进度、复制链接、重新生成、URL 变化横幅 | `GET /admin/pairing`、`POST /admin/pairing/regenerate` | 二维码只在 `pairingUrl` 为 https 时渲染（否则提示先开隧道）；过期且页面可见时自动刷新一次；`previousUrl/urlChangedAt` 触发常驻横幅 | `admin.html:197-230`、`admin.ts:1003-1136` |
| 微信 weixin | 三个二级分区：连接 / 推送 / 审批；扫码 QR、脱敏 owner、轮询状态、通知策略、审批历史 | `GET/POST /admin/weixin`、`POST/GET /admin/weixin/login`、`POST /admin/weixin/approve`、`POST /admin/weixin/logout`、`GET/POST /admin/weixin/notify`、`GET /admin/weixin/approvals` | 登录态轮询；待审批时显示“允许/拒绝”；推送策略在线保存 | `admin.html:432-598`、`admin.ts:1814-2287` |
| 设备 devices | 筛选（全部/在线/离线/撤销）、计数、全选、重命名、批量撤销、永久删除、清理已撤销 | `GET /devices?all=1`、`PATCH /devices/{id}`、`POST /devices/{id}/revoke`、`DELETE /devices/{id}`、`POST /devices/purge` | 在线优先排序；删除接口不可用时给出重启提示 | `admin.html:232-263`、`admin.ts:1142-1668` |
| 日志 logs | 级别筛选、搜索、自动刷新、审计导出工具条 | `GET /logs?limit=200`、`GET /admin/audit?action=&since=&limit=` | 审计导出为 JSON 下载 | `admin.html:265-305`、`admin.ts:1669-1750,2289-2329` |
| 设置 settings | 会话时长（天）、配对码有效期（分钟）、安全与密钥（活动 kid、轮换）、运行开关（隧道/微信/日志级别/代理超时） | `GET/POST /admin/settings`、`POST /admin/key/rotate` | 范围校验、内联错误、二次确认恢复默认；运行开关立即生效并持久化 | `admin.html:307-431`、`admin.ts:1752-1800,2330-2623` |
| 帮助 help | FAQ + 折叠诊断区：完整 health checks、能力矩阵、版本/能力摘要 | `GET /admin/health?deep=1`、`GET /admin/capabilities` | 概览异常 chip 也跳到诊断区 | `admin.html:599-693`、`admin.ts:799-846` |

> 另有两套导航：桌面侧栏 `.app-nav` 与移动底部 `.app-bottom-nav`，均为 7 项（`admin.html:46-54,694-702`）；`test/admin-ui.test.js:17-27` 把“6 个旧 tab + help”作为契约锁定。

### 3.3 QR / 扫码流程（两条独立链路）

**A. 配对码 + 配对 fragment URL**

1. `PairingManager` 生成 8 位无歧义码（`A-Z2-9` 去掉 I/O/0/1），格式 `XXXX-XXXX`（`util.ts:23-38`、`pairing.ts:57-73`）。
2. 管理端 `GET /admin/pairing` 返回：`code`、`codeRaw`、`expiresIn/expiresAt`、`pairingUrl = ${publicBase}/mobile/pair#pairing=<code>`、`qrSvg`、`tunnel`、`status`、`previousUrl`、`urlChangedAt`（`gateway.ts:1010-1026`）。
3. **码只放在 URL fragment**（`gateway.ts:1013`），不会进入服务端访问日志；公共 `pairing/status` 永不返回码（`pairing.ts:88-93`）。
4. QR SVG 由服务端 `qrcode` 包生成（`gateway.ts:1028-1037`，动态 `import('qrcode')`，220px、margin 1、纠错 M）；前端只是 `innerHTML = data.qrSvg`（`admin.ts:1013-1017`）。
5. 手机打开 `/mobile/pair#pairing=…`，`pair.ts` 从 `location.hash` 解析并预填（`pair.ts:50-56,130-134`），`POST /pairing/verify` 提交 `{pairingToken, deviceName}`（`pair.ts:97-128`）。
6. 成功后网关注册设备、签发 `dsh_session` cookie（`Path=/`、`HttpOnly`、`SameSite=Strict`、隧道上 `Secure`）（`gateway.ts:977-1008,703-714`）。
7. 失败锁定：`PairingLockout`（默认 5 次 / 5 分钟）键为 `IP|UA`（`gateway.ts:961-967,996-1003`；roadmap 0.1.5 计划改纯 IP，`docs/roadmap.zh.md:187`）。
8. 配对码用掉后立即续发新码（`pairing.ts:114-116`）；管理端在过期且页面可见时自动重新生成（`admin.ts:1082-1114`）。

**B. 微信扫码登录（仅本机管理台）**

1. `POST /admin/weixin/login` → `WeixinChannel.beginLogin()`：调用 iLink `get_bot_qrcode`，拿到 `qrcode` 与 `qrcode_img_content`，服务端再渲染 `qrSvg`（`weixin.ts:353-369`）。
2. 管理台定时 `GET /admin/weixin/login` 轮询 `get_qrcode_status`（`weixin.ts:372-432`），状态 `wait/scaned/pending/confirmed/expired/error`。
3. 默认 `weixin.requireApproval=true`（`config.ts:172`）：扫码确认后进入 `pending`，**必须在本机管理台点“允许连接”**（`POST /admin/weixin/approve`，`weixin.ts:434-470`）；记录 owner 的盐哈希，原始微信 ID 不落盘（`docs/security.zh.md:77-85`、`docs/DETAIL.zh.md:28`）。
4. 返回体含 `qrSvg`（`weixin.ts:543-554`），管理台直接渲染；这是**必须 loopback-only** 的能力（`docs/security.zh.md:93`、`docs/roadmap.zh.md:100`）。

---

## 4. 前端构建现状

`scripts/build-web.mjs`：

- 8 个入口 `['admin','app','common','devices','diag','oauth','pair','shell']` → `web/assets/*.js`（`:10-23`）。
- esbuild 参数：`bundle:true, format:'esm', platform:'browser', target:['es2020'], splitting:false, sourcemap:false`（`:12-23`）。
- 产物哈希清单 `web/assets/build.json`（`version` = 全部资产联合 sha8；`assets: {name: hash}`）（`:25-65`）。
- 网关把 HTML 中的 `/mobile/assets/<file>` 改写成 `?v=<hash>`（`gateway.ts:1143-1170`）；`sw.js` 读 manifest 生成缓存名与预缓存列表（`web/sw.js`）。
- 无运行时框架、无 React；CSS 是手写静态文件（`web/assets/admin.css` 71KB、`app.css`、`pair.css`），esbuild 不处理 CSS。
- TypeScript 只做类型检查：`web/tsconfig.json`（`noEmit:true`、`lib` 含 DOM、`types:[]`）；`npm run typecheck:web`。

> 结论：现有产线**不能**直接产出 DSH 客户端 bundle；需要新增一条**独立**产线，且不要改动现有产线的行为（否则会破坏 PWA/build.json/sw 的哈希契约，`test/pwa-build.test.js` 覆盖）。

---

## 5. 安全模型与工作台边界

### 5.1 现有管控（文档 + 代码对应）

| 管控 | 证据 |
|---|---|
| 网关仅绑定回环 | `config.ts:349-351`、`cordis.patch.yml:10-13` |
| Host 允许列表（回环/当前隧道 host/配置公网 host） | `gateway.ts:656-673`、`tunnel.ts:167-185` |
| Origin authority 匹配 + `Sec-Fetch-Site` | `gateway.ts:675-688` |
| 一次性配对码（8 位、TTL、单次、自动续发、日志脱敏） | `pairing.ts:57-123`、`util.ts:23-38` |
| 配对失败锁定 | `gateway.ts:961-967,996-1003` |
| HMAC-SHA256 会话 cookie、常量时间校验、滑动续期 | `gateway.ts:703-740`、`sessions.ts` |
| 每请求重查设备状态；撤销即关 socket | `gateway.ts:882-895`、`devices.ts:156-160` |
| 变更 API CSRF 头 | `gateway.ts:938-943` |
| 滑动窗口限流 | `gateway.ts:815-828`、`ratelimit.ts` |
| 仅本机的管理/日志 API 与管理页 | `gateway.ts:861-870,1100-1108` |
| 永久删除仅回环 + CSRF + 仅撤销/过期 | `routes/devices.ts:67-85`、`docs/security.zh.md:39,65` |
| Body/JSON 上限、DSH cookie 仅进程内、客户端 cookie 被剥离 | `gateway.ts:1372-1392`、`proxy.ts:183-206` |
| 微信 owner 信任边界 / 发送者允许列表 | `weixin.ts:323-350`、`docs/security.zh.md:44-47` |
| 多 kid AES/HMAC 密钥 + 轮换 | `store.ts:155-156`、`routes/admin.ts:144-151` |
| 配对码日志脱敏 `****-XY` | `index.ts:317-321`、`pairing.ts:68-72` |
| 审计导出仅回环 | `routes/admin.ts:131-143` |

### 5.2 为什么管理台必须 loopback-only（既有文档结论，不要重复设计）

- `docs/security.zh.md:91-93`：“管理页面和 `/admin/*` API 可在无会话的情况下**仅从回环**访问……经由隧道的请求始终携带公网 Host，且带有 `cf-*`/`x-forwarded-*` 请求头的请求绝不会被视为本地请求。”
- `docs/roadmap.zh.md:100`（P1-4）：“管理后台必须保持 loopback-only，不能为了手机访问把它暴露到隧道。”
- `docs/admin-console.zh.md:6`：“仅限本机回环访问。首次运行时尚无设备会话也可使用本页与 admin API。”
- `docs/DETAIL.zh.md:28`：“扫码登录只允许在环回管理后台确认。”

因此：**“把工作台放进 DSH UI”不能等价为“把管理 API 开放给 DSH UI 的所有访问者”**。工作台必须复刻现有能力分级，而不是绕过它。

### 5.3 手机经网关打开同一 DSH UI 的链路事实

1. 手机 → Cloudflare → 网关 3091 → 认证设备会话 → 代理到 DSH 3080（`gateway.ts:782-852`）。
2. 网关替换 cookie：客户端只持有网关 `dsh_session`，DSH owner cookie 永远留在网进程内（`proxy.ts:183-206`；`docs/security.zh.md:41,67`）。
3. 网关向上游注入 `x-forwarded-for`（真实手机 IP）、`x-real-ip`、`x-forwarded-proto`、`x-forwarded-host`（原始公网 Host）（`proxy.ts:196-200`）。
4. 因此：**DSH 宿主的业务/界面代码无法从认证身份区分“电脑直连”与“手机经代理”**（两者在 DSH 眼里都是同一个 owner，且 cookie 由网关注入）；唯一可用的信号是这些 `x-forwarded-*` 头（或网关额外注入的标记）。
5. `/plugins/**` 的客户端 bundle 也会经网关代理给手机（路径不在 `/mobile/**`），所以**同一份 React 工作台会同时出现在电脑和手机上**；客户端不能自行判断权限，必须由宿主侧裁决。
6. Quick Tunnel 重启后 host 变化会导致手机重新配对（`docs/limitations.zh.md:5-8`、`admin.ts:1028-1055`）；工作台里的配对/二维码展示应保留这个提示逻辑。

### 5.4 工作台能力分级建议（严格沿用现有语义）

| 能力 | 本机 DSH UI（直连 3080） | 手机经网关打开 DSH UI | 依据 |
|---|---|---|---|
| 状态总览（网关/隧道/DSH/微信/能力矩阵/health） | ✅ 可写不涉及，纯读 | ✅ 只读 | 现有 `/status`、`/admin/health` 字段 |
| 配对二维码 + 8 位码 + 重新生成 | ✅ | ❌ 不展示码/QR | `docs/security.zh.md:93` |
| 隧道启停/重启 | ✅ | ❌ 只读状态 | `routes/admin.ts:93-108`、`docs/security.zh.md:38` |
| 微信：状态/推送策略/审批历史 | ✅（读） | ❌ | `routes/weixin.ts` 全为 `assertLocal` |
| 微信：扫码登录/换绑/登出/审批 | ✅ | ❌ | `docs/DETAIL.zh.md:28`、`docs/security.zh.md:93` |
| 设备：列表（全部）/重命名/撤销/永久删除/清理 | ✅ | ❌（手机只看自己） | `routes/devices.ts:14-85` |
| 日志/审计导出 | ✅ | ❌ | `routes/admin.ts:16-24,131-143` |
| 设置（会话时长、配对 TTL、运行开关） | ✅ | ❌ | `routes/admin.ts:51-92` |
| 密钥轮换 | ✅ | ❌ | `routes/admin.ts:144-151` |
| 打开 DSH / 打开独立管理台链接 | ✅ | 保留外链/说明 | `admin.html:56-59` |
| 手机自身设备信息与登出 | — | ✅（现有） | `routes/session.ts:13-50`、`routes/devices.ts:31-53` |

> 手机侧“只读工作台”恰好可以完全由现有 `/mobile/api/v1/status` + `/me` 字段支撑（`GatewayStatusPayload`：`src/gateway.ts:154-173,628-649`），不需要新增远程能力。

### 5.5 关键陷阱：宿主桥接的“回环自证”问题

若采用“DSH 宿主路由 → HTTP 转发 `127.0.0.1:3091`”：

```
手机 → 网关(3091) → DSH(3080) → [宿主桥接] → HTTP → 网关(3091)
                                        这一跳 Host=127.0.0.1:3091、无 cf-*/x-forwarded-* 
                                        ⇒ #hostInfo 判定 local=true ⇒ 管理权限
```

后果：任何能触发该桥接的 DSH UI 访问者（包括经隧道打开同一 UI 的手机）都能调用管理 API；`#authenticate` 的本地白名单（`gateway.ts:861-870`）会直接放行，CSRF 头也可以由工作台 JS 自动带上。**这等于把 `/mobile/admin` 的 loopback 边界整体作废。**

必须二选一：

- **进程内调用（推荐）**：不经过 3091，宿主服务门面直接调用 `Gateway` 实例方法；本机/远端判定在工作台宿主侧完成（见 §6.2）。
- **HTTP 桥接必须加“内部信任标记”**：网关为桥接请求新增专用通道（独立 token/HTTP 头 + 不按 loopback 判定），且桥接方必须带上“原始请求是否本地”的可信结论；否则禁止上线。

补充风险：即使桥接方加 `Host: <隧道 host>` 试图伪装成远端，也会因无设备会话而被 401（`gateway.ts:871-917`），且手机 `dsh_session` 已被网关剥离（`proxy.ts:188-195`），宿主无法转发；这进一步说明“HTTP 回环桥接”不是自然可行的路线。

---

## 6. 复用方案对比与推荐

### 6.1 三方案对照

| 维度 | (a) 宿主路由 HTTP 桥接 → `:3091` | (b) 拆分 gateway 服务模块供宿主直接调用 | (c) 客户端跨源 fetch `:3091` |
|---|---|---|---|
| 实现位置 | `src/index.ts` 注册 `ctx.webServer` 路由 + `fetch('http://127.0.0.1:3091/...')` | 新增 `src/workbench/*` 服务门面，直接调用现有 `Gateway`/manager 实例 | React 组件 `fetch('http://127.0.0.1:3091/mobile/api/v1/...')` |
| 是否重写 `gateway.ts` | 否 | **不需要重写**：路由模块已是薄封装（`routes/*.ts`），`Gateway` 方法可直接复用；只需抽出“能力策略”层 | 否 |
| 单一实现 | 好（3091 仍是唯一入口） | 好（同一批 Gateway 方法） | 差（客户端复制 URL/鉴权逻辑） |
| 认证/CSRF | 需第二套内部鉴权（token/头），且要防“回环自证” | 复用宿主侧判定 + 现有 `assertCsrf` 语义；无第二跳 | 需要放开 Origin/CORS/SameSite，安全倒退 |
| 手机区分 | 桥接方需自行获知原始请求的 remote 属性（`x-forwarded-*`），再决定 token 权限 | 同一处判定；可加进程内 HMAC 设备标记（见 §6.2） | 手机根本不可达 3091 |
| 额外跳数与延迟 | +1 回环 HTTP 跳（含 JSON 序列化/反序列化） | 0 | 0（但大概率失败） |
| 失败模式 | 3091 未启动/端口冲突时工作台整体不可用（两套生命周期） | 与网关同生命周期（`src/index.ts` 已 ensure） | CORS/CSRF 403，且难以诊断 |
| 可行性结论 | 可行但需要网关新增“内部桥接协议”，否则不安全 | **推荐** | **不可行**（详见 §6.3） |

### 6.2 推荐方案：`b'` 同进程宿主路由 + 轻量服务门面

**核心事实**：工作台宿主半侧与网关是同一个进程里的同一个 Cordis 插件（`src/index.ts:98-302` 构造并持有 `Gateway`）。因此不需要“转发”，直接调用即可；也无需拆分 1442 行 `gateway.ts`，因为 `Gateway` 已经暴露细粒度方法，`routes/*.ts` 只是把 HTTP 请求翻译成这些调用：

```ts
// src/workbench/service.ts（新增，示意，不是已实现代码）
export class WorkbenchService {
  constructor(private gateway: Gateway) {}
  overview() { return { status: this.gateway.statusPayload(), health: this.gateway.buildHealth(), settings: this.gateway.runtimeSettings(), capabilities: this.gateway.capabilities() } }
  pairing() { return this.gateway.pairingPayload() }                  // 完整码/QR：仅本机
  regenerate() { this.gateway.pairing.issue(); return this.gateway.pairingPayload() }
  tunnel(action) { return tunnelOp(this.gateway, action) }            // 复用 routes/admin.ts:99-106 的错误包装
  settings(patch) { return this.gateway.updateRuntimeSettings(patch) }
  devices() { ... }  logs(limit) { ... }  audit(q) { ... }
  weixin() { ... }   weixinLogin() { ... }  weixinApprove() { ... }
}
```

**宿主侧准入（策略层）**：

```
请求进入 DSH webserver 的 /gateway-mobile/** 路由
  ├─ 校验 Origin/Host（桌面 http://127.0.0.1:3080；外部经网关时 Host 已被网关改写为 127.0.0.1:3080）
  ├─ 读取 x-dsh-gw-peer 标记：
  │    ├─ 存在且 HMAC 校验通过（来自网关代理，手机/外部） → 只读能力集（status/health/pairing 状态摘要，不含码）；
  │    └─ 不存在（本机直连；本机进程默认可信，见 security.zh.md:91-93） → 本机能力集（管理写操作）
  ├─ 变更方法：要求 x-requested-with: XMLHttpRequest（与 gateway.ts:938-943 同语义）
  └─ 调用 WorkbenchService
```

**推荐在网关代理侧增加一行“可信设备标记”**（最小改动、不进 UI 数据）：

- 在 `src/proxy.ts#upstreamHeaders`（`proxy.ts:183-206`）对以 `/gateway-mobile/` 开头的请求追加：
  - `x-dsh-gw-peer: remote`
  - `x-dsh-gw-device: <deviceId>`（可选）
  - `x-dsh-gw-signature: HMAC(secret, deviceId+timestamp+path)`（secret 为进程内随机值，工作台宿主半侧通过闭包/服务共享，不落盘）
- 工作台宿主半侧：标记存在 → 只读；标记缺失 → 本机。**注意方向**：伪造“标记存在”只会被降级（安全）；伪造缺失意味着本机进程（已受信）。这比“用 Host 判断”更安全，因为手机无法直接访问 3080。
- 若 task-1 确认 DSH 宿主路由可拿到原始 `request.headers`（`dsh-host-webserver` 的 handler 收到原生 `req/res`，`lib/index.js:471`），此方案即可落地；若只能走 resource/Peer 形态，则改用 DSH 的 Remote/typert 通道，判定信号仍然相同（见 §10 开放问题）。

**为什么保留 :3091 独立管理台**：用户明确“保留链接”。工作台与 `/mobile/admin` 共享同一 `Gateway` 实例与数据目录；独立页作为本机应急入口（DSH 升级、工作台注册失败时仍可用），也作为工作台“仅本机操作”的兜底链接（`http://127.0.0.1:3091/mobile/admin`）。

### 6.3 为什么 (c) 客户端跨源 fetch 不可行

1. **Origin/Host 必须一致**：DSH UI 页面 origin 为 `http://127.0.0.1:3080`（或手机侧公网 origin），fetch 到 `http://127.0.0.1:3091` 的 `Origin` 头与该请求的 `Host`（127.0.0.1:3091）不一致 → `#checkOrigin` 403（`gateway.ts:675-688`）。
2. **`Sec-Fetch-Site` 会是 `cross-site`** → 拒绝（`gateway.ts:686-687`）。
3. **CORS 默认不开**：`security.corsOrigins` 默认 `[]`（`config.ts:158`），`#applyCors` 只在白名单内回显（`gateway.ts:771-780`）；即使加白名单，也会让任意网页（包括恶意本地页面）获得管理 API 的读权限（因为请求最终是 loopback Host）。
4. **cookie 不发送**：`SameSite=Strict`（`gateway.ts:711`）意味着跨站请求不会带上 `dsh_session`；何况管理 API 在 `local` 路径下根本不需要会话，跨源一旦放行就是 CSRF 灾难。
5. **手机不可达**：手机浏览器里的 `127.0.0.1` 是手机自己，不是电脑（`docs/architecture.zh.md:7-32`）。

> 因此“客户端直接连 :3091”不应作为实现选项；最多只能在**同一 DSH 宿主**内做同源路由。

### 6.4 推荐落地形态（分阶段）

**Phase 0（本次只方案，不写代码）**：确认 DSH 客户端半侧能力与槽位（task-1），确认宿主路由/Remote 通道能否读取原始请求头。

**Phase 1（只读工作台，风险最低）**
- DSH UI 内新增“网关工作台”页面/入口：状态总览、隧道状态、微信状态、能力矩阵、配对状态（是否有效/剩余时间）、本机检测结果。
- 本机直连（桌面 DSH UI）：显示完整管理台功能或至少“打开独立管理台”入口。
- 手机经网关：只读；隐藏配对码/QR、隧道按钮、微信操作、设备写操作、日志导出、设置写入；给出“请在本机操作”的说明。
- 保留 `/mobile/admin` 链接。

**Phase 2（本机管理写操作）**
- 在本机直连下开放：配对 QR/重新生成、隧道启停/重启、微信登录/审批/换绑/推送策略、设备撤销/删除/清理、设置写、密钥轮换、审计导出（需要 CSRF + 二次确认）。
- 手机仍只读；可选提供“发送打开本机管理台的提示”（不能远程执行）。

**Phase 3（可选）**：把“工作台”作为 DSH 的 settings 卡片或 sidebar 面板（取决于 task-1 对槽位的结论）；同一 `WorkbenchService` 可同时服务两种入口。

### 6.5 文件级改造清单（推荐方案）

> 只列“工作台集成”需要触碰的文件；不含产品代码实现。写入范围按“新增优先、旧文件最小改动”排序。

**新增（客户端半侧，React）**
| 文件 | 作用 |
|---|---|
| `src/client/workbench/index.tsx` | DSH 客户端半侧入口：`export const apply(ctx)`/`inject`，向目标槽位注册工作台页面；`window.__ModuleLoader__.load` 由构建脚本包裹 |
| `src/client/workbench/entry.tsx` | 顶层容器与导航（概览/配对/隧道/微信/设备/日志/设置） |
| `src/client/workbench/api.ts` | 同源调用 `/gateway-mobile/api/*`（`x-requested-with` + 错误码映射），不出现 `127.0.0.1:3091` |
| `src/client/workbench/panels/{overview,pairing,tunnel,weixin,devices,logs,settings}.tsx` | 7 个面板；**手机只读 props** 由宿主返回值驱动 |
| `src/client/workbench/styles.css` | 样式；构建时内联/注入（见 §7.2） |
| `src/client/workbench/types.ts` | 与 `src/workbench/api-types.ts` 共享的 DTO 类型 |
| `scripts/build-client.mjs` | esbuild CJS + `window.__ModuleLoader__.load` 包裹；external 共享模块 |
| `tsconfig.client.json` | `jsx: 'react-jsx'`、DOM lib、`noEmit`；`npm run typecheck:client` |

**新增（宿主半侧）**
| 文件 | 作用 |
|---|---|
| `src/workbench/service.ts` | 门面：包装 `Gateway` 实例方法 + 能力策略（`local` vs `remote`）+ 审计 |
| `src/workbench/routes.ts` | 在 `ctx.webServer.register(...)` 注册 `/gateway-mobile/**`（或 DSH Remote 服务），实现 Origin 校验、CSRF、只读降级 |
| `src/workbench/auth.ts` | 可信来源判定：`x-dsh-gw-peer` HMAC 校验 / 本机直连判定 / 能力集选择 |
| `src/workbench/api-types.ts` | 响应 DTO（复用 `GatewayStatusPayload`、`PairingPayload` 等现有类型） |
| `src/index.ts`（改） | 构造 `WorkbenchService`，调用 `registerWorkbench(ctx, gateway)`；disposer 释放；不改现有网关启动顺序 |
| `src/proxy.ts`（改，小） | `#upstreamHeaders` 对 `/gateway-mobile/` 注入 HMAC 标记头（进程内 secret） |
| `src/config.ts`（改，小，可选） | `workbench.enabled`/`workbench.remoteReadOnly` 默认值；不改变现有校验语义 |
| `cordis.patch.yml`（改，小） | 如需可配置项，增加 `workbench` 段（默认开启）；**不新增 profile 行** |
| `package.json`（改） | `dsh.client`、`exports["./client"]`、`files`、`scripts.build:client/typecheck:client`、devDependencies（react 18 类型等） |
| `docs/next/`（后续文档） | 工作台使用说明、安全边界说明 |

**明确不改**
- `src/gateway.ts` 的 1442 行结构与现有准入/认证/代理逻辑；不迁移路由；不改变 `:3091` 行为与 CSP。
- `web/src/admin.ts`、`web/admin.html`、`web/assets/*`、`scripts/build-web.mjs`（保持独立管理台现状）。

### 6.6 手机场景的落地细节

1. **同一 UI 双端**：手机加载的 DSH UI 与客户端 bundle 都经网关代理；工作台组件不区分平台，只消费宿主返回的 `readOnly` 标记（服务端裁决，客户端只渲染）。
2. **二维码**：宿主在“本机”才返回 `pairingPayload`（含 `qrSvg`）；手机请求返回 `{valid, expiresIn, used}` 摘要（等价于现有公共 `pairing/status`，`pairing.ts:88-93`），因此手机端不可能截获一次性码。
3. **微信**：手机只显示 `state/owner.masked/notify 摘要`；QR/审批按钮不渲染（服务端拒绝）。
4. **隧道**：手机显示状态 + 公网地址（现有 `/status` 已含 `publicBase`，`gateway.ts:628-649`），启停按钮隐藏/禁用。
5. **链接保留**：工作台内“打开独立管理台”链接在桌面可点（`http://127.0.0.1:3091/mobile/admin`）；在手机上提示“仅本机可访问”，不发起请求。
6. **Quick Tunnel 换域名**：沿用 `previousUrl/urlChangedAt` 横幅（`admin.ts:1028-1055`），避免工作台与独立管理台两套提示逻辑分叉。

---

## 7. 新增 React 客户端半侧的构建改造

### 7.1 目标产物格式（DSH 客户端 bundle）

本机已安装的 DSH 客户端包证明格式如下（`lib/client.js` 第 1-3 行，多个包一致）：

```js
window.__ModuleLoader__.load({
  id: "<package name>",
  factory: (require) => {
    // CJS 风格模块体；require("react") 由 shell 的共享模块表解析
  },
});
```

对应 `package.json` 声明（以 `@deepseek-ai/dsh-experimental-client-ui-stats` 为例）：`dsh.client = { platform: 'web', inject: [<依赖的客户端包>] }`、`exports["./client"] = "./lib/client.js"`、`files` 含 `lib/client.js`。DSH 的 `dsh-client-modules` 说明：宿主扫描 Loader 条目 → 组合启动图 → `/plugins` 提供 bundle；每个 bundle 精确针对外壳冻结的共享模块表解析 external（`dsh-client-modules/README.zh.md:12,34,54,78`）；破坏 release 校验的 bundle 不会被页面应用（同文件 `:50-52`）。

### 7.2 `scripts/build-client.mjs`（新增）设计

```js
// 伪代码：与现有 build-web.mjs 完全解耦
import { build } from 'esbuild'
const external = [
  'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime',
  // 由 task-1 确认真实键名后补齐：@deepseek-ai/dsh-client-* 共享模块
]
await build({
  entryPoints: ['src/client/workbench/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',            // 关键：factory 内是 CJS，require 交给 DSH 模块表
  platform: 'browser',
  target: ['es2020'],
  jsx: 'automatic',
  external,
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-gateway-mobile", factory: (require) => {' },
  footer: { js: '}});' },
  loader: { '.css': 'text' }, // CSS 以字符串进入，factory 内注入 <style>
  sourcemap: false,
  legalComments: 'none',
})
```

要点：
- **不要用 `format:'iife'`**：IIFE 会把 external 解析成全局变量，无法使用 factory 的 `require`；`format:'cjs'` + 手工包裹才是 DSH factory 契约。
- 产物是 classic script（外层无 `import/export`），与 DSH 现有 `lib/client.js` 一致。
- CSS：现有 `web/assets/admin.css` 是独立静态文件；客户端半侧建议把 `styles.css` 通过 esbuild `text` loader 内联并在 `factory` 内插入 `<style data-dsh-plugin="gateway-mobile">`，避免新增 `/plugins` 静态资源路由。
- 二维码：**不引入客户端 QR 库**。宿主返回 `qrSvg`（现有服务端 `qrcode`，`gateway.ts:1028-1037`），React 用 `dangerouslySetInnerHTML={{__html: qrSvg}}` 渲染；SVG 是标记不是脚本，不会触碰脚本 CSP。手机端宿主不返回 `qrSvg`。

### 7.3 `package.json` 变更清单（示意，不在本文落地）

```jsonc
{
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",           // 新增：DSH 客户端半侧入口
    "./package.json": "./package.json",
    "./locale/*.json": "./locale/*.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // 保持
    "client": { "platform": "web", "inject": [] }  // 新增；inject 由 task-1 确认
  },
  "files": ["lib", "web", "locale", "...（保持）"],
  "scripts": {
    "build": "npm run build:server && npm run build:web && npm run build:client",
    "build:client": "node scripts/build-client.mjs",
    "typecheck": "npm run typecheck:server && npm run typecheck:web && npm run typecheck:client",
    "typecheck:client": "tsc -p tsconfig.client.json"
  },
  "devDependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0"
  }
}
```

注意：
- `lib/` 已在 `files` 中，`lib/client.js` 随 `lib` 一起发布，无需单独列。
- `lib/` 被 `.gitignore` 忽略（`.gitignore:5`），`lib/client.js` 是构建产物；`dsh plugin add <源码目录>`（本机 link 安装）前必须先 `npm run build`，与现有 `lib/` 约束一致。
- DSH 客户端半侧**只挂在与包名完全一致的根行上**（`dsh-client-modules` 的模块身份 = manifest 包名，`README.zh.md:82`）；`dsh.client.inject` 的精确列表属于 task-1 结论，不能凭猜测写。
- React 版本严格对齐 DSH 自带 `react ^18.2.0`（本机多个 `@deepseek-ai/dsh-client-ui-*` 包的 devDependencies 均为 `"react": "^18.2.0"`），并且必须 external；**打包 React 会导致两份 React，Hooks 失效**。

### 7.4 构建/检查影响

- `npm run build` 多一步 `build:client`；`web/assets/build.json` 不应包含客户端 bundle（它只给 PWA 用），改动要保证 `test/pwa-build.test.js` 仍通过。
- `npm run typecheck` 需要新增 client 项目（`tsconfig.client.json`），且 `src/client/**` 不能进现有 `tsconfig.json`（其 `rootDir: src`、无 JSX、`types:["node"]`）。
- HMR：客户端 bundle 变化会被 `dsh-client-modules` 的 `rebuilt()` 处理；本地开发需 DSH HMR 与 `npm run build:client --watch`（或 `esbuild --watch`）。是否要求 `pnpm run dev:web` 取决于 DSH 实现，属于 task-1。
- 现有 `npm test` 会先 `build`，因此客户端构建失败会直接卡测试门槛；建议构建脚本失败即非零退出。

---

## 8. 版本、发布与兼容

### 8.1 工作区实际版本核对（含 git 证据）

| 事实 | 证据 |
|---|---|
| HEAD 版本 = `0.1.4` | `package.json:3`；`git log -1` = `8783645`，工作树干净 |
| `e7535e6` 将 `0.1.3` → `0.1.4` | `git show e7535e6 -- package.json`：`"version": "0.1.3"` → `"0.1.4"` |
| `8783645` 是**同版本内**继续硬化，不再 bump | 提交信息“0.1.4 hardening”；`package.json` 未再变；`CHANGELOG.zh.md:7`“本版本不升版本号” |
| 更早版本序列 | `d1697af` 0.1.0 → `d4e6e0a` 0.1.1 → `bccce38` 0.1.2 → `b72835f` 0.1.3 → `e7535e6` 0.1.4 |
| 无 git tag | `git tag -l` 为空；远端只有 `origin/main`，当前分支 `next` |
| `dist/` 是**旧构建** | `dist/dsh-gateway-mobile-0.1.4.zip` 内的 `web/admin.html=48918B`、`web/assets/admin.js=118255B`、`web/src/admin.ts=105995B`；当前工作树分别为 `46574B`、`121026B`、`110973B`（即 dist 产自 `8783645` 之前） |
| 运行实例版本 | 实测 `GET http://127.0.0.1:3091/health` → `version=0.1.4` |

**解释**：`git log` 里出现两个 0.1.4 提交是“同一版本迭代未升号”的结果，不是版本不一致；`package.json` 与 README/CHANGELOG/运行实例均为 0.1.4。**风险在于分发物**：`dist/*.0.1.4.zip` 与“今天重新 `npm run pack` 得到的 0.1.4”内容不同，若直接复用版本号发布，会造成“同版本不同字节”。因此本次工作台不应继续使用 0.1.4。

### 8.2 `engines.dsh` 精确匹配与升级风险

- `package.json:33-36`：`engines.dsh = "0.2.2-rc.1"`（精确版本）、`engines.node = ">=24"`；实测运行时 Node 24.22.0、DSH 0.2.2-rc.1（`E:\soft\...\@deepseek-ai\dsh\package.json` 的 `engines.node >=24.9.0`）。
- 插件版本来源：`src/index.ts:43-44` 从 `package.json` 读取；DSH 客户端 bundle 的 release 校验则依赖 **DSH 自身**的 `version + commit`（`dsh-client-modules/README.zh.md:50-52`），与插件版本无关。因此插件可以升到 0.2.0 而不必改 `engines.dsh`。
- 升级风险（既有结论）：DSH 0.2.x 尚在 rc；精确 `engines.dsh` 意味着每次 DSH 升级都可能拒绝加载（`docs/roadmap.zh.md:107`、`docs/limitations.zh.md`）。工作台依赖更多 DSH 内部能力（客户端模块、槽位、路由/Remote），**应把本次目标锁定在 0.2.2-rc.1**，不承诺跨 DSH 版本；升级 DSH 时先跑 `doctor`/`hmr-check`/`integration-check`。
- `docs/roadmap.zh.md:191-196` 的 0.2.0 计划（P2-1 手机聊天 UI、P2-2 多用户、P2-4 英文化、P2-3 provider）与本次“工作台”**部分重叠但不等价**：P2-1 是“在手机上看聊天/审批 UI”，工作台是“在本机看运维管理台”。两者可并行，但不应把工作台当作 P2-1 的替代；P2-1 仍受 Quick Tunnel 无 SSE、官方 UI 体验等限制（`docs/limitations.zh.md:5-19`）。

### 8.3 分发包与 `scripts/pack.mjs`

- `package.json.files`（`:12-27`）决定 `npm pack` 与 `scripts/pack.mjs` 的内容；`pack.mjs:27-40` 从 `files` 派生清单，不再硬编码。
- 新增客户端半侧后：`files` 已含 `lib`，`lib/client.js` 自动进入分发包；若客户端 CSS/静态资源放到 `web/` 之外（例如 `lib/client.css`），也在 `lib` 内。
- `scripts/check-docs.mjs` 会校验 `files` 包含 bundle patch、LICENSE、`docs/DETAIL.*`（`development.zh.md:60-72`），新增文件不影响，但 `dsh.client` 声明需与 `exports["./client"]` 同步，建议补一条 check-docs 规则。
- `dist/` 被 `.gitignore` 忽略；更新 `dist` 前先构建。

### 8.4 测试门槛（现状 vs 工作台新增）

`package.json:40-54` 的脚本：

| 门槛 | 现状 | 工作台影响 |
|---|---|---|
| `npm run build` | `tsc` + `build:web`（`scripts/build-web.mjs`） | 增加 `build:client`；必须保持 build.json/PWA 行为不变 |
| `npm test` | 先 build，再 `node --test test/*.test.js`；实测 **127 个 `test()`**（`docs/development.zh.md:8` 的“117 个”已过期） | 新增工作台单测（策略层：本机/远端能力集、HMAC 标记、CSRF、错误码）；现有静态 UI 测试（`test/admin-ui.test.js`）应保持不变 |
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit` + `tsc -p web/tsconfig.json` | 增加 `tsconfig.client.json` 项目；JSX 严格模式下也要 `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes` |
| `npm run test:integration` | 真实 DSH：建临时 profile、link 插件、关隧道、起 dsh web，覆盖 health/本地 admin/配对/代理 HTML/Remote mux（`scripts/integration-check.mjs:83-161`） | 增加工作台宿主动作的冒烟：本机可读配对码、模拟 `x-forwarded-*` 后只读、未知 Origin 403；并验证 3091 独立管理台仍工作 |
| `npm run hmr-check` | 启动真实 dsh web，touch `lib/index.js` 验证重载后端口仍健康（`docs/development.zh.md:90-104`） | 客户端 bundle 变化 + 宿主路由重注册；需确认重载后 `/gateway-mobile/**` 仍可用且不重复注册 |
| `npm run check-docs` | 校验 package version/engines、README 状态行、CHANGELOG 首版本、DETAIL/API/architecture-flow/deviations 版本引用（`scripts/check-docs.mjs:1-11,90-190`） | **版本号一改必须同步**；若用 `0.2.0-next.0`，现有正则只接受 `X.Y.Z`（README 状态 `\d+\.\d+\.\d+`、CHANGELOG `## (\d+\.\d+\.\d+)`，`check-docs.mjs:107-140`）→ 会误报/失败，需要同步放宽为 semver 预发布 |
| `npm run doctor` | 只读自检（Node/DSH/cloudflared/端口/dataDir/profile/密钥） | 可增加“客户端 bundle 是否存在/`dsh.client` 声明有效”检查（可选） |

### 8.5 版本号建议

**建议 `0.2.0-next.0`**，理由：

1. 工作台是**新增用户可见能力**（新 tab/页面、新客户端半侧、新宿主路由），不是补丁；按路线图 0.2.0 的迭代口径（`docs/roadmap.zh.md:191`）合理。
2. 预发布号避免与“已存在但内容不同的 0.1.4 dist 包”冲突；发布时走 npm `next` dist-tag，验证稳定后再发 `0.2.0`。
3. 保留 `engines.dsh: "0.2.2-rc.1"` 精确匹配；不因插件版本变化而放宽。
4. 落地清单（发布前）：`package.json.version`、README 状态行、`CHANGELOG.*` 新首节、`docs/DETAIL.*` 版本引用、`docs/api.md` 示例版本、`docs/architecture-flow.md`/`docs/deviations.md` 版本引用、`scripts/check-docs.mjs` 的正则（支持 `-next.N`）、`dist` 重新 `npm run pack`。

> 备选：若不想改 check-docs 正则，也可用 `0.2.0`（不带预发布）并只发 `next` tag；但仓库内应有一条“当前为 next 预发布”的说明，避免误以为已稳定。**不推荐继续用 0.1.4**（分发物污染），也不推荐 0.1.5（工作台不是补丁）。

---

## 9. 既有文档结论与约束（避免重复设计）

| 文档 | 与工作台相关的结论/约束 | 证据 |
|---|---|---|
| `docs/security.zh.md:91-93` | 管理页/admin API 无会话但仅回环；经隧道请求带 `cf-*`/`x-forwarded-*` 绝不算本地 | 已引用 |
| `docs/security.zh.md:50,65,67` | 首次运行本地引导、永久删除仅回环、DSH cookie 不在手机链路 | 已引用 |
| `docs/roadmap.zh.md:98-103`（P1-4） | 管理后台 IA 已拆分；**管理台必须 loopback-only**；手机只通过 `/mobile/` 提供设备自身状态与诊断入口 | 已引用 |
| `docs/roadmap.zh.md:121-126`（P2-1） | 专用手机聊天/审批 UI **推迟**；`/mobile/ws` 仍骨架；不要用它替代官方 UI | 与工作台边界相关：工作台不要顺手实现手机聊天 |
| `docs/roadmap.zh.md:191-196`（0.2.0） | 0.2.0 计划 P2-1/P2-2/P2-4/P2-3；本次工作台是新增方向，需在 0.2.0 范围说明中补一条 | 避免版本计划冲突 |
| `docs/admin-console.zh.md:6-50` | 7 个分区现状、微信三区、设置项、手机页面共享设计 token | 工作台信息架构可直接复用其分组 |
| `docs/DETAIL.zh.md:24-29` | 安全模型摘要；扫码登录仅回环确认 | 已引用 |
| `docs/mobile-workspace.zh.md:5-18` | 网关是反向代理，无法转发 Windows 原生对话框；手机点“新建工作区”无反应是已知现象 | 与本工作台无关但同属“手机经网关”约束，工作台不应再引入宿主原生 UI 依赖 |
| `docs/deviations.zh.md:29,35-37` | 管理 API 仅回环且非代理；独立手机聊天 UI 推迟；`/sessions`/`/models` 返回 1008 | 已引用 |
| `docs/limitations.zh.md:5-19` | Quick Tunnel 域名漂移、无 SSE、专用手机聊天 UI 暂缓 | 工作台不要依赖 SSE/固定域名 |
| `docs/development.zh.md:14-27,60-72` | 构建/缓存失效/文档一致性检查 | 客户端半侧需同步更新开发文档 |

---

## 10. 风险与开放问题

| # | 问题 | 影响 | 建议/验证方式 | 归属 |
|---|---|---|---|---|
| Q1 | DSH 0.2.2-rc.1 是否支持第三方插件注册**带导航入口的整页/面板**？ | 决定工作台是“整页”还是 settings 卡片 | 见 task-1 的结论；本盘点只确认现有插件能注入服务与客户端 bundle | task-1 |
| Q2 | 宿主 webserver 路由的 handler 能否读取原始 `req.headers`（用于识别 `x-forwarded-*` 与 HMAC 标记）？ | 决定“本机/远端”判定信号 | 已见 `dsh-host-webserver/lib/index.js:471` handler 收到原生 `req/res`，但需以 task-1 的官方接口结论为准 | task-1 |
| Q3 | 客户端半侧的 shared module 精确键名（`react`、`react-dom`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-*`） | external 配错会导致 bundle 加载失败 | 对齐 `dsh-client-modules` 的 `PLATFORM_MODULES` 表；让 task-1 给出清单 | task-1 |
| Q4 | 工作台宿主路由与 DSH 的 Origin/认证策略由谁负责 | 注册的额外路由没有 DSH 内置认证，必须自建 | 复用 `#checkOrigin` 语义 + HMAC 来源标记 + CSRF；或改用 DSH Remote/typert 通道 | Lead + task-1 |
| Q5 | 手机端只读判定是否可被本机恶意进程伪造 | 本机进程本来就可读 DSH 凭证/配置（`security.zh.md:91-93`），不构成新增风险；但需明确写在文档 | 安全说明新增一节“工作台信任边界” | Lead |
| Q6 | Quick Tunnel 域名漂移时工作台/独立管理台提示是否统一 | 两套 UI 提示分叉 | 复用 `previousUrl/urlChangedAt`（`gateway.ts:1010-1026`、`admin.ts:1028-1055`） | 实现阶段 |
| Q7 | 若工作台只做只读，用户“隧道启停/微信登录”需求如何满足 | 桌面 DSH UI 本机直连时仍可管理；手机提示本机操作 | Phase 2 按 §5.4/§6.4 推进 | 决策 |
| Q8 | DSH 桌面壳（Electron）下宿主路由可能不可达 | 工作台仅 Web 可用 | 以 task-1 的客户端半侧平台结论为准；降级为“打开独立管理台”链接 | task-1 |
| Q9 | `dist` 内 0.1.4 与源码 0.1.4 内容不同 | 发布/回滚混乱 | 新版号（§8.5）+ 重新 pack；旧 dist 标记废弃 | Lead |
| Q10 | `check-docs` 的版本正则不支持预发布号 | 版本 bump 后发布检查失败 | 同批修复 `scripts/check-docs.mjs:107-140` 正则并加测试 | 实现阶段 |

---

## 11. 证据索引（快速跳转）

**入口/版本/构建**
- `package.json:3,7-36,40-54,66-72`
- `src/index.ts:41,43-44,98-302,317-321`
- `scripts/build-web.mjs:10-65`
- `scripts/pack.mjs:27-40`
- `scripts/integration-check.mjs:83-161`
- `docs/development.zh.md:7-27,60-104`
- `docs/CHANGELOG.zh.md`（`CHANGELOG.zh.md:5-26`）

**准入/认证/代理**
- `src/gateway.ts:68,71-85,154-173,262-289,348-366,628-673,675-688,690-740,742-852,860-943,945-954,960-1008,1010-1037,1039-1078,1090-1206,1212-1348,1372-1406`
- `src/util.ts:120-128,176-203`
- `src/proxy.ts:103-127,183-221,224-326,328-414`
- `src/tunnel.ts:167-193`
- `src/routes/public.ts:13-71`
- `src/routes/session.ts:10-60`
- `src/routes/devices.ts:12-87`
- `src/routes/admin.ts:14-152`
- `src/routes/weixin.ts:12-116`
- `src/routes/oauth.ts:16-71`

**微信/配对/存储**
- `src/pairing.ts:43-123`
- `src/weixin.ts:298-321,353-470,520-554,543-554`
- `src/weixin-bridge.ts:198-203`
- `src/weixin-notifier.ts:136-137`
- `src/devices.ts:91,156-160`
- `src/settings.ts:82`
- `src/stats.ts:49`
- `src/store.ts:155-156`
- `src/cloudflared.ts:46`
- `src/config.ts:111-192,349-382`

**前端**
- `web/admin.html:46-54,56-59,97-195,197-230,232-263,265-305,307-431,432-598,599-693,694-702`
- `web/src/admin.ts:6,251-259,294-336,338-799,1003-1136,1142-1668,1669-1750,1814-2287,2289-2329,2330-2623,2645-2656,2869-2887`
- `web/src/common.ts:288-428`
- `web/src/pair.ts:50-56,97-139`
- `web/src/app.ts:45-121`、`web/src/shell.ts:47-83`
- `web/sw.js:1-40`

**文档**
- `docs/security.zh.md:18-23,25-51,52-67,69-75,77-89,91-93,102-120`
- `docs/roadmap.zh.md:7-9,17-21,68-73,98-103,121-126,142-147,164-196`
- `docs/admin-console.zh.md:5-50`
- `docs/DETAIL.zh.md:11-33`
- `docs/deviations.zh.md:19-43`
- `docs/mobile-workspace.zh.md:5-18`
- `docs/limitations.zh.md:5-26`
- `docs/api.zh.md:5-57,59-284`

**DSH 运行时（只读参考，供 task-1 对齐）**
- `@deepseek-ai/dsh/package.json`（0.2.2-rc.1；`engines.node >=24.9.0`）
- `@deepseek-ai/dsh-client-modules/README.zh.md:12,34,50-56,78,82,92`
- `@deepseek-ai/dsh-host-webserver/README.zh.md:59-67,85,132`、`lib/index.js:471,576-626`
- `@deepseek-ai/dsh-experimental-client-ui-stats/package.json`、`lib/client.js:1-3`
- `@deepseek-ai/dsh-client-ui-directory-picker-browse/package.json`、`lib/client.js:1-3`
- `@deepseek-ai/dsh-client-ui-settings/README.zh.md:47`（settings 槽位示例）

---

## 12. 一句话结论

插件侧的事实已经把三件事定死了：**管理能力全部集中在 `Gateway` 实例上、loopback 判定是 Host/代理头语义、手机侧的合法能力只到 `/status`+`/me`**。因此工作台最合适的形态是：**在 DSH 宿主内注册 `/gateway-mobile/**`，用一个薄服务门面直接调用现有 `Gateway` 方法，用“进程内 HMAC 代理标记 + 本机直连”区分只读与管理；客户端半侧按 DSH factory 契约新增一条 esbuild CJS 产线，React 走 external；版本从 0.1.4 升到 `0.2.0-next.0`，并同步 check-docs 与分发包。** 不建议 HTTP 回环桥接（会自证为本地管理员）、不建议跨源 fetch（会被 Origin/CORS/SameSite 拒绝）、也不建议重写 1442 行的 gateway.ts。
