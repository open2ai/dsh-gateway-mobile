# 开发

[English](./development.md) | 中文

```powershell
npm install
npm run build             # tsc: src/*.ts -> lib/*.js; esbuild: web/src/*.ts -> web/assets/*.js
npm test                  # 先构建，再跑 117 个测试
npm run test:integration  # 真实 dsh web + 临时 profile（需要 dsh 在 PATH）
npm run check-docs        # 版本/文档/分发包清单一致性检查
npm run pack              # 先构建，再生成 dist/dsh-gateway-mobile-<version>.zip
```

## 手机资源缓存失效

手机页与管理页由 service worker（`web/sw.js`）支撑。版本号现在是生成出来的，不再手工维护：

- `npm run build:web` 会为每个生成的 bundle 和稳定的 CSS 文件计算哈希，并写入
  `web/assets/build.json`（`{ version, generatedAt, assets: { "admin.js": "ab12cd34", … } }`）。
  该文件被 git 忽略。
- 网关会把每个返回的 HTML 中 `/mobile/assets/<file>` 引用重写为
  `?v=<build.json 中的内容哈希>`，因此即使页面的硬编码 `?v=` 没改动，重建后的 bundle
  也会被重新拉取（manifest 缺失时 URL 保持原样）。
- `web/sw.js` 在 install 时拉取 `build.json`，用联合版本号命名缓存，并从带哈希的资源 URL
  派生 precache 列表；manifest 拉取失败时回退到一份小的静态列表。
- 不需要提交 `web/assets/*.js` 下的任何内容；修改 CSS 或 HTML 仍需执行构建
  （`npm run build`）让哈希变化。

## 插件页介绍

DSH 的**插件**页展示包声明的长描述：存在 `locale/<语言>.json` 中的 `meta.detail` 时优先
使用它，否则回退到包 README。本仓库使用 `docs/DETAIL.zh.md` 与 `docs/DETAIL.md`，让插件页
保持简短、可控，而不是渲染整篇 README。同一 locale 文件中的 `meta.title` 与
`meta.description` 用于插件卡片标题/描述。修改介绍时请编辑这两个文档，并保持
`locale/zh.json`、`locale/en.json` 中声明的路径同步；发布包的 `package.json` `files`
列表必须包含 `locale/` 与 `docs/DETAIL*.md`。

## 目录结构

```
src/        TypeScript 插件模块（config、tunnel、pairing、auth、proxy、gateway、oauth、ws）
src/routes/ HTTP 路由模块（public、session、devices、admin、weixin、oauth）+ router
lib/        `npm run build` 生成的 JS（git 忽略）
web/src/    TypeScript PWA 源码（admin、pair、app、devices、oauth、diag、shell、common）
web/assets/ 生成的浏览器 bundle + 稳定 CSS
test/       node:test 测试套件 + 模拟 DSH 上游
scripts/    集成检查、前端构建、打包、doctor/check-docs/hmr-check
pre_docs1/  原始产品文档（需求意图的参考来源）
docs/       架构、API、安全、配置、管理后台、开发文档（中英双语）
```

## TypeScript

前后两部分都启用严格模式：`src/*.ts` 与 `web/src/*.ts` 以 `strict`、`noImplicitAny`、
`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 编译；没有 `// @ts-nocheck`、
没有类索引签名、没有显式 `any`。领域模型、Node HTTP/stream 与浏览器 DOM 边界都有类型；
动态 JSON 在边界处校验为 `unknown`/`Record<string, unknown>`。`npm run typecheck` 会跑
两个编译器且不产出文件。

## 一致性检查：check-docs

```powershell
npm run check-docs            # 人类可读的 ✅/⚠/❌ 报告
node scripts/check-docs.mjs --json
```

`check-docs` 会校验 `package.json`（`version`、`engines.dsh`、`engines.node`）、README 的
状态行与 Node/DSH 要求、CHANGELOG 的首个版本、`docs/DETAIL*.md`、`docs/api.md` 中的
`version`/`gatewayVersion` 示例，以及 `docs/architecture-flow.md` / `docs/deviations.md`
中的版本引用是否一致。它还会检查 `scripts/pack.mjs` 是否从 `package.json.files` 派生分发
清单，以及 package 清单是否包含 bundle patch、LICENSE 与 DETAIL 文档。出现 ❌ 退出码为 1；
⚠（例如首次构建前缺少 `lib/`）不影响退出码。

## 诊断：doctor

```powershell
npm run doctor                       # 人类可读的 ✅/⚠/❌ 报告
npm run doctor -- --json             # 机器可读 JSON
npm run doctor -- --strict           # 警告也算失败（退出码 1）
node scripts/doctor.mjs --json --strict
```

`doctor` 是只读的。它会检查 Node.js 版本是否符合 `engines.node`、DSH CLI 版本是否符合
`engines.dsh`、cloudflared 是否可用（PATH、`CLOUDFLARED_PATH`、`tunnel.binaryPath` 或
数据目录缓存）、配置的网关端口、dataDir 是否可写、DSH profile 是否链接了本插件，以及
密钥材料是否存在。它从不打印 token、配对码或密钥内容。每项发现都带修复建议；任意 ❌
退出码为 1，`--strict` 时 ⚠ 也返回 1。配置端口从链接 profile 的 `cordis.patch.yml` 尽力
读取，默认 3091；`DSH_HOME` 与 `DSH_GATEWAY_DATA_DIR` 可覆盖 DSH home/数据目录的位置。

## 诊断：热重载检查

```powershell
npm run build                        # hmr-check 需要 lib/ 已存在
npm run hmr-check                    # dsh 不在 PATH 时跳过并退出 0
npm run hmr-check -- --strict        # 缺少 dsh 时退出 1 而不是跳过
$env:DSH_BIN = '<dsh-install>\lib\bin.js'
node scripts/hmr-check.mjs
```

`hmr-check` 会创建一个一次性 DSH home（`.dsh-hmr-check`），从随包 `web` 模板初始化一个
`gwtest-hmr` profile，链接本仓库，并用 `tunnel.enabled: false` 在空闲回环端口启动
`dsh web`。随后等待网关 `/health`，touch `lib/index.js`，最多等 30 秒让宿主重新应用插件
（通过 deep-health 的 `startedAt` 变化，或短暂不健康后恢复来观察），并断言 `/health` 仍然
正常、网关端口只有一个监听者。退出时杀掉子进程树（Windows 用 `taskkill /T /F`）；设置
`KEEP=1` 可保留临时 DSH home 以便检查。

这两个脚本是可选的开发工具，不属于 `npm test`。缺少 cloudflared 或网关未启动会报告为 ⚠
而不是 ❌，以便 `doctor` 在第一次启动前也能使用。
