# dsh-gateway-mobile 路线图

[English](./roadmap.md) | 中文

> 面向插件作者本人、单机自用场景。基线：插件 `0.1.4`（工作树中，含 `locale/` 与 `docs/DETAIL.*`），DSH `0.2.2-rc.1`。本文只讨论下一步可落地的改动，不重复已经实现的能力。

## 总体判断

插件已经过了“能不能用”的阶段：Quick Tunnel、一次性配对、设备会话语义、DSH 反向代理，以及微信的登录、桥接、审批、提问和完成通知都有实现和自动化测试，0.1.4 又把 DSH 插件页的中英文介绍补齐。真正的瓶颈转到了“长期挂着会不会出事”：微信侧没有发送者信任边界，通道状态和 `context_token` 过期只能从日志猜；Quick Tunnel 换域名后手机只能重新配对；认证层缺少 OAuth 白名单和密钥轮换；`inject` 把 DSH 的可选服务写成了硬依赖，一次 DSH 升级就可能让整个插件不加载。建议 0.1.5 只做不改 API 的安全/稳定性补丁，0.2.0 再收口可维护性和手机端体验；独立聊天 UI、多用户暂不作为目标。

## 优先级说明

- **P0**：不做会出事，或会让后续每次改动都更贵。
- **P1**：日常使用能明显感知的体验与可运维性。
- **P2**：形态选择，先验证 DSH 能力与自己的真实需求再投入。

## 现状与不在本文范围

已经可用、本文不再列为“待做”的部分：Quick Tunnel 生命周期与重连、一次性配对与设备撤销/过期、HMAC 会话与滑动续期、DSH HTTP/WS 反向代理、管理后台六个分区、手机 PWA 页面、GitHub/Gitee OAuth 绑定、微信扫码登录与加密凭证、文本/图片桥接、审批与提问转发、timed 提问迟到回答、跨会话完成通知及其节奏设置、请求统计、i18n 与主题。

明确不在本路线图内：绕过 DSH 审批或沙箱、把 DSH 端口直接暴露公网、依赖未公开的 DSH Remote REST/内部协议、在插件内实现第二套模型/会话存储。任何一项都需要先推翻现有安全模型，收益不足以抵消风险。

## P0 稳定性 / 安全 / 可维护性

### P0-1 微信发送者信任边界

- **问题**：`WeixinChannel.#acceptMessage()` 对任何 `from_user_id` 都回调桥接层，`WeixinBridge.handle()` 直接把消息当 prompt 交给 DSH；`WeixinNotifier.flush()` 用的是 `channel.lastInbound`（最后一条入站消息），而不是“绑定 Bot 的那个微信号”。结果是：任何能给 Bot 发消息的微信用户都能驱动 DSH 会话、参与审批，完成通知也可能发给错误的人。当前凭证文件里没有 owner 字段。
- **方案**：在 `approveLogin()` 时记录 owner，完整 ID 只留在内存，磁盘写 HMAC/SHA-256 指纹；`#acceptMessage()` 对非 owner 默认拒绝并回一句“未授权”，配置增加 `weixin.allowOtherUsers`（默认 false）与可选的 `allowedUsers`；`contexts` 改为 `{ token, at }` 并只向 owner 的 context 发送通知；旧凭证没有 owner 时，升级后的第一条入站消息视为 owner 并记审计，后台显示脱敏账号与“重新绑定”入口。
- **改动面**：中（`src/weixin.ts`、`src/weixin-bridge.ts`、`src/weixin-notifier.ts`、`src/config.ts`、`src/gateway.ts`、`web/src/admin.ts`）。
- **风险**：可能把家人或自己的小号挡在外面；迁移逻辑必须只在“无 owner”时生效一次，并给出清晰的后台提示。

### P0-2 微信通道状态机与 context_token 生命周期

- **问题**：`#pollLoop()` 遇到 `ret=-14` 直接删凭证、停止轮询，只能重新扫码；其他失败只有 `failures` 计数和 2s/30s 固定退避，管理员只能从 `lastError` 猜状态。`sendText()` 失败不区分 token 过期、网络错误和服务端拒绝；`contexts` 没有时间戳，通知可能拿着很旧的 token 反复重试。iLink 的长轮询本身也不稳定，断线重连与状态可见性目前是黑盒。
- **方案**：把 `WeixinChannel` 改成显式状态机（`connected` / `degraded` / `expired`），只在连续两次 `-14` 后才清凭证；`status()` 增加 `lastPollAt`、`lastOkAt`、`failures`、`contextAge`；发送失败分类，token 类错误标记 context 失效并在后台提示“给 Bot 发一条消息刷新”；后台提供“重新登录”；通知重试改为指数退避，并且只用 owner 的有效 context。
- **改动面**：中（`src/weixin.ts`、`src/weixin-notifier.ts`、`src/gateway.ts` 的 `/admin/weixin`、`web/src/admin.ts`）。
- **风险**：iLink 的错误码与 `-14` 语义没有公开文档，token 过期条件需实机验证（**需验证**）；不要把临时网络错误当成登出。

### P0-3 公网入口与配对连续性

- **问题**：Quick Tunnel 每次重启都换域名，浏览器 Cookie 按 host 隔离，手机必须重新配对；当前只在 `gateway.log` 和 `/mobile/ws` 广播状态，手机端并不知道新地址。配对码 TTL 到期后 `PairingManager` 不会自动续发，`status()` 只是 `valid:false`，后台不点“重新生成”就一直失效。`tunnel.mode: 'named'` 只拼了 `--token run`，URL 靠固定 `sleep(1200)` 假定成功，没有连接器健康判断。
- **方案**：(a) 隧道 URL 变化时生成新配对码，若微信 owner context 可用则推送“新地址 + 一次性配对链接”，做成可配置开关；(b) 管理后台在配对码过期且页面可见时自动调用 `POST /admin/pairing/regenerate`，或至少把“已过期/刷新”做成显式状态；(c) 概览页在 URL 变化时显示常驻提示和二维码；(d) Named Tunnel 增加真实健康检查（cloudflared metrics/connector 状态），补齐 `tunnel.domain` 与 `gateway.publicUrl` 的校验和配置文档，去掉固定 sleep。
- **改动面**：中（`src/tunnel.ts`、`src/pairing.ts`、`src/gateway.ts`、`web/src/admin.ts`，以及复用 `src/weixin.ts` 的发送能力）。
- **风险**：把配对链接推到微信等于把入口交给微信账号，必须默认关闭、短 TTL、一次性并记审计；Named Tunnel 需要真实域名和 Cloudflare 账号，无法完全用单测覆盖（**需验证**）。

### P0-4 认证与设备安全收口

- **问题**：`auth.requireOAuth` 只要求绑定“任意” GitHub/Gitee 账号，没有账号白名单，第二因子近似于“注册即可”。`secret.key` 一把密钥同时签会话和加密微信凭证，没有版本号或轮换流程，换钥等于所有设备静默失效。配对码被 `PairingManager.issue()` 和 `src/index.ts` 启动日志明文写进 `gateway.log`，导出日志或诊断包会泄露仍然有效的码。审计只有内存 100 条加 JSONL 文件，后台只有关键词搜索，没有按 action 的稳定筛选和导出；配对锁定键是 `IP|UA`，换 UA 就能重置计数（8 位码空间仍然很大，但策略不严谨）。
- **方案**：新增 `auth.oauthAllowedUsers`（provider + login/userId），绑定和后续校验都检查；`secret.key` 加 `kid`（版本前缀，旧钥保留解密、新签发用新钥），后台“轮换密钥”需二次确认并提示设备要重新配对；日志里配对码只保留后两位或哈希；增加 loopback-only 的 `GET /admin/audit?action=&since=` 导出；配对锁定改为纯 IP 加递增延迟。
- **改动面**：中（`src/config.ts`、`src/oauth.ts`、`src/devices.ts`、`src/store.ts`、`src/sessions.ts`、`src/pairing.ts`、`src/gateway.ts`、`web/src/admin.ts`）。
- **风险**：白名单配错会把自己锁在外面，需要文档和回环应急说明；密钥轮换是破坏性操作，必须显式确认并先备份数据目录。

### P0-5 只把真正必需的服务声明为依赖

- **问题**：`src/index.ts` 的 `inject = ['webServer', 'connection', 'sessionController', 'workspaceRegistry']`。Cordis 4 的 `inject` 数组全是必需依赖（`registry.d.ts` 的 `Inject` 只有数组/拦截配置两种形式，没有 optional 语义），任一服务在 DSH 新版本被改名或移除，插件整体加载失败，连回环网关和配对页都不启动。而 `WeixinBridge`、`WeixinNotifier` 本身已经能容忍 `controller` 缺失。
- **方案**：`inject` 只保留 `webServer`、`connection`；`sessionController`、`workspaceRegistry`、`userQuestions` 用 `ctx.get()` 读取并在启动时做能力探测；`/status` 和后台概览输出能力矩阵（controller / workspace / userQuestions / weixin），缺失时微信桥接降级并显示原因；`scripts/integration-check.mjs` 增加“缺少可选服务”的 profile 变体。
- **改动面**：小-中（`src/index.ts`、`src/gateway.ts`、`web/src/admin.ts`、`scripts/integration-check.mjs`）。
- **风险**：`ctx.get` 对未声明服务的可见性与时序需要验证（**需验证**）；静默降级会让人以为功能坏了，所以能力状态必须在后台显式可见。

### P0-6 兼容性验证：DSH 升级与 HMR

- **问题**：每次 DSH 升级只改 `engines.dsh` 再跑单测，真实集成检查 `scripts/integration-check.mjs` 靠手动执行；link 安装下的 HMR/重载没有冒烟测试。插件持有 3081 端口和 cloudflared 子进程，HMR 重载窗口里若旧 disposer 未跑完或子进程未退出，可能出现 `EADDRINUSE` 或孤儿 cloudflared（**需验证**：`ctx.effect` 的异步清理在重载时是否被等待）。
- **方案**：把集成检查拆成 `smoke`（现有流程）和 `capability`（可选服务缺失、微信未配置、`tunnel.enabled:false` 三种 profile）；新增 `scripts/hmr-check.mjs`：启动 dsh web 并 link 插件，touch `lib/index.js` 触发重载，断言端口仍可用、只有一个 cloudflared、旧 WS 已关闭；发布清单记录已测的 DSH 版本矩阵。
- **改动面**：小（`scripts/`、`docs/development.md`、`package.json` scripts）。
- **风险**：HMR 行为本身依赖 DSH 版本（**需验证**）；Windows 下子进程树要用 `taskkill /T`，脚本里已有先例。

### P0-7 网关可维护性与日志保留

- **问题**：`src/gateway.ts` 已 1372 行、40 多个内联路由分支，加一个后台接口要同时改路由、鉴权白名单和前端。`src/logger.ts` 对每条日志 `appendFileSync`，`gateway.log` 无上限增长；`maxEntries` 只限制内存环，排查问题时既难读，长跑也可能阻塞请求。
- **方案**：把路由拆成 `src/routes/{pairing,devices,weixin,admin,oauth,session}.ts` 加一张 `Router` 表（路径、方法、local-only、CSRF、handler），`gateway.ts` 只保留 Host/Origin/auth/proxy 编排；日志改为异步写队列加大小轮转（例如 5MB × 3，配 `log.retentionDays`），配对码脱敏；新增 loopback-only 的 `GET /mobile/api/v1/admin/diagnostics`，返回版本、能力矩阵、隧道/微信状态、最近错误和日志尾部，后台提供“导出诊断包”。
- **改动面**：中（`src/gateway.ts` 拆分、`src/logger.ts`、`web/src/admin.ts`、`test/`）。
- **风险**：路由拆分容易漏掉鉴权，必须用现有 `gateway.test.js` 回归并补“非 loopback 访问 admin”的用例；诊断包必须脱敏，不含 token、配对码和微信 ID。

## P1 体验增强

### P1-1 弱网、离线与 PWA 更新

- **问题**：手机端 `web/src/app.ts` 每 15 秒轮询，失败只弹 toast；`shell.ts` 12 秒后无条件隐藏 loading，iframe 失败没有后续动作；`sw.js` 的缓存清单和页面 `?v=` 全靠手工 bump（`docs/development.md` 已写明），改前端忘了 bump 会让已安装 PWA 继续跑旧代码。
- **方案**：`web/src/common.ts` 增加连接状态和指数退避，监听 `online/offline`；`app.ts` 显示“上次同步时间/离线”而不仅是 toast；`shell.ts` 在超时后提供重试与诊断入口；`scripts/build-web.mjs` 生成 `web/assets/manifest.json`（文件名 + hash），页面由服务端注入 `?v=`，`sw.js` 的 `CACHE` 用构建号；状态变化加 `aria-live`。
- **改动面**：小-中（`web/src/common.ts`、`app.ts`、`shell.ts`、`web/sw.js`、`scripts/build-web.mjs`、`src/gateway.ts` 静态注入）。
- **风险**：Service Worker 策略改动可能造成白屏，保留 `skipWaiting` 与回退说明；注入逻辑要兼容直接打开 `web/` 调试。

### P1-2 消息可靠性

- **问题**：入站没有按 `message_id` 去重，长轮询重放会产生重复 prompt 或重复审批提示；没有 pending 审批时回复 `Y`/`N`、没有提问时回复 `1`，会被 `WeixinBridge.handle()` 当作普通消息发给 DSH，产生无意义回合；通知发送失败只回队列，没有区分永久失败（token 失效）和临时失败。
- **方案**：`WeixinChannel` 用最近 N 条 `message_id` 的 LRU 去重；`handleApprovalReply`/`handleQuestionReply` 在无 pending 时回一句“当前没有待审批/待回答”，不再入队；`sendText` 增加错误分类和一次幂等重试（`client_id` 由内容与消息 ID 派生）；通知 outbox 记录 `attempts/lastError`，永久失败进“未送达”列表并在后台可见。
- **改动面**：小（`src/weixin.ts`、`src/weixin-bridge.ts`、`src/weixin-notifier.ts`、`web/src/admin.ts`）。
- **风险**：去重窗口过小仍会重放，过大占内存；过滤 `Y` 可能误伤用户真想发的单词，用“仅在最近有 pending 时拦截”降低误伤。

### P1-3 健康检查与指标

- **问题**：`/health` 永远返回 200 `ok:true`，隧道断开、DSH 不可达、微信 token 失效都看不出来；`stats.json` 只有按天/按设备请求数，没有代理 5xx、WS 连接数、隧道重连次数、微信发送失败数，后台图表无法定位问题。
- **方案**：`/health?deep=1`（或 `/health/ready`）返回分项状态，degraded 时 503；`StatsStore` 增加计数器并保留 30 天；概览页增加“错误/重连”趋势和“最近失败”列表；`/status` 输出 `checks` 数组。
- **改动面**：中（`src/gateway.ts`、`src/stats.ts`、`web/src/admin.ts`、`docs/api.md`）。
- **风险**：外部监控可能把 deep 检查当 liveness，文档要区分 liveness/readiness；计数器命名发布后不要改。

### P1-4 管理后台信息架构与文档入口

- **问题**：后台 6 个 tab 里“概览”同时放隧道、微信、KPI、图表和日志，窄屏下密度过高；微信 tab 同时承担登录、换绑、推送策略和审批历史；没有“帮助/关于”入口，`docs/DETAIL.zh.md` 只出现在 DSH 插件页，排障仍要回仓库翻文档。管理后台必须保持 loopback-only，不能为了手机访问把它暴露到隧道。
- **方案**：概览拆成“运行状态（隧道/微信/DSH/能力矩阵）”和“活动（图表/最近日志）”；微信 tab 做二级分区（连接 / 推送 / 审批）；新增只读“帮助”tab，内容取自 `docs/DETAIL.zh.md` 加常见故障（配对失败、隧道未连、微信无 context）和配置项链接；窄屏用折叠卡片代替横向表格；手机端只通过 `/mobile/` 提供设备自身状态和诊断入口。
- **改动面**：中（`web/admin.html`、`web/src/admin.ts`、`web/assets/admin.css`、`docs/DETAIL.*`）。
- **风险**：纯前端改动容易与后端字段漂移，先复用现有 API；帮助内容要版本化，避免又多一处不同步。

### P1-5 安装与升级体验

- **问题**：`engines.dsh` 精确匹配加 Node >= 24，升级 DSH 时插件可能直接不加载，但没有自检脚本；`package.json` 的 `files` 只带 `docs/DETAIL.*`，而 `scripts/pack.mjs` 打包整个 `docs/`，npm 版与 zip 版内容不一致；`docs/architecture-flow.md` 还写插件 0.1.1/DSH 0.2.1-rc.4，`docs/api.md` 示例是 0.1.0，`docs/deviations.md` 写 0.2.1-rc.2。
- **方案**：新增 `scripts/doctor.mjs`（Node/DSH 版本、cloudflared 版本与哈希、3081 端口占用、dataDir 可写、profile 行存在、能否换取 DSH cookie），输出可复制的诊断；`package.json` 增加 `npm run doctor`；统一 `files` 与 pack 清单；新增 `scripts/check-docs.mjs` 校验文档版本引用与 `package.json`/`engines` 一致；补 `docs/upgrade.md`。
- **改动面**：小（`scripts/`、`package.json`、`docs/`）。
- **风险**：doctor 读取 DSH 安装版本的方式依赖包布局（**需验证**）；检查脚本过严会卡发布，默认 warning，`--strict` 才失败。

### P1-6 运行时开关与配置生效

- **问题**：后台目前只能在线改会话时长、配对 TTL 和微信推送节奏；`tunnel.enabled`、`weixin.enabled`、`proxy.requestTimeoutMs` 等仍要改 profile 并重启。用户临时想“关掉公网入口”或“暂停微信”时，最直接的动作是杀进程，而不是在后台点一下。`admin-settings.json` 已有持久化骨架，但只覆盖 `auth` 两项。
- **方案**：把可在线调整的字段扩展成白名单（`tunnel.enabled`、`weixin.enabled`、`weixin.notify.enabled`、`log.level`、`proxy.requestTimeoutMs`），沿用 `SettingsStore` 的校验与持久化；改动立即作用于内存中的 `config` 对象，并在重启后由 `applyToConfig` 恢复；后台标注“需要重启”的字段，避免误以为全部热生效。注意 `tunnel` 开关要调用 `TunnelManager.start()/stop()`，不能只改标志位。
- **改动面**：中（`src/settings.ts`、`src/gateway.ts`、`src/index.ts`、`web/src/admin.ts`）。
- **风险**：热改配置会让“当前生效值”和“profile 值”分叉，必须在后台同时显示两者；`SettingsStore` 的校验范围要和 `normalizeConfig` 保持一致，避免保存了启动时被拒绝的值。

## P2 长期形态

### P2-1 独立手机聊天/审批界面

- **问题**：`/mobile/ws` 仍是骨架（`chat.send`、`approval.respond` 返回 `1008`），手机实际打开官方 DSH UI；弱网下官方 UI 的重连和移动端布局不受插件控制。微信侧已经打通 `sessionController.follow`、`approval/request`、`user-questions/request` 和 `userQuestions.answer`，这套管线可以复用。
- **方案**：新增 `src/mobile-session.ts`，把 `chat.send` 映射到 `controller.prompt`、`approval.respond` 接现有审批事件、`status.get` 复用 `sessionController.list`；`/mobile/ws` 增加 `resume(cursor)` 与背压；前端新增 `web/src/chat.ts`，只做会话列表、消息流和审批卡，保留“打开完整 DSH UI”入口。
- **改动面**：大（`src/ws.ts`、`src/gateway.ts`、新模块、`web/`）。
- **风险**：与官方 UI 重复、维护成本高；Quick Tunnel 的并发与无 SSE 限制仍在。建议先做“审批/提问”小闭环，再决定是否做完整聊天。

### P2-2 多设备 / 多用户

- **问题**：当前所有设备共享同一个 DSH owner 身份，`maxDevicesPerUser:10` 只是设备数限制，无法区分家人或同事的权限；真正的多用户需要 DSH 的非 owner peer 与 Remote 访问控制。
- **方案**：先做网关侧“设备级最小权限”（只读设备、仅审批设备）通过路由白名单实现，不改变 DSH 身份；再评估 DSH `remoteAccess` / peer 模型（`@deepseek-ai/dsh-api-remote-access`）能否给非 owner 会话授权，`connection` 与 `sessionController` 是否暴露 peer 身份需验证。文档明确当前是单用户模型。
- **改动面**：大（`src/devices.ts`、`src/sessions.ts`、`src/proxy.ts`、`src/gateway.ts`，依赖 DSH 能力）。
- **风险**：网关侧“只读”很难覆盖 DSH 全部 API，漏一条写接口就破防；DSH peer 能力尚未稳定（**需验证**），不要承诺多用户。

### P2-3 隧道 provider 抽象与稳定入口

- **问题**：`src/tunnel.ts` 把 Quick Tunnel 的进程管理、URL 解析和重连写死，Named Tunnel 只是 `--token run` 占位；长期自用要么忍受域名漂移，要么自己配反向代理。
- **方案**：抽出 `TunnelProvider` 接口（start/stop/status/publicBase/health），`quick` 与 `named` 两个实现；Named 增加连接器健康检查（cloudflared metrics 端口）和域名/DNS 检查清单；保留 `tunnel.enabled:false` + `gateway.publicUrl` 给自建反代；Tailscale/FRP 只作为第三方 provider 评估，不放进核心包。
- **改动面**：中（`src/tunnel.ts` 拆分、`src/config.ts`、`docs/configuration.md`）。
- **风险**：Named Tunnel 需要真实 Cloudflare 账号和域名，自动化只能 mock（**需验证**）；provider 接口过早抽象会返工，先完成两个实现再定接口。

### P2-4 国际化与可访问性

- **问题**：手机页有 zh/en 内联字典，admin 目前是 zh-CN 操作界面（`docs/admin-console.md` 明确），`web/src/common.ts` 的字典与 `src/errors.ts` 的消息是两套；配对页、模态框和审批卡没有系统化的键盘/读屏/对比度检查。
- **方案**：抽出共享词表（`web/src/i18n.ts` 或构建期 JSON），admin 复用；错误消息从 `errors.ts` 单源生成前端字典；为配对页、审批卡、模态框补焦点管理与 `aria-*`；用 `prefers-reduced-motion` 降级动画；在 `docs/` 记录 a11y 检查清单。
- **改动面**：中（`web/src/common.ts`、`web/src/admin.ts`、`src/errors.ts`、CSS）。
- **风险**：词表迁移会漏 key；admin 英文化后中文文案审校成本上升，可先覆盖高频界面。

## 待验证清单

以下结论依赖 DSH 或 iLink 的外部行为，落地前应先用最小脚本验证，不要直接写进实现假设：

- Cordis `ctx.get()` 对“未在 `inject` 中声明”的服务是否可见、何时可见。
- DSH HMR 重载时 `ctx.effect` 的异步 disposer 是否被等待，3081 端口是否立即释放。
- iLink `getupdates` 的 `ret=-14` 是否只表示登录失效，是否存在可恢复的 token 过期错误码。
- cloudflared 是否提供稳定的本地 metrics/connector 健康端点，可用来替代 Named Tunnel 的固定 sleep。
- DSH web profile 是否向插件暴露非 owner peer 身份（多用户方案的前提）。
- 从插件进程内读取 DSH 实际版本的可靠方式（doctor 与兼容提示都要用）。

## 验收口径

每条方向落地时至少带三样东西：一条自动化测试（或 `scripts/integration-check.mjs` 的分支）、后台可见的状态或错误、以及 `docs/` 里一段可执行的说明。缺任何一样，就先不做。

## 0.1.4 已落地（2026-11-09，版本号保持不变）

本轮把原计划的补丁项与大部分"下一版"项一次做完，均向后兼容（只增字段/端点）：

- **P0-1** owner 信任边界（含 `allowOtherUsers`/`allowedUsers`、legacy 迁移审计）
- **P0-2** 微信通道状态机与 context_token 生命周期、发送失败分类
- **P0-3** 配对码自动刷新、隧道 URL 变化横幅、Named Tunnel metrics `/ready` 健康检查
- **P0-4** `auth.oauthAllowedUsers` 白名单、`secret-keys.json` 多密钥 + `/admin/key/rotate`、配对码日志脱敏、`/admin/audit` 导出
- **P0-5** `inject` 只保留必需服务 + 能力矩阵
- **P0-6** `npm run hmr-check` 冒烟脚本（无 dsh 时跳过）
- **P0-7** 路由拆分到 `src/routes/*`、日志异步写入与大小轮转
- **P1-1/P1-2**：消息去重与误回复拦截、GET 指数退避与 online/offline 状态、PWA 构建期 hash（`build.json`）、`sw.js` 自动缓存版本、app/shell 弱网提示
- **P1-3** `/health?deep=1` 分项健康
- **P1-4** 后台 IA：运行状态/活动拆分、微信三区、帮助 tab
- **P1-5** `npm run doctor`、`npm run check-docs`、`scripts/pack.mjs` 与 `package.json.files` 统一、文档版本引用修正
- **P1-6** 运行时开关：隧道/微信/日志级别/代理超时的在线读写与启动恢复
- **P0-4 补充**：审计导出跨重启回读（内存 ring + JSONL 轮转文件）
- **P2-3** Named Tunnel 健康检查与 degraded 语义

## 剩余建议范围

### 0.1.5（可选补丁）

- **P0-4 收尾**：配对锁定改为纯 IP + 递增延迟（当前仍是 `IP|UA`）。
- **日志量优化**：审计导出目前同步读 `maxFiles+1` 个文件，可改流式读取。
- **P1-2 收尾**：离线队列/待发消息（当前只有读请求退避，没有离线发送）。

### 0.2.0（一个迭代）

1. **P2-1** 完整手机聊天/审批 UI（先观察官方 DSH UI 在手机上的实际体验）。
2. **P2-2** 多用户：等 DSH peer/`remoteAccess` 在 web profile 稳定后再评估。
3. **P2-4** admin 全量英文化：先覆盖配对、审批、错误提示三类高频文案。
4. **P2-3 收尾**：Tailscale/FRP 等第三方 provider 评估（不放进核心包）。
