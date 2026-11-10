# 0.2.0-next 设计决策：把网关监控台变成 DSH 内“手机网关工作台”

> 状态：**已拍板，Phase 0 已实现**（2026-11-10）。剩余 Phase 1/2 待排期。
> 分支：`next`（从 `main@8783645`，插件 0.1.4 切出）。
> 依据：本目录两份调研文档 —— [`research-plugin-inventory.zh.md`](./research-plugin-inventory.zh.md)（插件现状/安全/接口）、[`research-dsh-integration.zh.md`](./research-dsh-integration.zh.md)（DSH 客户端集成/构建/通信/槽位）。
> DSH 基线：**0.2.2-rc.1（安装态，唯一权威）**；源码参考 v0.2.1-rc.5 仅用于理解机制。
>
> **已确认决策**：方案 A（`main` 整页 + `sidebar.panellist` 左栏入口，`PANEL_ID = "gateway-mobile-workbench"`）；版本 `0.2.0-next.0` + npm `next` dist-tag；`engines.dsh` 继续精确锁定 `0.2.2-rc.1`；手机只读，微信扫码登录/审批仅本机。
>
> **Phase 0 已落地文件**：`scripts/build-client.mjs`、`tsconfig.client.json`、`src/client/index.tsx`、`src/workbench/bridge.ts`、`test/workbench.test.js`；`package.json` 增加 `dsh.client` / `exports["./client"]` / 构建脚本；`src/index.ts` 接入桥路由；`tsconfig.json` 排除 `src/client`。
>
> **Phase 1 已落地（2026-11-10）**：`read/pairing`、`read/devices`、`read/logs`、`read/settings`（仅本机）与 `POST admin/pairing/regenerate`；网关注入 `x-dsh-gateway-proxied` 并在代理层对本地专属前缀 403；工作台 5 个页签（概览/配对/设备/日志/设置），手机仅概览；配色改用 DSH `--dsw-alias-*` 主题 token，跟随明暗主题。
>
> **Phase 2 部分已落地（2026-11-10）**：设置页签可编辑（会话时长、配对 TTL、隧道/微信开关、日志级别、代理超时），`POST admin/settings` 仅本机；概览提供隧道启动/停止/重连，`POST admin/tunnel` 仅本机；布局改为标题/页签冻结、内容区独立滚动。
>
> **启用步骤**：`npm run build` 后重启一次 `dsh web`（DSH 缓存客户端 bundle 清单直到重启）。重启会同时重连 Quick Tunnel（公网域名可能变化，手机需重新配对）。

---

## 1. 问题与结论

**问题**：本插件（Cloudflare Quick Tunnel + 一次性配对 + 微信 ClawBot/iLink）的功能，能否直接作为 DSH 的一个“工作台”，提供状态总览、配对二维码、扫码连接（手机配对 / 微信扫码登录）等操作，让用户不用再额外打开 `http://127.0.0.1:3081/mobile/admin`，同时又保留“想打开时能打开”的链接？

**结论：能做，推荐做。** 但需要先纠正一个概念：

- DSH **没有**“工作台 / 顶层页面 / URL 路由”的一等概念；Web UI 是 slot 组合，不是路由表。
- 唯一自然的“整页 + 导航入口”组合是 **`main` keyed 面板 + `sidebar.panellist` 图标**，与官方 **Plugins** / **Schedules** 页完全同构（`ctx.slots.register({ name:'main', key })` + `ctx.slots.register({ name:'sidebar.panellist', id:key, label, icon })`）。
- 因此“作为 DSH 的一个工作台”在产品上应表述为：**在 DSH 左侧栏新增“手机网关”入口，点开是整页工作台**。不是改造 DSH 本体，也不是新增 DSH 概念。

**推荐形态**：

```
DSH Web UI（3080 / 隧道）
 ├─ 左栏图标“手机网关”（sidebar.panellist）
 └─ 整页工作台（main 面板，key=gateway-workbench）
      概览 · 配对 · 微信 · 设备 · 日志 · 设置 · 帮助
      页头：“打开独立管理台”“打开公网手机入口”
```

独立管理台 `:3081/mobile/admin` **保持现状、继续可用**，作为兜底与本机应急入口；两者共享同一套服务与数据。

---

## 2. 为什么是这个方案（以及与备选的取舍）

| 方案 | 结论 | 原因 |
|---|---|---|
| **A. 整页工作台（main + sidebar.panellist）** | **推荐** | 与官方页面同构、有全局导航入口、一屏可容纳 7 个分区；DSH 内没有更“像工作台”的表面 |
| B. `settings.section`（设置内整页） | 降级 | 入口埋在“设置”里，违背“不用再打开额外页面/一眼看到状态”的初衷；API 更保守 |
| C. `shell.overlay` 状态徽标 | 辅助 | 适合 MVP 第一步打通通信，不承担整页 |
| D. iframe 嵌入现有 admin 页 | **不做** | 2000+ 行的独立页面套进 DSH，双 UI、主题/缩放/移动端都别扭，也解决不了安全边界 |
| E. 仅加一个“打开监控台”链接 | **不做** | 用户明确说“不想再额外打开监控页面” |

技术上还有两个“看似可行、实际不行”的路线，已由调研排除：

- **客户端跨源 `fetch('http://127.0.0.1:3081/...')`**：网关要求 Origin==Host、拒绝 `Sec-Fetch-Site: cross-site`、CORS 白名单默认空、会话 Cookie `SameSite=Strict`，手机端根本到不了 `127.0.0.1:3081`。**否决。**
- **DSH 宿主 HTTP 桥接 → 回环 `:3081`**：这一跳在网关看来是“纯回环 + 无代理头”，会被判定为 `local` 管理员；任何能触发桥接的 DSH UI 访问者（包括经隧道打开同一 UI 的手机）都会获得管理权限。**等于作废 loopback 边界，禁止上线。**

---

## 3. 目标架构

```
┌───────────────────────── DSH Web UI（浏览器） ─────────────────────────┐
│ 客户端半侧 dsh-gateway-mobile/client（React 18，lazy-CJS bundle）      │
│   main 面板（工作台）+ sidebar.panellist 图标 + 内联样式               │
│   fetch('/api/gateway-mobile/read/*' | '/api/gateway-mobile/admin/*')  │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ 同源；DSH /api 栅栏 + 浏览器认证（owner）
┌───────────────────────────────▼────────────────────────────────────────┐
│ DSH 宿主进程（= 插件进程）                                             │
│  宿主半侧桥：ctx.connection.fetch.register() 精确路由                  │
│    ├─ /api/gateway-mobile/read/*   → 已配对手机/本机均可用（脱敏只读）  │
│    └─ /api/gateway-mobile/admin/*  → 仅本机（双层门禁）                 │
│  WorkbenchService（新增，薄门面）                                      │
│    └─ 直接调用现有 Gateway / PairingManager / TunnelManager / … 实例   │
│  （不新增 HTTP 回环跳、不重写 gateway.ts、不复制业务逻辑）              │
│                                                                        │
│  Gateway（3081，保持不变）                                              │
│    └─ 现有 /mobile/admin 页面 + 34 条已认证 API + 代理                 │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ 反向代理（设备鉴权后）
                     网关代理 src/proxy.ts
                       ├─ 注入 x-dsh-gateway-proxied: 1（并剥离入站伪造）
                       └─ 对 /api/gateway-mobile/admin/* 且 !local → 403

独立管理台 http://127.0.0.1:3081/mobile/admin（保留，兜底）
```

### 3.1 宿主半侧（新增 `src/workbench/*`）

- **`ctx.connection.fetch.register()`**（DSH 0.2.2-rc.1 已安装且可用）注册 `/api/gateway-mobile/...` 精确 Fetch 路由：
  - 自动继承 DSH 的 Host/Origin 栅栏与浏览器认证；**只有 owner Peer 能进入确切路由**；
  - 同源、无 CORS、无需自建 CSRF token；
  - 手机经网关打开 DSH UI 时，网关把 `/api/*` 一并代理并注入 DSH owner Cookie，因此**同一套接口桌面和手机都可达**。
- **`WorkbenchService`** 薄门面：把现有 `Gateway` 已暴露的方法（`pairingPayload`、`statusPayload`、`buildHealth`、`capabilities`、`runtimeSettings`、`tunnel`、`devices`、`logger`、`weixin*`…）包装成工作台 DTO；并把 `src/routes/admin.ts` 中“解析/校验/写入”的逻辑抽到同一 service，**让独立管理台与工作台共享单一实现**（避免双份维护）。
- **不改**：`src/gateway.ts` 的 1442 行准入/认证/代理结构；`web/src/admin.ts`；`scripts/build-web.mjs`。
- **网关改动（小）**：`src/proxy.ts#upstreamHeaders` 注入分类头并剥离入站同名头；代理分支对 `/api/gateway-mobile/admin/*` 在 `!info.local` 时直接 403（第一层门禁）。

### 3.2 客户端半侧（新增 `src/client/*` + `scripts/build-client.mjs`）

- 声明：`package.json` 加 `dsh.client: { platform: 'web' }`、`exports['./client'] = './lib/client.js'`；**`cordis.patch.yml` 不需要新增行**（现有根行 name 就是裸包名，半侧只挂根行）。
- 产物：`window.__ModuleLoader__.load({ id: 'dsh-gateway-mobile', factory: (require) => { … return module.exports } })` 的 lazy-CJS bundle，用 esbuild `format:'cjs'` + banner/footer 复刻（调研已在系统临时目录实测通过）。
- 运行时依赖只保留平台模块表里的 **`react` / `react/jsx-runtime`**（external，不打包）；`ctx.slots` / `ctx.locale` / `ctx.layout` / `ctx.remote` 都是 Cordis 注入服务，不 import 任何 DSH UI 包 → 跨版本漂移面最小。
- 样式：模块物化期插入 `<style>`（由模块系统认领、卸载时回收），使用 DSH `--dsw-alias-*` 语义 token；不引入第三方 UI 库。
- 图表/二维码：**不引入前端图表/QR 库**。二维码复用服务端 `qrcode` 生成的 `qrSvg`（现有 admin API 已返回）；趋势图用轻量 SVG 自绘或直接表格。
- 开发环：`build:client` 产物变化由 `dsh-client-hmr` 轮询（约 500ms）自动热替换，**无需重启 DSH**；改 `package.json` 才需要重启。

### 3.3 工作台信息架构（复用现有 7 个分区）

| 分区 | 本机 DSH UI（直连 3080） | 手机（经网关打开同一 UI） |
|---|---|---|
| 概览（网关/隧道/DSH/微信状态、能力矩阵、health、趋势） | ✅ 完整 | ✅ 只读、脱敏 |
| 配对（二维码 + 8 位码 + 有效期 + 重新生成 + 换域名横幅） | ✅ | ❌ 不展示可复用码/QR |
| 微信（扫码登录、pending 审批、推送策略、审批历史） | ✅ | ❌（仅状态摘要，可选后续放开） |
| 设备（列表/重命名/撤销/永久删除/清理） | ✅ | ❌（只显示自身设备摘要） |
| 日志 / 审计导出 | ✅ | ❌（可选脱敏尾部） |
| 设置（会话时长、配对 TTL、隧道/微信/日志/代理开关、密钥轮换） | ✅ | ❌ 只读摘要 |
| 帮助 / 诊断 | ✅ | ✅ 只读 |

页头保留：**“打开独立管理台”**（`http://127.0.0.1:3081/mobile/admin`，仅本机可点）、**“打开公网手机入口”**（`publicBase + /mobile`）。

---

## 4. 安全模型（本方案最关键的部分）

**事实**：经网关代理的手机请求到达 DSH 时，`Host`/`Origin` 已被改写为 loopback origin、Cookie 是网关替所有设备保管的 DSH owner Cookie。**DSH 自身无法区分“电脑直连”与“手机经代理”**，socket 对端也不可用（trust fence 只看 headers）。

**方案：双层门禁，全部 fail-closed。**

1. **网关代理层（第一层，最强）**
   在代理到 DSH 之前：若 `!info.local` 且路径命中 `/api/gateway-mobile/admin/` → 直接 403 JSON。手机即使拿到页面也调不动管理接口；本机直连不经过网关，天然放行。
2. **DSH 桥路由层（第二层，防绕过）**
   网关在所有转发请求上注入 `x-dsh-gateway-proxied: 1`（并在转发前剥离客户端自带的同名/`x-forwarded-*` 伪造头）；桥路由对 `admin/*` 的判定是 **“有该头 = 代理 = 拒绝写”**。
   - 手机无法删除该头（网关先剥离再强制写入）；
   - 本机恶意进程伪造该头只会**自我降权**，不构成提权。
   - 如需更强，可升级为进程内 HMAC（`HMAC(secret, deviceId|ts|path)`），属完整版增强项，MVP 不必。
3. **客户端 UI**：`ctx.remote.$host.isLoopback` 只用于**显示/隐藏**管理操作与链接，是提示不是安全边界；服务端永远重新裁决。

**二维码/配对码**：`cache-control: no-store`、不写日志、手机端不返回可复用码（只返回 `valid/expiresIn/used` 摘要，等价于现有公共 `pairing/status`）。

**独立管理台**：维持现有 loopback-only 语义，不因工作台上线而放宽。

---

## 5. 分期、验收与投入

| 阶段 | 内容 | 预估 | 验收 |
|---|---|---|---|
| **Phase 0（技术验证）** | `dsh.client` + esbuild 产线 + 一个 `main` 空页 + `sidebar.panellist` 图标 + 一条 `/api/gateway-mobile/read/ping` + 网关分类头 | **0.5–1 人日** | DSH 启动无错、侧栏出现图标、点开是工作台、`/plugins/dsh-gateway-mobile/client.js` 200、ping 200 |
| **Phase 1（只读 MVP）** | 概览、配对二维码/码（仅本机）、设备摘要、日志尾部、设置只读、帮助；双端只读；页头链接 | **2–3 人日** | 桌面全流程可用；手机只读、管理 403；独立监控台不受影响；`npm test`/`typecheck`/`integration-check`/`hmr-check` 全绿 |
| **Phase 2（完整版）** | 管理写操作（隧道启停、配对码重生、设备撤销、设置保存、密钥轮换）、微信扫码登录/审批、日志实时化（轮询→SSE）、完整 IA 与窄屏适配 | **3–5 人日增量** | 本机管理全功能；手机继续只读；二维码 `no-store` 校验 |
| **Phase 3（收口）** | 工作台成为主入口、独立台降级为兜底；中英文案；打包/发布/兼容矩阵/冒烟纳入 CI | 1–2 人日 | 发布 `0.2.0-next.0`（npm `next` tag）后跑 `npm run doctor` + 双端手工冒烟 |

**版本/工程决策**：

- 版本 **`0.2.0-next.0`**（新能力，不占用已污染的 0.1.4 分发物；发布走 `next` dist-tag，稳定后再 `0.2.0`）。
- `engines.dsh` 建议从精确 `0.2.2-rc.1` 放宽为 **`>=0.2.2-rc.1 <0.3.0`**（安装态用 `includePrerelease` 判定）；若希望更保守可保持精确锁版本，二选一。
- `tsconfig.json` 需 `exclude: ["src/client"]`（现有 `rootDir: src` 会误编译 JSX），新增 `tsconfig.client.json` 仅做类型检查；React 只进 `devDependencies`。
- `build` 串成 `build:server → build:client → build:web`；发布前断言 `lib/client.js` 存在且头尾格式正确（**缺 bundle 会让 DSH 客户端模块激活失败**）。
- `scripts/check-docs.mjs` 的版本正则需支持 `-next.N`；测试门槛（127 个 `node --test`）新增策略层单测（本机/远端能力集、分类头、CSRF、错误码）。

---

## 6. 风险与缓解

| 风险 | 概率/影响 | 缓解 |
|---|---|---|
| DSH 客户端 slot / 平台模块表随版本漂移 | 中 / 工作台入口消失或报错 | `engines.dsh` 范围；只依赖 `main` + `sidebar.panellist` 两个稳定表面；`slots.inject` 缺失时静默等待不抛错；升级冒烟纳入 CI |
| `dsh.client` 声明了但 bundle 未构建/未发布 | 中 / DSH 激活期直接失败 | 构建顺序 + 发布前脚本断言 + `files` 含 `lib` |
| 网关分类头被伪造 | 低 / 最多自我降权 | fail-closed 方向设计；完整版改 HMAC |
| 管理台与工作台双实现 | 中 / 长期维护成本 | 抽 `WorkbenchService`，独立台路由与工作台共用同一实现 |
| 手机误触管理操作 | 中 / 改坏隧道/设置 | 双层门禁 403 + UI 隐藏 + 二次确认 |
| 二维码/配对码泄露 | 中 / 未配对设备可接入 | `no-store`、不落日志、手机端不返回、管理仅本机 |
| 双端同一份 React 工作台显示在手机上 | 中 / 观感与信息密度 | 窄屏适配 + 按服务端 `readOnly` 隐藏管理区块 |
| 工作量 | 中 / 排期 | 先 Phase 0+1（约 3–4 人日）验证价值，再决定 Phase 2 |

---

## 7. 明确不做（本版本边界）

1. **不**用 iframe 嵌入现有 `admin.html`；**不**在 DSH 里复制一套并行 UI 逻辑。
2. **不**实现手机专用聊天/审批 UI（roadmap P2-1 仍暂缓，`/mobile/ws` 保持骨架）。
3. **不**走 typert/Remote（第三方需手写 strict 描述符与生成物，版本脆、成本高）；**不**走 HTTP 回环桥接；**不**走客户端跨源 fetch。
4. **不**扩大手机端远程能力：手机继续只有现有 `/status`、`/me`、自身设备操作与“经代理使用官方 DSH UI”；工作台只做**读取**。
5. **不**重写 `gateway.ts`、不迁移现有路由、不改 `:3081` 行为与 CSP。
6. **不**新增 profile Loader 行、不改 bundle patch 结构。

---

## 8. 已拍板事项（2026-11-10）

1. **形态**：✅ 方案 A —— `main` 整页面板 + `sidebar.panellist` 左栏入口，`PANEL_ID = "gateway-mobile-workbench"`。
2. **手机权限**：✅ 手机只读；配对码/二维码、隧道启停、微信扫码登录/审批、设置写入、密钥轮换仅本机。
3. **版本**：✅ `0.2.0-next.0` + npm `next` dist-tag；`engines.dsh` **继续精确锁定** `0.2.2-rc.1`（不改为范围）。
4. **节奏**：✅ Phase 0 已实现；Phase 1（配对/设备/日志只读 MVP）与 Phase 2（本机管理操作）按此文档继续。

> 后续把 Phase 1/2 拆成 `docs/next/implementation-plan.zh.md`（文件级任务、接口 DTO、测试清单），并按阶段实现。
