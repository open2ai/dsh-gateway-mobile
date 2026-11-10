# 更新日志

[English](./CHANGELOG.md) | [中文](./CHANGELOG.zh.md)

## 0.2.0 - 2026-11-11

工作台预览版：管理台能力开始进入 DSH Web UI。

- 新增 DSH 浏览器半侧（`dsh.client`、`exports["./client"]`、`lib/client.js`），由新增的
  `scripts/build-client.mjs` 构建；注册整页 `main` 面板 `gateway-mobile-workbench` 和左侧栏入口，
  与官方 Plugins/Schedules 页同构。
- 在 DSH Connection 服务上注册宿主桥路由（`ctx.connection.fetch.register`）：`read/ping`（桌面与手机
  均可用），以及仅本机的 `read/pairing`、`read/devices`、`read/logs`、`read/health`、`read/settings` 和
  `POST admin/pairing/regenerate`。同源、使用 DSH 浏览器会话认证，不再回环 HTTP 跳回网关。
- 网关给所有转发请求注入 `x-dsh-gateway-proxied`（并剥离调用方伪造的同名头），在代理前就拒绝工作台
  本地专属前缀，因此手机即使打开同一 UI 也拿不到配对码、设备、日志、设置或管理操作；DSH 桥再按同一
  信号 fail-closed 复核一层。
- 工作台 UI（Phase 1/2）：概览、配对（二维码 + 8 位码 + 重新生成 + 复制链接）、设备、日志、可编辑设置
  五个页签；概览还提供本机隧道操作（启动/停止/重连）。设置（会话时长、配对 TTL、隧道/微信开关、日志级别、
  代理超时）通过仅本机的 `POST /api/gateway-mobile/admin/settings` 保存；隧道操作走
  `POST .../admin/tunnel`。手机只看到概览。页面配色全部使用 DSH 语义主题 token
  （`--dsw-alias-label-*`、`--dsw-alias-bg-layer-*`、`--dsw-alias-border-*`、状态色），跟随 DSH 明暗主题。
- 设置按卡片分组：插件版本、隧道与配对（隧道/代理开关、会话时长、配对 TTL）、微信（通道 + 完成通知策略：
  合并窗口、单会话冷却、全局间隔、每小时上限）、日志。微信设置使用仅本机接口 `read/weixin` 与 `POST admin/weixin`。
- 新增「安全与维护」卡片：密钥状态与轮换（`read/keys`、`POST admin/key/rotate`）、OAuth 身份白名单编辑
  （`read/oauth`、`POST admin/oauth`，持久化到 `admin-settings.json`）、审计日志 JSON 导出（`read/audit`）。
  全部接口仍仅限本机。
- 微信扫码登录、pending 连接审批、退出登录与审批历史迁移到工作台（仅本机接口 `admin/weixin/login`
  GET/POST、`admin/weixin/approve`、`admin/weixin/logout`、`read/weixin/approvals`）。独立管理台保留为兼容入口。
- 工作台在设备与日志上与独立管理台对齐，独立管理页降级为兼容兜底而非必需入口。
- 设备页：筛选（全部 / 在线 / 已撤销过期）、重命名、撤销、全部撤销、永久删除与清理（仅本机接口
  `admin/devices/rename|revoke|delete|purge|revoke-all`），并显示每台设备的 OAuth 绑定。
- 日志页：关键字搜索、明确的条数（`共 N 条 · 显示 M 条`）、最新在前排序与自动刷新开关，全部收进标题工具栏
  一行，把高度留给日志列表；微信审批历史改为结构化条目而不是原始 JSON；审计导出收进工具栏的「导出审计」
  按钮，时间范围在弹窗里选择。
- 帮助页接管诊断：深度健康检查（`read/health`）、能力矩阵、本机回环延迟，以及诊断 JSON 的复制/下载，
  不再必须打开独立管理台；独立 `/diag` 页保留给手机端 HTTP/WebSocket 自检。
- 兼容开关：设置 → 安全与维护 → 独立管理台可关闭独立页面（关闭后页面返回 404，回环 API 仍可用），
  页头「打开独立管理台」链接同时隐藏。
- 工作台名称从「手机网关」改为「移动端网关」，页面标题、侧栏入口与文档同步。
- 配对页的「隧道地址已变化」横幅现在会自动消失：宿主返回 `repairedSinceChange`（地址变化后有新设备
  配对成功），并且支持按本次变化手动关闭（localStorage 记录）。
- 布局遵循 DSH 主面板页面契约：标题与页签固定，只有页签内容滚动；表格与日志按需保持单行。
- 版本号定为 `0.2.0`（原 `next` 预览版转正式）；`engines.dsh` 继续精确锁定 `0.2.2-rc.1`。
- 执行 `npm run build` 后需要重启一次 `dsh web`（DSH 会缓存客户端 bundle 清单直到重启）。

## 0.1.4 - 2026-11-09

本版本不升版本号，集中处理长期运行的安全与可维护性；所有改动保持现有 API 向后兼容（只新增字段/端点）。

- DSH 插件页不再直接渲染整篇 README，改为精简的详细介绍：新增 `locale/zh.json`、`locale/en.json` 的 `meta.title` / `meta.description` / `meta.detail`，以及 `docs/DETAIL.zh.md`、`docs/DETAIL.md`；中文界面默认显示中文。
- **微信 owner 信任边界**：扫码确认时记录 owner 哈希（不落完整微信 ID），默认只接受 owner 的消息与审批；新增 `weixin.allowOtherUsers` / `weixin.allowedUsers`；未授权发送者被拒绝并审计。旧凭证升级后按首条消息迁移 owner。
- **微信通道状态机**：`WeixinStatus` 新增 `state`（disabled/idle/connecting/connected/degraded/expired）、`lastPollAt`、`lastOkAt`、`failures`、`contextAgeMs`、`owner`；`-14` 连续两次才判定过期；context 30 分钟 TTL；发送失败分类（`weixinSendFailureReason`）。
- **消息可靠性**：微信入站按 `message_id` 去重；无待审批/待回答时 `Y/N/数字` 回复被拦截并提示；完成通知改发 owner context，失败分类、指数退避、永久失败可见。
- **配对连续性**：配对 payload 增加 `status`、`previousUrl`、`urlChangedAt`；管理后台在 URL 变化时显示重新配对横幅，配对码过期自动刷新。
- **认证收口**：新增 `auth.oauthAllowedUsers` 白名单（错误码 4010）；`secret-keys.json` 多密钥 + kid + `POST /admin/key/rotate` 轮换（旧 session/密文继续有效）；配对码不再明文进日志。
- **服务依赖**：`inject` 保留 `webServer`/`connection` 以及微信桥接与工作区解析必需的 `sessionController`/`workspaceRegistry`（Cordis 没有 optional inject 形式，`ctx.get()` 看不到未声明的同辈服务）；`userQuestions` 作为可选能力探测，能力矩阵展示实际解析结果。
- **运维**：`/health?deep=1` 分项健康检查（可选/必需区分，异常返回 503）；`GET /admin/audit` 过滤导出；`GET /admin/capabilities`；日志异步写入 + 按大小轮转；`npm run doctor` 自检脚本；`npm run hmr-check` HMR 冒烟脚本。
- **Named Tunnel**：真实 connector 健康检查（metrics `/ready`），超时标记 degraded 而不是假装 connected；URL 变化会记录并广播。
- **路由拆分**：网关 API 拆到 `src/routes/*`（public/session/devices/admin/weixin/oauth），`gateway.ts` 只保留请求准入、鉴权、静态资源、WebSocket 与代理编排。
- **PWA 构建版本与弱网**：`build:web` 生成 `web/assets/build.json`（内容哈希清单），网关在 HTML 中注入 `?v=<hash>`，`sw.js` 按构建版本自动生成缓存名与 shell 列表，不再手工 bump；GET 请求增加指数退避、online/offline 状态与离线/上次同步提示。
- **运行时开关**：设置页可在线开关隧道/微信、调整日志级别与 DSH 代理超时，立即生效并持久化到 `admin-settings.json`，重启后恢复。
- **审计跨重启**：`/admin/audit` 合并内存 ring 与 `gateway.log`（含 .1..N 轮转文件），可导出更早进程的审计记录。
- **文档与打包一致性**：新增 `npm run check-docs` 校验版本引用与分发包清单；`scripts/pack.mjs` 与 `package.json.files` 统一，zip 只包含与 npm 相同的文件。
- **精简概览**：概览 = 状态 chips（网关/隧道/DSH/微信）+ 异常/能力提示，KPI 4 卡、快捷操作与请求趋势图（7/14/30 天可切换）直接展示（去掉了「活动与统计」折叠头部）；能力矩阵、深度健康检查与隧道操作收进「帮助 → 诊断」；日志只在「日志」tab 展示。
- **文档中英双语**：`docs/` 下所有英文文档补齐 `*.zh.md` 中文版，文档顶部提供语言切换，新增 [docs/README.zh.md](docs/README.zh.md) 索引；README 增加文档入口。
- 管理后台：概览拆为“运行状态/活动”，微信 tab 分区，新增“帮助”tab，并接入 deep health、审计导出、密钥轮换与能力矩阵。

## 0.1.3 - 2026-11-05

- 适配 DSH `0.2.2-rc.1`，插件版本升级到 `0.1.3`。

## 0.1.2 - 2026-11-03

- 适配 DSH `0.2.1-rc.5`，插件版本升级到 `0.1.2`。

## 0.1.0 — 2026-10-23

DSH Gateway Mobile 插件的首个可用版本：回环网关 + Cloudflare Quick Tunnel，一次性设备配对、HMAC 会话 Cookie，以及 HTTP/WebSocket 反向代理。

包含管理后台与手机 PWA 页面（中/英、深浅主题），覆盖配对、设备撤销与永久删除、日志、设置、OAuth 绑定与连接诊断，附带 51 个自动化测试和真实 DSH 集成脚本。

- 新增微信 ClawBot/iLink 第一阶段通道：扫码登录、加密凭证持久化、长轮询接收、文本发送 API，以及管理后台“微信连接”面板。
- 新增微信 → DSH 第二阶段桥接：消息进入持久化的专用 DSH 会话，跟随已提交的 assistant 事件，并用入站 `context_token` 把最终文本回发微信。
- 新增 DSH 审批转发到微信：按 agent 过滤审批提示，显示随机审批 ID，支持回复 `允许 <id>` / `拒绝 <id>`，超时自动拒绝并保持 fail-closed。
- 新增入站微信图片：CDN 下载、兼容两种 AES-128-ECB key 编码、媒体类型识别，并作为 DSH 图片 prompt 附件提交。
- 微信扫码改为本机管理员确认：扫码确认后进入 pending 状态并显示脱敏账号，完整 `ilink_user_id` 不持久化也不写日志；只有点击“允许连接”才保存凭证并开始轮询。
- 新增跨会话微信完成通知：监听所有顶层 DSH 会话，5 秒合并、单会话 60 秒冷却、全局 15 秒间隔、默认每小时最多 30 条，跳过子会话和微信专用会话；无可用 `context_token` 时持久化待发队列。
- 新增管理后台“跨会话推送”开关和最近推送记录，状态持久化到 `weixin-notify-state.json`。
- 新增跨会话微信审批：独立每小时 60 条额度、独立审批历史、提示中带会话和工具信息；微信直接回复 `Y`/`N`（或“允许/拒绝”）即可，审批编号只做内部记录，不占用每小时 30 条完成通知额度。
- 完成推送默认节奏改为：合并 5 秒 / 单会话冷却 60 秒 / 全局间隔 15 秒 / 每小时 30 条。
- 新增完成推送节奏在线设置（合并窗口、单会话冷却、全局间隔、每小时上限），保存到 `weixin-notify-state.json`，保存后无需重启立即生效。
- 新增 `ask_user_question` 微信转发：单问题、多问题批次按顺序提问，支持选项序号、选项文本、多选、自定义文字和“跳过”。
- 新增 timed `ask_user_question` 迟到回答：前台等待超时后，微信稍后回复会通过 `userQuestions.answer(agent, callId, answer)` 补回仍存活的会话。
