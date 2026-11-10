# DSH Web UI 集成可行性研究：把网关监控台变成 DSH 内“工作台”

> 研究范围：DSH **0.2.2-rc.1（安装态，唯一权威）** 是否/如何让第三方插件 `dsh-gateway-mobile` 在 DSH Web UI 内提供“工作台”页面，并给出可落地的接入配方、安全语义与风险。
> 工作方式：只读分析；未运行 `npm install` / 仓库 `npm run build`；未修改 `lib/`、`web/`、`package.json`；未重启 DSH。唯一写入的仓库文件是本文件。构建格式的复刻验证在系统临时目录完成（见 §2.4，不涉及仓库构建）。

路径简写（下同）：

- `$INSTALL` = `E:\soft\setup\node-v22.20.0-win-x64\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`
- `$SRC` = `E:\workspace\github_project\AI\dsh_sources_code\deepseek-harness`（源码/文档快照 v0.2.1-rc.5）
- 仓库 = `F:\ai_workspace\dsh-gateway-mobile`（分支 next，版本 0.1.4）

---

## 0. 结论摘要（TL;DR）

| 问题 | 结论 | 关键证据/代价 |
|---|---|---|
| 第三方 profile 插件能否带浏览器半侧？ | **能**。机制成熟且是官方公开契约：`package.json` 声明 `dsh.client{platform:'web'}` + `exports["./client"]`，宿主把它组合进 `window.__DSH_BOOT__` 并从 `/plugins` 提供 bundle | `$INSTALL/dsh-client-modules/lib/index.js:781-800`（扫描/校验）、`:516-537`（注入 loader facade）；`$SRC/docs/cookbook/adding-a-settings-card.zh.md:56-72` |
| 浏览器 half 的产物格式？能否在仓库外复刻？ | **能**。产物是 lazy-CJS 包装：`window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => { var module={exports:{}}; ...; return module.exports; } })`。用 esbuild `format:'cjs' + bundle + external(平台表) + banner/footer` 可精确复刻；本机临时目录已实测输出格式与语法（§2.4） | 安装态样本：`$INSTALL/dsh-client-ui-plugin-manager/lib/client.js:1-11`（头）、文件尾（`exports.apply/inject; return module.exports; } });`）；tsdown 源头：`$SRC/packages/client/tsdown.client.ts:649-670` |
| DSH 是否有“工作台（workbench）/顶层页面/路由”一等概念？ | **没有**。DSH Web UI 没有 URL 路由；`main` 是唯一可换整页的 keyed slot，导航入口靠 `sidebar.panellist`。所谓“工作台”只能是“main 面板 + sidebar 图标的组合” | 源码无 workbench 概念（仅 dockkit 测试里的一个 `describe`）；`$SRC/docs/subsystems/ui-layout` 契约 `$SRC/packages/client/ui-layout/src/client/index.ts:53-121`（root 子 slot），`:178-190`（注册 root） |
| “整页工作台 + 导航入口”最可行方案？ | **`main`（keyed，key=`gateway-workbench`）+ `sidebar.panellist`（list，id 同 key，带 icon 与 label）**。与官方 Plugins 页完全同构 | `$INSTALL/dsh-client-ui-plugin-manager/lib/client.js:7680,7744-7760,7820-7826`；`$SRC/packages/client/ui-plugin-manager/src/client/index.ts:113-157` |
| 宿主↔浏览器通信首选？ | **宿主插件用 `ctx.connection.fetch.register()` 在 `/api` 下注册精确 Fetch 路由**，浏览器同源 `fetch()`。自动继承 DSH 的 Host/Origin 栅栏 + 浏览器会话认证（owner-only），无 CORS、无 CSRF token 负担 | `$INSTALL/dsh-client-connection/lib/index.js:820-838`（精确路由分发、非 owner 403）、`:702-779`（admit/trust）；类型 `$INSTALL/dsh-client-connection/lib/types/rpc.d.ts:119-140` |
| 能否用 typert Remote？ | **技术上能，但第三方成本高、风险大**：需要宿主侧 `./typert` 严格描述符 + 客户端侧手写 `typert.remote-client` 并 `ctx.remote.$mount()`。官方生成器 `@deepseek-ai/dsh-typert-generator` 不在安装态，第三方需手写生成物格式 | `$SRC/docs/api-gateway.zh.md:82`（api-remotes 显式选择，不可运行时发现）、`:111-122`（生成物）；`$INSTALL/dsh-api-remotes/lib/client.js:28313`（`$mount`）；`$INSTALL/dsh-client-connection...` 不相关 |
| 客户端直连插件自带 `:3081`？ | **不可行/不推荐**：跨源（3080 vs 3081）、网关 CORS 白名单 + Origin/Host 校验、网关会话 Cookie `SameSite=Strict` 且 host-only；手机根本到不了 `127.0.0.1:3081` | 仓库 `src/gateway.ts:675-688`（Origin 校验）、`:703-714`（SameSite=Strict）、`:771-780`（CORS 白名单）；`src/proxy.ts:180-205` |
| DSH 能否区分 loopback 直连与经网关代理的手机请求？ | **不能靠请求本身**。网关代理把 `Host`/`Origin` 改写成 DSH loopback origin，并注入自己保管的 DSH Cookie；DSH 侧 socket 对端、Host、Origin 全都与“本机浏览器”一致。唯一可靠信号来自**网关主动注入的分类头** | 仓库 `src/proxy.ts:5-7,183-205,295`（改写 Host/Origin、剥离 Set-Cookie、注入 `x-forwarded-*`）；DSH 不读 `remoteAddress`（`ConnectionTrustRequest` 仅 headers：`$SRC/packages/client/connection/src/rpc.ts:98-101`）；`$SRC/docs/user/guide/public-deployments.zh.md:15-27` |
| “只读给已配对设备、管理仅本机”可行吗？ | **可行，且必须双层门禁**：①网关代理对工作台管理路径按自身 `HostInfo.local` 直接 403；②DSH 桥路由再校验“网关分类头缺失（本机）才允许管理写”。客户端 `ctx.remote.$host.isLoopback` 只作 UI 提示 | 网关已有分类：`src/gateway.ts:656-673`；DSH 客户端 loopback 提示：安装态 `$INSTALL/dsh-client-ui-settings-general/lib/client.js:1403` 用法 |
| 总体判断 | **能做（可行性高）**：整页工作台 + 导航入口 + 同源桥路由全部成立；MVP 主要工作量在“把 gateway 管理逻辑抽成可复用 service + 写客户端半侧 + 构建链”。代价中等、风险可控 | §6 配方、§7 阶段 |
| 保留“打开独立监控页”链接 | 可行：桥路由返回 `gateway.origin + '/mobile/admin'`（仅本机）与 `gateway.publicBase()`（手机）；桌面显示 admin 链接、手机显示移动页链接或隐藏 admin | `src/gateway.ts:287-294`（origin/publicBase） |

---

## 1. 版本基线与资料优先级

### 1.1 基线

- **安装态（权威）**：DSH `0.2.2-rc.1`（`$INSTALL/../package.json` 的 version；各 `@deepseek-ai/dsh-*` 同为 `0.2.2-rc.1`）。
- **源码/文档（机制参考）**：`$SRC/package.json` = `0.2.1-rc.5`，git tag `dsh-v0.2.1-rc.5`，**比安装态更旧**。因此凡涉及“能不能用/叫什么名字”的判断，一律以 `$INSTALL/**/lib` 与安装态 README 为准；源码只用于理解设计意图与实现细节。
- 已实测到的**安装态 vs 源码差异**（提醒：照抄源码文档会踩坑）：
  1. 安装态 `settings.section` 多了一个 `settings.section.icon` 子 slot（`kind:'list', inline:true`），源码 0.2.1-rc.5 的 `ui-settings` 契约没有它。证据：`$INSTALL/dsh-client-ui-settings-general/lib/client.js:1546-1554` vs `$SRC/packages/client/ui-settings/src/client/contract/slots.ts:46-66`。
  2. `@deepseek-ai/dsh-client-ui-slots` / `dsh-client-ui-primitives` / `dsh-client-ui-dockkit` 在安装态**没有独立包目录**，它们被 Vite 打进 `dsh-web-frontend/dist`，仅以共享模块身份存在（见 §2.3）；源码里是独立 workspace 包。
  3. 安装态比源码多若干 UI 包（如 `dsh-client-ui-settings-plugin-inventory`、`dsh-client-ui-sidebar-documentpreview`、`dsh-client-ui-plugin-recommendations` 等），本文只使用两者都存在的表面。
  4. 安装态 `dsh-client-connection` 产出 `client.browser.js` + `client.node.js` 双入口（`$INSTALL/dsh-client-connection/lib/`），源码 tsdown 里的 `dualClient` 选项与之对应（`$SRC/packages/client/tsdown.client.ts:650-653`）。

### 1.2 资料优先级（本文遵循）

1. `$INSTALL/dsh-*/lib/**` 运行时实现与安装态 `README.zh.md`；
2. `$INSTALL/dsh-web-frontend/dist/assets/index-*.js` 中的共享模块表/真实客户端行为；
3. `$SRC/docs/**`（机制、契约、cookbook）；
4. `$SRC/packages/**` 源码（解释实现）。

---

## 2. 第三方插件的浏览器半侧：机制与构建复刻

### 2.1 声明与扫描（安装态行为）

第三方 bundle 包要让浏览器半侧生效，只需在包清单里满足三个条件：

1. `package.json` 带 `dsh.client.platform === 'web'`；
2. `exports["./client"]` 指向已构建的 bundle（字符串或 `{default}`）；
3. 该包作为 **Loader 行**被 profile 加载，且**行说明符恰为裸包名**（不能是子路径）——这是“半侧只挂在根行”的硬约束。

安装态扫描实现（关键判定）：

- `$INSTALL/dsh-client-modules/lib/index.js:781-800`：`resolveMeta()` 读包清单 → `parseDshClient()` → **`decl.platform !== 'web'` 直接跳过** → `clientExportOf(pkg.exports)`，缺 `./client` 抛错；bundle 绝对路径 = `join(dirname(package.json), clientRel)`。
- `$INSTALL/dsh-client-modules/lib/index.js:105-110`：Loader 行名必须是 `@scope/name` 两段或裸名，否则不产生 client entry。
- `$INSTALL/dsh-client-modules/lib/index.js:198-208`：`exports["./client"]` 接受 string 或 `{default:string}`。
- 半侧生命周期 = 根 Loader 行生命周期：行卸载 → 该 row 与其声明的所有子 slot 一起回收。
- 根行约束的官方说明：`$SRC/docs/cookbook/adding-a-settings-card.zh.md:56-60`（“只把一个包的半侧挂在说明符恰为裸包名的那一行上”）。

对 `dsh-gateway-mobile` 的含义：现有 `cordis.patch.yml` 的根行 `id: gateway-mobile` / `name: 'dsh-gateway-mobile'` 就是裸包名（`F:\ai_workspace\dsh-gateway-mobile\cordis.patch.yml:7-9`），因此 **把 `dsh.client` 加到该包即可，无需新增 Loader 行**。

### 2.2 bundle 产物协议（安装态实测格式）

安装态真实产物头尾（`$INSTALL/dsh-client-ui-plugin-manager/lib/client.js:1-11` 与文件尾）：

```js
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-plugin-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		/* ... 模块体 ... */
		exports.NS = NS;
		exports.PANEL_ID = PANEL_ID;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
```

协议要点：

- 顶层脚本只做一件事：登记 `{ id, factory }`。**模块副作用（含 CSS 注入）必须发生在 factory 内**，直到模块被物化才执行；`factory(require)` 的返回值即模块导出（`apply` / `inject` 等）。
- `id` 必须等于包名（浏览器模块身份 = 包名，`$INSTALL/dsh-client-modules/lib/index.js:112-123` 的 `stripClientSuffix` 说明 `<pkg>/client` 与裸包名同义）。
- 允许带 `chunk` 字段（拆包时）；第三方首版不需要拆分。
- loader facade 在 index 注入阶段以 queue 模式安装在 `window.__ModuleLoader__`（`$INSTALL/dsh-client-modules/lib/index.js:516-537`），随后由 shell 的 `create()` 切到 live 模式；因此 bundle **不是普通 ESM**，不能直接 `<script type=module>`。
- CSS：factory 执行期间新建、且没有 `data-plugin` 的 `<style>` 会被模块系统认领并在卸载时移除（`$INSTALL/dsh-client-modules/lib/client.js:617-629`）。这给“仓库外构建”一条简单路径：**在 factory 里插入 `<style>` 字符串**，无需复刻 tsdown 的 CSS Modules 插件。

### 2.3 共享模块表（可在 bundle 中 `require` 的唯一外部集合）

安装态前端 dist 里冻结的模块表（`$INSTALL/dsh-web-frontend/dist/assets/index-BgUyXZcc.js:196`）：

```js
{
  react, "react/jsx-runtime", "react-dom", "react-dom/client",
  "@deepseek-ai/cordis", zod, "@tanstack/react-virtual",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-dockkit"
}
```

与源码 `$SRC/packages/client/web/src/platform.ts:8-15`（`PLATFORM_MODULES`）**逐项一致**，且 `seed.ts:30-42` 是同一份静态表；`tsdown.client.ts:427-433`（`clientExternals`）说明：每个动态 bundle 默认以这 11 项为 external，`dsh.client.external` 只用于**额外**请求（动态包 row 或子路径），不是添加平台模块所必需。

React 版本：`react`/`react-dom` 为 18.x（`$SRC/packages/client/web/package.json` devDeps `react: ^18.2.0`；根 devDeps `@types/react ~18.3.1`；zod 4.4.3、react-virtual 3.14.10）。**第三方客户端插件必须按 React 18 构建，且不得自带 React 副本**。

> 给 `dsh-gateway-mobile` 的强建议：客户端 bundle 的**运行时 import 只保留 `react` 与 `react/jsx-runtime`**（类型 import 全部用 `import type`，构建时擦除）。`ctx.slots`/`ctx.locale`/`ctx.layout`/`ctx.remote` 都是 Cordis 注入服务，不需要 import 任何 DSH UI 包；这样只依赖平台表最稳的两项，跨 DSH 版本漂移面最小。

### 2.4 仓库外用 esbuild 复刻：可行，最小包装如下

tsdown 的客户端包装规则（源码）：

- banner：`window.__ModuleLoader__.load({ id: <pkg>, factory: (require) => {`；chunk 时多 `chunk: <file>`（`$SRC/packages/client/tsdown.client.ts:663-667`）。
- intro：`var module = { exports: {} }; var exports = module.exports;`（`:669`）。
- footer：`return module.exports; } });`（`:668`）。
- 产物 `format:'cjs'`、`platform:'browser'`、outDir `lib`、entry 名 `client.js`（`:511-522,649-653`）。
- 它自带的 CSS Modules/CSS 文本内联、图片 data URL 内联、`require.async` 拆包等属于**可选增强**，第三方首版不需要（`:580-648`）。

esbuild 0.28.2（仓库已安装于 `F:\ai_workspace\dsh-gateway-mobile\node_modules\esbuild`）实测复刻（本机临时目录，输出经 `node --check` 通过，未在仓库内构建）：

```js
// scripts/build-client.mjs（建议新增，与现有 build-web.mjs 并列）
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).name

// 只列真正需要的平台模块；每项都会变成 factory 里的 require("<specifier>")。
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', 'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const banner = 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(pkg)
  + ', factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;'

await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',                 // 关键：factory 形态是 CJS
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  jsxImportSource: 'react',
  external: PLATFORM_MODULES,    // 平台表模块保持 external；其余全部内联
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  legalComments: 'none',
  sourcemap: true,               // 生成 lib/client.js.map；DSH 首次请求 map 时才读取
  banner: { js: banner },
  footer: { js: 'return module.exports;\n} });' },
})
```

实测输出形态（节选）：

```js
window.__ModuleLoader__.load({ id: "dsh-gateway-mobile", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var __defProp = Object.defineProperty;
/* ... esbuild CJS 运行时 ... */
module.exports = __toCommonJS(src_exports);
var import_jsx_runtime = require("react/jsx-runtime");
var inject = ["slots", "locale", "layout"];
function apply(ctx) { /* ... */ }
return module.exports;
} });
```

注意事项（按踩坑概率排序）：

1. **不要把平台模块打进 bundle**。漏了 external 会内联一份 React/zod，造成双实例（hooks 报错、zod identity 不一致）。
2. **不要 import 任何未在平台表里的 `@deepseek-ai/*` 运行时值**（除官方允许 inline 的 wire 包）。`import type {} from '@deepseek-ai/dsh-client-ui-slots'` 之类的类型 import 必须写成 `import type`，否则 esbuild 会尝试解析一个安装态根本不存在的包。
3. `jsx: 'automatic'` + `jsxImportSource: 'react'` 会 require `react/jsx-runtime`，已在平台表内。
4. 不要用 `format:'esm'`；不要输出顶层 `export`。
5. CSS 不要用 `import './x.css'`（esbuild 会另出一个 `lib/client.css`，DSH 不会自动加载）。用内联 `<style>` 字符串，或者放在 `apply` 里注入。
6. `process.env.NODE_ENV` 必须 define 成字符串，否则浏览器端 `process is not defined`。
7. bundle 里不要写 `import.meta.url`（CJS 形态会失效）。
8. 生成的 `lib/client.js` 必须真实存在，否则 **DSH 激活阶段会大声失败**（`MissingClientBundleError`，`$INSTALL/dsh-client-modules/lib/index.js:157-184,882-889`），甚至可能拖垮启动审计——发布前必须校验文件存在（§6.8）。

### 2.5 release / revision / HMR（安装态）

- **revision**：按 bundle 的 `mtimeMs`/`ctimeMs`/`size` 派生，不做内容哈希；Host 重启后产物不变则 revision 不变（`$SRC/docs/subsystems/client-modules.zh.md:88,120`；安装态 HMR 同规则见 `$INSTALL/dsh-client-hmr/README.zh.md:62`）。
- **HMR 自动热替换**：`dsh-client-hmr` 宿主半侧对每个图的 bundle 做 stat 轮询（默认 `pollIntervalMs: 500`），变化后调用 `ctx.clientModules.rebuilt(id)`；浏览器半侧替换插件并重挂载（丢 React 状态，保留会话/连接）。证据：`$INSTALL/dsh-client-hmr/lib/index.js:22,29,46-50,96-108`；`README.zh.md:30-48`。**因此仓库外插件改完客户端代码只需重跑 `build:client`，约 0.5s 后页面自动替换，无需重启 DSH**。
- **manifest 变化不热**：`package.json`/`dsh.client` 的修改只在 Loader 条目重启或 DSH 重启后生效（`$SRC/docs/subsystems/client-modules.zh.md:98`；`$INSTALL/dsh-client-modules/README.zh.md:150`）。
- **release 身份**：`WebBootRelease` 由 Host 版本 + client 构建 commit 组成；Host release 变化时页面不应用其 HMR 帧，需刷新（`$SRC/docs/subsystems/client-modules.zh.md:90`；`$INSTALL/dsh-client-modules/lib/client.js:112-113,178-193`）。第三方 bundle 不含 release 字段，**兼容性由 `engines.dsh` + 实测保证**。

### 2.6 硬约束清单（针对本插件）

1. `dsh.client` 必须挂在**裸包名根行**上；仓库现有 patch 已满足。
2. 包名一旦改变，bundle 的 `id` 与 `dsh.client` 所在包名必须同步改；否则 registration id 与 row 不匹配。
3. 客户端半侧不能依赖宿主半侧的 `import`（两个 realm）；只能走 `ctx.remote` / 同源 HTTP。
4. 客户端半侧的 `apply` 不能假设任何 UI 包已激活；用 `ctx.slots.inject()` 等待声明，Cordis service inject 等待服务。
5. 首版不要拆 chunk；不要引入第三方 UI 库（会内联，体积/主题不一致）。
6. 样式优先使用 DSH 的 `--dsw-alias-*` 语义 token（`$SRC/docs/web-styling.zh.md` 的组件规则），但样式内容由我们自己的 `<style>` 提供。

---

## 3. DSH UI 可注册表面清单（安装态 + 源码交叉确认）

DSH Web UI 的“页面”本质是 slot 组合，不是路由。可用的第三方表面如下（scope 均为 root，除非注明）：

| 表面 | kind / 注册 API | 所属包（声明者） | 第三方可用 | 适合本插件吗 |
|---|---|---|---|---|
| `main` | keyed；`ctx.slots.register({name:'main', key}, Component)`，须 `ctx.slots.inject('main', …)` | `ui-layout`（`$SRC/packages/client/ui-layout/src/client/index.ts:72-73,178-190`） | ✅ | **✅ 主方案：整页工作台** |
| `sidebar.panellist` | list；`{name:'sidebar.panellist', id, order, label, locale}` | `ui-sidebar`（`$SRC/packages/client/ui-sidebar/src/client/contract/slots.ts:32-38`） | ✅ | **✅ 主方案：导航图标入口** |
| `sidebar.footer.action` | list；`{..., id, order}` | `ui-sidebar`（同上 `:52-56`） | ✅ | 备选：底部“网关状态”入口 |
| `shell.overlay` | list；`{name:'shell.overlay', id}` | `ui-layout`（`.../ui-layout/src/client/index.ts:95-105`） | ✅ | ✅ MVP 辅助：状态徽标/一键打开 |
| `shell.bottom` | single；`{name:'shell.bottom'}` | `ui-layout`（`:88-94`） | ✅（与已有 occupant 抢同一 cell 时需 priority） | 备选：底部状态条 |
| `settings.section` | list；`{name:'settings.section', id, order, label}` | `ui-settings` 契约（`$SRC/packages/client/ui-settings/src/client/contract/slots.ts:46-57`） | ✅ | **降级方案 B：设置内整页** |
| `settings.plugins.tab` | list；`{name:'settings.plugins.tab', id, order, label}` | `ui-settings-plugins` 声明、`ui-settings` 契约 | ✅ | 备选：挂在 Plugins 设置页 |
| `plugins.bundle.config` | keyed（key=包名）；`{name:'plugins.bundle.config', key}` | `ui-plugin-manager`（`$SRC/packages/client/ui-plugin-manager/src/client/slot-contract.ts:137-142`） | ✅（对自己 bundle） | 备选：本插件详情页里的状态/配置卡片 |
| `plugins.detail.section` | list | 同上 `:162-168` | ✅ | 备选：插件详情页诊断区 |
| `settings.general.item` | list（行） | `ui-settings` 契约 `:78-92` | ✅ | 太小，不适合整页 |
| `conversation.*` | 各种 | `ui-conversation`/`ui-chat`/… | ✅ 但语境是对话 | ❌ 与聊天语义冲突 |
| `root` / `sidebar` / `rightbar` / `shell.leading` | single（已被占用） | 各 owner | 理论上能，但是**替换**而非增量 | ❌ 不建议 |
| 顶层 route / URL page | **不存在** | — | — | ❌ 不可用 |

补充事实：

- **没有 workbench 一等概念**：在 `$SRC/docs` 与 `$SRC/packages` 中检索 `workbench` 仅命中 `packages/client/ui-dockkit/tests/components.client.spec.tsx:1109` 的测试描述；DSH 的产品词汇里没有“工作台”。
- **没有 URL 路由**：客户端代码检索 `pushState/popstate/location.pathname/router` 无命中（唯一 `router` 是 `ui-sidebar-right` 的 tab 匹配器）。因此工作台**不能深链**；如需记住 Tab/子页，只能自己用 `location.hash`（宿主不认）。
- `main` 的渲染：`renderSlot("main", {}, { entryKey: panelId ?? "conversation" })`（安装态 `$INSTALL/dsh-client-ui-layout/lib/client.js:127`）；`ctx.layout.selectPanel(id)` 会校验 id 已注册（`$SRC/packages/client/ui-layout/src/client/service.ts:71-78`）。
- `sidebar.panellist` 行会调用 `selectPanel(id)` 打开同名 main 面板，`label` 提供可访问名称，`order` 控制图标顺序（安装态 `$INSTALL/dsh-client-ui-sidebar/lib/client.js:206-228`）。

### 3.1 推荐方案 A：整页工作台 + 侧栏导航（与官方 Plugins 页同构）

官方 Plugins 页就是范本，可 1:1 抄模式：

- 安装态证据：`$INSTALL/dsh-client-ui-plugin-manager/lib/client.js:7680`（`PANEL_ID = "plugins"`）、`:7744-7760`（`ctx.slots.inject('main', function*(){ yield ctx.slots.register({name:'main', key:PANEL_ID, …}) })`）、`:7820-7826`（`sidebar.panellist` 注册，`id: PANEL_ID`）。
- 源码证据：`$SRC/packages/client/ui-plugin-manager/src/client/index.ts:113-157`（同一模式，含 `ctx.layout.selectPanel(PANEL_ID)` 跨插件导航）。

最小骨架（第三方包内，无需 import UI 包）：

```tsx
// src/client/index.tsx
import { useEffect, useState } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client' // 可选类型增强
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

const PANEL_ID = 'gateway-workbench'
const NS = 'gatewayWorkbench'

export const inject = ['slots', 'locale', 'layout', 'remote']

function PanelIcon({ size, active }: { size: number; active: boolean }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">…</svg>
}

function WorkbenchPage() {
  const [status, setStatus] = useState(null)
  useEffect(() => { /* fetch('/api/gateway-mobile/status') */ }, [])
  return <div className="gw-workbench">…</div>
}

export function apply(ctx: any): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'gateway-mobile: dictionaries')
  const t = ctx.locale.bind(NS)

  // 形状与官方 Plugins 页一致：main key = sidebar.panellist id。
  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, WorkbenchPage))
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,          // 与 main key 相同
      order: 600,            // 官方 Plugins 是 0，跟随其后
      label: () => t('panel'),
      locale: NS,
    }, PanelIcon))
}
```

> 注意：`PANEL_ID` 在强类型下是 `MainPanelId`（branded string）；第三方做类型 shim 时按 `string` 使用即可，运行时就是字符串。

### 3.2 降级方案 B：设置内整页

如果担心侧栏/主面板 API 在目标 DSH 版本上的稳定性，可退化为 `settings.section` 的一页（`id:'gateway'`, `order` 靠后, `label`, 组件即整页内容）。注册方式：

```ts
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section', id: 'gateway', order: 900, label: () => t('settings'), locale: NS,
}, SettingsPage))
```

代价：入口埋在“设置”里，不符合“用户不必另开监控网页/一眼看到状态”的初衷；适合作为 A 方案未验证通过时的兜底。

### 3.3 轻量方案 C：`shell.overlay` 状态徽标

用 `shell.overlay` 放一个“网关在线/隧道状态”浮动徽标，点击 `ctx.layout.selectPanel(PANEL_ID)`（或打开独立页）。适合 MVP 第一步打通通信，不承担整页。

### 3.4 结论

- “整页工作台 + 导航入口”**最可行且唯一自然**的组合是 **`main` keyed + `sidebar.panellist`**；没有 workbench/route 概念可用。
- 备选顺序：A（main+panellist）→ C（overlay 徽标）→ B（settings.section）→ plugins.bundle.config（插件详情配置卡片）。
- 保留“打开独立监控页”的实现：在工作台页头放链接，地址来自宿主桥路由（§6.5），按 `ctx.remote.$host.isLoopback` 决定显示 admin 还是移动页。

---

## 4. 宿主↔浏览器通信：三条路径对比与选择

| 维度 | **(a) 宿主 `ctx.connection.fetch.register` 精确路由（推荐）** | **(b) typert / api-gateway Remote** | **(c) 客户端直连插件 `:3081`** |
|---|---|---|---|
| 注册位置 | `/api/<prefix>/...` 下的精确 Fetch 路由 | Host 侧 `@Remote` + `./typert` 生成物；Client 侧 generated `/remote` + `$mount` | 无 |
| 第三方可用性 | ✅ 公开 HostConnectionHandle API | ⚠️ 机制公开，但生成器不在安装态、客户端 assembly 是应用显式选择（`$SRC/docs/api-gateway.zh.md:82,104-122`） | ❌ 不建议 |
| 鉴权 | 自动继承 `/api` 栅栏 + 浏览器 Cookie/API 凭证；**精确路由只放行 owner Peer** | 同 `/api`；另有 `remoteAccess` 角色策略 | 需自己实现网关会话 Cookie，且跨源 |
| CSRF | 无 token；靠 Host/Origin/Sec-Fetch-Site + SameSite Cookie | 同左 | 网关侧 `x-requested-with` + Origin 校验 |
| CORS | 不需要（同源） | 不需要 | 需要，网关只对白名单 origin 开 CORS |
| 手机场景 | ✅ 页面同源经网关代理可达 | ✅ 可达 | ❌ 手机到不了 127.0.0.1:3081 |
| 实现成本 | 低（一个路由表 + `Response`） | 高（手写 strict codec/描述符、双向对齐、版本脆） | 中（但要重写一套鉴权且移动不可用） |
| 适用 | 状态/命令/日志/二维码等 BFF 型接口 | 强类型、大对象、流式、跨插件共享 | 仅本机调试 |

### 4.1 (a) 精确 Fetch 路由：推荐实现

安装态 API（类型 `$INSTALL/dsh-client-connection/lib/types/rpc.d.ts:119-140`）：

```ts
export interface ConnectionFetchRoute {
  readonly path: string          // 例如 '/api/gateway-mobile/status'
  readonly methods: readonly ('GET'|'HEAD'|'POST')[]
  readonly requestBody: 'buffered' | 'streaming'
  readonly fetch: (request: Request) => Promise<Response>
}
ctx.connection.fetch.register(route): () => Promise<void>
```

分发语义（安装态 `$INSTALL/dsh-client-connection/lib/index.js:820-838`）：

- 请求先经 `/api` 前缀路由的 `admit()`（Host/Origin 栅栏 + 浏览器认证），再进 `createSharedFetchHandler`；
- 精确路由按 `url.pathname` 命中；**`peer.principal.kind !== 'owner'` 返回 403**（`：830`）；
- 路径必须落在 `/api` 下且每段合法（`endpointFromPath`：`$SRC/packages/client/connection/src/rpc-host.ts:361-370`，段模式 `^[A-Za-z0-9_$.-]+$`，`gateway-mobile` 含连字符合法）。

宿主侧骨架（放进 `apply`，`gateway.listen()` 之后）：

```ts
// src/workbench-bridge.ts（新增）
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'

type Ctx = {
  connection: { fetch: { register(route: ConnectionFetchRoute): () => Promise<void> } }
  effect(cb: () => (() => void | Promise<void>), label?: string): unknown
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
})

export function registerWorkbenchBridge(ctx: Ctx, gateway: Gateway, version: string): void {
  const routes: ConnectionFetchRoute[] = [
    { path: '/api/gateway-mobile/status',  methods: ['GET'], requestBody: 'buffered',
      fetch: async () => json(await buildStatus(gateway, version)) },
    { path: '/api/gateway-mobile/pairing', methods: ['GET'], requestBody: 'buffered',
      fetch: async () => json(await gateway.pairingPayload()) },     // 复用现有方法
    { path: '/api/gateway-mobile/devices', methods: ['GET'], requestBody: 'buffered',
      fetch: async () => json(listDevices(gateway)) },
    { path: '/api/gateway-mobile/logs',    methods: ['GET'], requestBody: 'buffered',
      fetch: async (req) => json({ logs: gateway.logger.recent(limitOf(req)) }) },
    // 管理面：仅本机；见 §5 的双层门禁
    { path: '/api/gateway-mobile/admin/tunnel', methods: ['POST'], requestBody: 'buffered',
      fetch: async (req) => {
        const denied = requireLocal(req); if (denied) return denied
        const action = (await req.json() as { action?: string }).action
        /* gateway.tunnel.start/stop/restart 复用现有实现（src/routes/admin.ts:95-106） */
        return json({ ok: true })
      } },
  ]
  for (const route of routes) {
    ctx.effect(() => ctx.connection.fetch.register(route), `gateway-mobile: ${route.path}`)
  }
}
```

客户端侧就是同源 `fetch('/api/gateway-mobile/status')`；`/api` 的 Cookie 与 Origin 语义由 DSH 负责，页面不需要额外 token。

**CSP 现状**：安装态 `dsh-web-frontend/dist/index.html` 无 CSP meta，`dsh-host-frontend-static`/`dsh-host-webserver` 不注入 CSP 响应头；全安装包检索到的 `content-security-policy` 只出现在个别资源路由（如 SVG 资源/文档预览/媒体引用），不在 SPA index 或 `/api` 上。因此插件 fetch/`<img>`/`<style>` 不受 CSP 限制；但**不要把“当前无 CSP”当成永久契约**——若未来 DSH 给页面加 CSP，插件需要保证资源同源且避免内联 eval（我们本来就不需要 eval）。

**网关代理可达性**：网关把所有非 `/mobile/*` 路径（含 `/api/*`、`/plugins/*`、`/`）在设备鉴权后转发给 DSH（`src/gateway.ts:839-851`）；因此工作台与 `/api/gateway-mobile/*` 经隧道天然可达。

### 4.2 (b) typert Remote：能，但第三方成本高

事实：

- Client 不能运行时发现 Host Remote：`api-remotes` 在**构建时显式导入**各业务包的 `/remote` 贡献并 `$mount`（`$SRC/docs/api-gateway.zh.md:82`；安装态 `$INSTALL/dsh-api-remotes/lib/client.js:28306-28320`）。
- 第三方若想用 Remote，有两条路：
  1. 宿主侧手写 `lib/typert.host.js`（导出 `TYPERT` 对象，`face:'host'`、`invocations`、`schemas`、`model`），让 `dsh-typert-loader` 自动发现 `./typert` 导出（`$INSTALL/dsh-typert-loader/README.zh.md` 的“注册什么/最小配置”；安装态 base 组合确实挂了 `typert-loader`：`$INSTALL/dsh-base/cordis.patch.yml:46-52`）；
  2. 客户端 bundle 内联手写 `typert.remote-client` 贡献（`createTypertRemoteInfo(spec, zod)`，`$INSTALL/dsh-typert-protocol/lib/types/remote-info.d.ts:13`；`remote-info.js` 无外部 import，可被 esbuild 内联），然后 `ctx.remote.$mount(contribution)`（安装态 `$INSTALL/dsh-api-gateway...` 对应 `$SRC/packages/api/gateway/src/client/index.ts:214-222`）。
- 风险：`typert.host.js` 的严格描述符/JSON Schema/codec 必须与客户端贡献**逐字段一致**，且格式由生成器/协议版本决定；`engines.dsh` 跨版本漂移时最容易碎。安装态**没有** `@deepseek-ai/dsh-typert-generator` 包，第三方无法“正常生成”，只能手写或从官方包反推。
- 另外，`ctx.typert` 的 strict 注册要求 `./typert` 产物通过 `validateTypertManifest()`，字段错了在激活期直接失败。

**结论**：首版不用 typert。除非未来需要“强类型 + 流式 + 多端共享”的正式 API，并接受维护成本。

### 4.3 (c) 直连 3081：为什么不行

- 地址不同源：页面在 `http://127.0.0.1:3080`（或隧道域），网关在 `:3081`；浏览器按跨源处理。
- 网关的 CORS 只对配置的 `security.corsOrigins` 白名单放行（`src/gateway.ts:771-780`），默认不含 DSH origin。
- 网关所有请求都过 `#checkOrigin`（Origin 必须等于 Host，`src/gateway.ts:675-688`）；跨源 fetch 的 Origin 会被拒。
- 网关会话 Cookie 是 host-only + `SameSite=Strict`（`src/gateway.ts:703-714`），跨源/跨站请求不会带上。
- 手机端根本到不了 `127.0.0.1:3081`（网关只监听 loopback，`src/config.ts:350`）。
- 即使本机放行，也等于把网关的管理鉴权绕过一遍，重复实现且扩大攻击面。

### 4.4 实时性

- **MVP：轮询**（2–5s）足够覆盖状态、设备数、隧道状态、日志尾部。
- **完整版**：`ctx.connection.fetch` 只能一元响应；要推送可选：
  - 自定义 `ctx.webServer.register({kind:'prefix', path:'/gateway-mobile/stream'})` 做 SSE，但必须自己调 `ctx.connection.requestRejection(req)` 补鉴权（`$SRC/docs/subsystems/web-server.zh.md:80,110-149`）；
  - 或继续轮询 + 事件触发的短轮询（实现最省）。
- 不建议复用网关 `/mobile/ws`：本地页面在 3080 上到不了 3081，且会引入第二套会话。

---

## 5. 安全语义：loopback 直连 vs 网关代理手机请求

### 5.1 DSH 侧的真实判定逻辑

- `/api` 信任栅栏只看 **请求头**：`Host` 必须是 loopback / 监听器绑定地址 / 配置的 `trustedHosts`；有 `Origin` 时必须与 Host 同 authority；`Sec-Fetch-Site: cross-site` 直接拒。证据：`$SRC/packages/client/connection/src/api-request-trust.ts:113-151`；安装态 `$INSTALL/dsh-client-connection/lib/index.js:740-780`。
- **不看 socket 对端地址**：`ConnectionTrustRequest` 只有 headers（`$SRC/packages/client/connection/src/rpc.ts:98-101`），实现里没有 `remoteAddress`。
- `ctx.connection.allowsRemoteAuthorities` 只表示“是否配置了非 loopback 的 trustedHosts”，与单次请求身份无关（`$SRC/packages/client/connection/src/rpc-host.ts:79-101`）。
- 客户端侧 `ctx.remote.$host.isLoopback` 是**页面 authority** 判定（page hostname 是 loopback 或 transport ownsHost 或非浏览器）：`$SRC/packages/client/connection/src/client/index.ts:143-151,268`；安装态用法见 `$INSTALL/dsh-client-ui-settings-general/lib/client.js:1403`（`$host.isLoopback ? new SettingsDocumentStore(...) : undefined`）。**这是 UI 提示，不是服务端安全边界。**

### 5.2 网关代理的实际行为（决定 DSH 能否区分）

`src/proxy.ts:180-205`（`#upstreamHeaders`）：

```ts
for (const [key, value] of Object.entries(req.headers)) {
  const lower = key.toLowerCase()
  if (lower === 'host' || lower === 'origin' || lower === 'cookie') continue
  if (lower.startsWith('x-forwarded-') || lower === 'x-real-ip') continue
  ...
}
headers.host = this.upstream.host        // 改写成 127.0.0.1:3080
if (req.headers.origin) headers.origin = this.upstream.origin
if (this.cookieProvider.isReady) headers.cookie = this.cookieProvider.cookie
headers['x-forwarded-for'] = ip
headers['x-real-ip'] = ip
headers['x-forwarded-proto'] = ...
headers['x-forwarded-host'] = String(req.headers.host ?? '')
```

并且响应侧剥离 DSH 的 `Set-Cookie`（`src/proxy.ts:295` 等），浏览器只持有网关会话 Cookie。

**结论**：经网关的手机请求到达 DSH 时，`Host`/`Origin` 都被改写成 loopback origin，Cookie 是网关替所有设备保管的 DSH owner Cookie。因此 DSH 看到的就是“一个本机 owner 浏览器”。**DSH 自身无法区分。**

而网关自己其实已经能区分：`#hostInfo()` 用 `isLoopbackAddress(hostname) && !isProxiedRequest(req)` 得出 `local`，其中 `isProxiedRequest` 检查 `cf-connecting-ip`/`cf-ray`/`x-forwarded-host`/`x-forwarded-for`（`src/gateway.ts:656-673`；`src/util.ts:175-200`）。现有管理台正是用这个 `local` 做 loopback-only（`src/gateway.ts:860-870,1096-1108`；`src/routes/router.ts:68-71` 的 `assertLocal`）。

### 5.3 可行方案：分类信号必须由网关产生

推荐**双层门禁**（都做，成本很低）：

1. **网关代理层门禁（第一层，最强）**：在 `src/gateway.ts:839-851` 的 DSH 反代分支前加规则——若 `!info.local` 且 `pathname` 命中工作台管理前缀（建议 `/api/gateway-mobile/admin/`）→ 直接 403 JSON。这样手机即使拿到页面也调不动管理接口；本地直连不经过网关，天然放行。
2. **DSH 桥路由层门禁（第二层，防绕过）**：网关在所有转发请求上注入分类头，并**剥离入站伪造**：

```ts
// src/proxy.ts #upstreamHeaders 内
if (lower.startsWith('x-forwarded-') || lower === 'x-real-ip'
    || lower === 'x-dsh-gateway-proxied' || lower === 'x-dsh-gateway-device') continue
...
headers['x-dsh-gateway-proxied'] = '1'
if (options.deviceId) headers['x-dsh-gateway-device'] = options.deviceId  // 现 handleHttp 已有 peer.deviceId 可传
```

DSH 侧管理路由用“**有该头 = 代理 = 非本机 = 拒绝写**”的 fail-closed 逻辑：

```ts
const PROXIED = 'x-dsh-gateway-proxied'
function requireLocal(request: Request): Response | undefined {
  return request.headers.get(PROXIED) === '1'
    ? json({ error: 'local-only' }, 403)
    : undefined   // 无该头 = 本机直连（浏览器不会自带，网关一定带）
}
```

安全性说明：远程手机无法删除该头（网关先剥离入站同名头再强制写入）；本机恶意进程伪造该头只会**降低**自己的权限，不构成提权。若想再强一点，可让网关注入 HMAC（`HMAC(secret, deviceId|ts)`），DSH 侧校验——但需要两插件共享 secret（同一进程内可实现），属完整版增强项，首版不必。

3. **客户端 UI 提示（非安全边界）**：工作台用 `ctx.remote.$host.isLoopback` 决定是否显示“管理操作”和“打开独立管理台”链接。

### 5.4 只读 / 管理切分建议

| 能力 | 手机（已配对，经隧道） | 本机直连 |
|---|---|---|
| 会话状态、隧道状态/URL、设备列表（脱敏）、日志尾部、健康/诊断只读、微信通道状态 | ✅ 只读 | ✅ |
| 配对码/二维码**展示** | ⚠️ 敏感：建议默认隐藏，需二次确认（或在手机上只给“已配对设备”信息，不显示可复用配对码） | ✅ |
| 配对码重新生成、撤销/移除设备、隧道启停、设置保存、密钥轮换、日志清空 | ❌ 403 | ✅ |
| 微信扫码登录：发起登录 | ⚠️ 手机端本身是“扫码方”，工作台应链接到现有 `/mobile/oauth/*` 流程；不要以“管理操作”名义内嵌 | ✅ |
| 微信审批 | ⚠️ 产品决策；审批若只允许本机会让“手机审批”能力退化 | ✅ |

> 二维码/配对码是**一次性凭据**：桥路由必须 `cache-control: no-store`、禁止写日志、响应禁止被浏览器缓存；手机端默认不返回明文配对码。

---

## 6. 针对 `dsh-gateway-mobile` 的接入配方

> 以下只给方案与文件级清单，不在本阶段实施；task-2（插件现状盘点）会补“现有路由/可复用模块/版本”的细节。

### 6.1 文件变更清单

| 文件 | 变更 | 说明 |
|---|---|---|
| `package.json` | 加 `dsh.client`；`exports` 加 `"./client"`；scripts 加 `build:client`；`build` 串起它 | 见 §6.2；`files` 已有 `"lib"`，会自动包含 `lib/client.js` |
| `cordis.patch.yml` | **无需新增行**（现有根行已是裸包名） | 若未来把客户端半侧拆成独立包才需要新行；注意“半侧只在根行”的约束 |
| `tsconfig.json` | `exclude: ["src/client"]` | 现有 `include: ["src/**/*.ts"]` 会把客户端源码按 NodeNext 编译，必须隔离 |
| `tsconfig.client.json`（新增） | `jsx:"react-jsx"`, `lib:["ES2022","DOM","DOM.Iterable"]`, `module:"ESNext"`, `moduleResolution:"Bundler"`, `noEmit:true`, `strict:true` | 只做类型检查；产物由 esbuild 出 |
| `scripts/build-client.mjs`（新增） | §2.4 的 esbuild 脚本 | 输出 `lib/client.js`(+`.map`) |
| `src/client/index.tsx`（新增） | 客户端半侧：`apply`/`inject`、main 面板、sidebar 图标、样式注入、i18n | §3.1、§6.6 |
| `src/client/*.tsx`（新增） | 工作台页、状态卡、二维码、日志、设备列表等 | 纯 React，仅 import react |
| `src/client/shims.d.ts`（可选新增） | 若 `@deepseek-ai/dsh-client-ui-slots` 未发布/不想依赖：本地声明 `ctx.slots/locale/layout/remote` 与 `SlotMap` 增强 | 见 §9 开放问题 1 |
| `src/workbench-bridge.ts`（新增） | 宿主桥：`/api/gateway-mobile/read/*`、`/api/gateway-mobile/admin/*` 精确路由；分类/本机门禁；调用 gateway 服务 | §4.1、§6.5 |
| `src/index.ts` | `gateway.listen()` 后调用 `registerWorkbenchBridge(ctx, gateway, version)`；扩展 `CordisContext` 类型（`connection.fetch`） | 现有 `ctx.effect` 生命周期模式见 `src/index.ts:275-301` |
| `src/proxy.ts` | 注入/剥离分类头（§5.3） | 也可不改：仅靠网关代理层门禁；但双层更稳 |
| `src/gateway.ts` | 反代分支前加“管理前缀仅 local”；可把 `sendJson` 依赖的 admin 逻辑抽成 service | §6.5 |
| `scripts/integration-check.mjs` / `scripts/hmr-check.mjs` | 加客户端产物存在性/格式检查 | `dsh.client` 声明但缺 `lib/client.js` 会激活失败，必须前置拦截 |
| `docs/*` | 更新安装/使用说明 | 说明 DSH 内工作台入口 |

### 6.2 `package.json` 建议字段

```jsonc
{
  "name": "dsh-gateway-mobile",
  "exports": {
    ".": "./lib/index.js",
    "./client": {
      "types": "./types-client/index.d.ts",   // 可选：自用类型（或省掉 types）
      "default": "./lib/client.js"
    },
    "./package.json": "./package.json",
    "./locale/*.json": "./locale/*.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web"
      // "inject": ["@deepseek-ai/dsh-client-ui-layout", ...]  // 首版不需要：我们只用 ctx.slots.inject 等待
      // "external": [...]                                     // 首版不需要：无额外模块请求
    }
  },
  "engines": { "dsh": ">=0.2.2-rc.1 <0.3.0", "node": ">=24" },
  "scripts": {
    "build": "npm run build:server && npm run build:client && npm run build:web",
    "build:client": "node scripts/build-client.mjs",
    "typecheck": "npm run typecheck:server && npm run typecheck:client && npm run typecheck:web",
    "typecheck:client": "tsc -p tsconfig.client.json"
  },
  "devDependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "@types/react": "~18.3.1",
    "@types/react-dom": "~18.3.0",
    "@deepseek-ai/cordis": "~4.1.0"
    // 视发布情况加 DSH client 类型包；否则用本地 shim
  }
}
```

要点：

- `react`/`react-dom` **只放 devDependencies**：运行时由 DSH 提供；放进 dependencies 会给 profile 装出第二份 React 的风险。
- `engines.dsh` 建议从精确 `0.2.2-rc.1` 改为范围。安装态兼容检查实现为 `semver.satisfies(runtime, range, { includePrerelease: true })`（`$INSTALL/dsh-app-boot/lib/index.js:1094-1131`），因此 `>=0.2.2-rc.1 <0.3.0` 会接受 0.2.x 的后续预发布；这与“客户端 slot API 可能漂移”的现实相匹配（漂移时靠集成测试兜底，而不是把用户锁死在 rc）。
- 若担心 npm 上没有 `@deepseek-ai/dsh-client-ui-slots@0.2.2-rc.1`，用本地 `shims.d.ts`（见 §9）。

### 6.3 构建顺序与失败防护

1. `build:server`（现有 tsc，`rootDir: src`，需 exclude `src/client`）；
2. `build:client`（esbuild → `lib/client.js`）；
3. `build:web`（现有 admin/PWA 构建，互不影响）。

生产发布前检查（放进 `pack:pre` 或 `integration-check`）：

```js
// 断言 1：产物存在且是可被模块加载器接受的形状
const src = await readFile('lib/client.js', 'utf8')
assert(src.startsWith('window.__ModuleLoader__.load({ id: "dsh-gateway-mobile"'))
assert(src.trimEnd().endsWith('} });'))
// 断言 2：没有把平台模块打进 bundle（粗查）
assert(!src.includes('var React = ')) // 更可靠：esbuild metafile 检查 inputs
```

### 6.4 宿主桥路由表与复用

建议 URL 约定（便于网关代理一层做前缀门禁）：

| 路径 | 方法 | 权限 | 数据来源 |
|---|---|---|---|
| `/api/gateway-mobile/read/status` | GET | 已配对手机/本机 | 复用 `gateway.capabilities()`、tunnel.status()、devices/stats 汇总（可参考 `gateway.ts:633-648` 的 admin status payload 构造） |
| `/api/gateway-mobile/read/pairing` | GET | 本机（手机可给“已配对”元信息，不返回可复用码） | `gateway.pairingPayload()`（`src/routes/admin.ts:36-40`） |
| `/api/gateway-mobile/read/devices` | GET | 已配对/本机（脱敏） | `gateway.devices`（`src/routes/devices.ts:16-20`） |
| `/api/gateway-mobile/read/logs?limit=` | GET | 本机（手机可选脱敏尾部） | `gateway.logger.recent(limit)` |
| `/api/gateway-mobile/read/about` | GET | 都行 | `{ adminUrl: gateway.origin + '/mobile/admin', publicUrl: gateway.publicBase(), version }`（`gateway.ts:287-294`） |
| `/api/gateway-mobile/admin/pairing/regenerate` | POST | **仅本机** | `gateway.pairing.issue()` |
| `/api/gateway-mobile/admin/tunnel` | POST | **仅本机** | `gateway.tunnel.start/stop/restart`（`src/routes/admin.ts:95-106`） |
| `/api/gateway-mobile/admin/devices/:id/revoke` | POST | **仅本机** | devices 现有撤销逻辑 |
| `/api/gateway-mobile/admin/settings` | GET/POST | **仅本机** | 现有 settings 路由（`src/routes/admin.ts:51-60+`） |

**复用策略（推荐顺序）**：

1. **抽取 service**：把 admin 路由里“解析/校验/写入 + 返回纯数据”的部分抽成 `src/admin-service.ts`（例如 `getStatus()`, `getPairing()`, `getDevices()`, `getLogs()`, `controlTunnel()`, `patchSettings()`），让现有 HTTP 路由与 DSH 桥都调用它。这是最干净、可测试的路径；现有路由文件体量小（`src/routes/admin.ts` 153 行），抽取可控。
2. **不推荐**：在 DSH 桥里再用 loopback HTTP 请求网关的 `/mobile/api/v1/admin/*`（虽然网关会判 local 放行，但引入第二跳、错误映射和端口依赖）。

宿主桥注册生命周期：放在 `apply` 内、`gateway.listen()` 成功之后，用 `ctx.effect` 注册（与现有 dispose 模式一致，`src/index.ts:275-301`）。启动失败时不应注册半截桥。

### 6.5 客户端半侧骨架要点

```tsx
// src/client/index.tsx —— 只 import react（运行时）；其余纯类型
import { useEffect, useState } from 'react'

export const inject = ['slots', 'locale', 'layout', 'remote']

const PANEL_ID = 'gateway-workbench'
const NS = 'gatewayWorkbench'

const STYLE = `/* 使用 --dsw-alias-* 语义 token；类名统一 gw- 前缀避免污染 */
.gw-workbench { padding: 24px; color: var(--dsw-alias-text-primary, #222); }`

// 样式必须在 **模块顶层（factory 物化期间）** 插入：只有这个窗口内新建的
// 无 data-plugin <style> 会被模块系统认领（安装态 client.js:617-629,811-817），
// 之后取消/卸载/HMR 时由 removeOwnedStyles(id) 自动移除（:312-314,446,497）。
const styleEl = document.createElement('style')
styleEl.textContent = STYLE
document.head.append(styleEl)

export function apply(ctx: any): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'gateway-mobile: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: PANEL_ID, locale: NS }, WorkbenchPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: PANEL_ID, order: 600, label: () => t('panel'), locale: NS },
    PanelIcon))
  // 可选：shell.overlay 状态徽标（MVP 第一步）
}
```

数据获取建议写成一个不依赖 React 的轻量 store（`useSyncExternalStore`），避免每个卡片各自轮询；首版也可以每个卡片 `useEffect` + `setInterval`，够用。

“打开独立监控页”按钮：

- 本机（`ctx.remote.$host.isLoopback === true`）：`<a href={about.adminUrl} target="_blank">打开独立管理台</a>`；
- 手机：显示“打开手机页”指向 `about.publicUrl + '/mobile'`，或不显示管理台链接。

### 6.6 版本/依赖约束

| 项 | 约束 | 依据 |
|---|---|---|
| DSH | `engines.dsh: ">=0.2.2-rc.1 <0.3.0"`（建议）；当前精确 pin 会在 DSH 升级时直接拒绝安装 | `$INSTALL/dsh-app-boot/lib/index.js:1094-1131` |
| React | 18.x；运行时 external，不进 dependencies | `$SRC/packages/client/web/package.json`；平台表 |
| 平台模块 | 只用 `react`、`react/jsx-runtime`（建议）；最多再加 `react-dom` | §2.3 |
| Cordis | 类型用 `@deepseek-ai/cordis ~4.1.0`（安装态 4.1.0），运行时 external | `$INSTALL/cordis/package.json` |
| esbuild | 仓库已锁 `^0.28.2`，足够 | 仓库 package.json |
| 客户端 bundle 大小 | 建议 < 300KB（未压缩）；首版应远小于此 | 无硬限制，但 revision/bundle route 每次冷加载 |

### 6.7 测试与冒烟（写入 CI/脚本，不在本阶段运行）

1. **产物结构**：`lib/client.js` 存在、头尾匹配、`node --check` 通过、无内联 React（用 esbuild metafile）。
2. **安装冒烟**：`dsh plugin --profile web add <本仓库路径>`（本地链接）→ 重启 DSH → 页面出现侧栏图标、点开是工作台；若客户端 bundle 缺失，DSH 应报 `client bundle not found`（我们应在此之前失败）。
3. **路由冒烟**：本机 `/api/gateway-mobile/read/status` 200；无 cookie/错误 Origin → 401/403；`/admin/*` POST 本机 200、隧道 403。
4. **隧道冒烟**：手机经 Quick Tunnel 打开 DSH UI → 工作台只读可用、管理按钮不可见/被 403；本机 DSH UI 管理可用。
5. **HMR**：改客户端代码 → `build:client` → ≤1s 页面自动替换（`dsh-client-hmr` 轮询 500ms）；改 `package.json` 需重启。
6. **升级冒烟**：把 DSH 升到 0.2.x 下一版，跑一遍 1–4；slot API 缺失时应“静默不出现”，不拖垮其他插件。
7. 现有 `npm test` / `integration-check` / `hmr-check` 门槛需扩展客户端产物检查（具体见 task-2 对测试脚本的盘点）。

---

## 7. 分阶段建议

### Phase 0：可行性验证（0.5–1 天，不改产品逻辑）

- 在仓库外/临时分支加最小 `dsh.client` + `lib/client.js`（只有 `shell.overlay` 一个徽标 + `sidebar.panellist` 图标）→ `npm run build:client` → 用 `dsh plugin --profile web add <path>` 链接安装 → 重启 DSH 验证：bundles 是否加载、side bar 是否出现、点击能否打开一个 `main` 空面板。
- 验证宿主角色的桥：加一条 `GET /api/gateway-mobile/read/ping` 精确路由，页面 fetch 成功。
- 验收：无 DSH 启动错误；插件列表无同步失败；`/plugins/<pkg>/client.js` 返回 200。

### Phase 1：MVP（2–3 天）

- 整页工作台（只读）：状态总览（隧道状态/URL、设备数、微信通道、版本、health）、设备列表（脱敏）、日志尾部、设置只读。
- `sidebar.panellist` 导航入口 + `shell.overlay` 状态徽标（可选）。
- 保留“打开独立监控页”链接（本机 admin / 手机移动页）。
- 安全：网关代理层管理前缀 403 + DSH 桥头校验（管理接口仅本机）；配对码默认本机可见。
- 验收：桌面全流程可用；手机只读可用、管理 403；现有独立监控台不受影响。

### Phase 2：完整版（3–5 天增量）

- 管理操作：隧道启停/重开、配对码重新生成、设备撤销、设置写入（全部仅本机，客户端按 `isLoopback` 隐藏）。
- 二维码：桥路由返回 SVG（`image/svg+xml`、`no-store`），或返回 data URL；本机展示、手机不展示可复用码。
- 日志实时化：轮询 → SSE（自定义 `ctx.webServer` 路由 + `requestRejection` 鉴权）或 2s 轮询优化。
- 微信：状态 + 跳转现有 `/mobile/oauth` 登录流；审批策略按产品决策（默认仅本机）。
- 观测：埋点/诊断页、跨版本兼容矩阵、HMR 冒烟纳入 CI。

### 回滚/兼容策略

- 客户端半侧完全增量：`dsh.client` 出问题只影响该插件的 UI，不会阻断 DSH 启动（但 **bundle 缺失会让 client-modules 激活失败**，见风险表，发布前必须检查）。
- 独立监控台保持不变，作为永久兜底入口；DSH 内工作台只是新增入口。

---

## 8. 风险与缓解

| 风险 | 影响 | 概率 | 缓解 |
|---|---|---|---|
| `dsh.client` 声明了但 `lib/client.js` 未随包发布/构建失败 | DSH 激活期 `AggregateError`（client bundle not found），可能表现为启动报错 | 中 | 构建顺序 + `files` 校验 + 发布前脚本断言（§6.3） |
| 客户端 slot API 随 DSH 升级漂移 | 工作台入口消失或页面报错 | 中 | `engines.dsh` 范围 + 只依赖 `main`/`sidebar.panellist` 两个稳定表面 + 升级冒烟；`ctx.slots.inject` 缺失时静默等待，不抛错 |
| 平台模块表变化（如移除 dockkit） | 我们只依赖 react/jsx-runtime，风险极低 | 低 | 不 import UI 运行时包 |
| 网关代理改写 Host/Origin 的行为变化 | 管理门禁失效 | 低 | 双层门禁：网关 local 判定 + DSH 头校验；分类头名称文档化 |
| 分类头被本机进程伪造 | 仅自我降权，无提权 | 低 | fail-closed；完整版可加 HMAC |
| 二维码/配对码泄露 | 未配对者可接入 | 中 | `no-store`、不落日志、手机端不返回可复用码、管理仅本机 |
| 手机误触管理操作 | 改坏隧道/设置 | 中 | 服务端 403 + UI 隐藏 + 二次确认 |
| 日志/设备信息含敏感数据 | 信息泄露给已配对设备 | 中 | 脱敏（设备 IP/UUID 截断）、按权限字段过滤 |
| 单文件 bundle 变大 | 首次加载慢 | 低 | 首版控制在 100KB 级；必要时 esbuild splitting（需 `chunk` 字段支持） |
| HMR 替换丢 React 状态 | 开发体验即可 | 低 | 状态放 store/Cordis service 或接受 |
| DSH 未来加 CSP | 内联 `<style>`/fetch 被限制 | 低 | 样式改为外部 CSS 路由（`./assets/*`）作为后备；避免 eval |
| 独立监控台与工作台双实现 | 长期维护成本 | 中 | 抽 `admin-service` 单一实现；工作台只做展示层 |

---

## 9. 开放问题与待验证清单

1. **`@deepseek-ai/dsh-client-ui-slots@0.2.2-rc.1` 是否已发布到 npm？** 安装态没有该包目录（它被 Vite 打进 frontend dist），但官方包 devDependencies 引用它。若不可安装：用本地 `shims.d.ts`（只声明 `ctx.slots/locale/layout/remote` 与 `SlotMap` 增强），不 import 该包运行时；这不影响产物（运行时零 DSH UI 依赖）。
2. **`@deepseek-ai/dsh-client-ui-layout/client` 类型是否随包发布**（`MainPanelId` 等）？同类问题，优先用 shim。
3. **DSH 0.2.2-rc.1 之后 `sidebar.panellist` 的排序/置顶语义是否变化**（More 菜单、pin 行为）：实现前用 `cordis_inspect`/实测确认。
4. **是否允许已配对手机执行“低危管理”**（如切换隧道开关）？先按“仅本机”实现，产品确认后可放开白名单。
5. **微信扫码登录/审批在手机上的产品路径**：工作台是内嵌二维码还是跳现有移动流程？扫码本身发生在手机浏览器，但“登录 DSH 账号”的会话属于网关；需产品确认。
6. **日志实时化的选型**：轮询 vs 自建 SSE 路由；后者需要处理 `requestRejection` + 心跳 + 连接清理。
7. **工作台在 DSH 升级时的无感降级**：slot 缺失时是否给用户提示（目前会静默不出现），建议在插件加载诊断里记录一次。
8. 工作台命名/图标/中文文案与 DSH 的视觉规范（`--dsw-alias-*` token、圆角规范）。
9. 生产发布形态：`dsh plugin ... add <path>` 本地链接 vs npm 包安装；客户端 bundle 必须随包发布（`files` 已含 `lib`）。
10. 是否把工作台注册为 `plugins.bundle.config` 的补充（本插件详情页显示网关状态），与主面板入口二选一或并存。

---

## 附录 A：关键证据索引（速查）

| 主题 | 证据 |
|---|---|
| 第三方 client 半侧声明/扫描 | `$SRC/docs/cookbook/adding-a-settings-card.zh.md:56-72`；`$INSTALL/dsh-client-modules/lib/index.js:781-800,105-110,198-208` |
| loader facade / 启动注入 | `$INSTALL/dsh-client-modules/lib/index.js:516-537`；`$SRC/docs/subsystems/client-modules.zh.md:94-102` |
| 真实 bundle 格式 | `$INSTALL/dsh-client-ui-plugin-manager/lib/client.js:1-11`（头）与文件尾；`$SRC/packages/client/tsdown.client.ts:649-670` |
| 共享模块表 | `$INSTALL/dsh-web-frontend/dist/assets/index-BgUyXZcc.js:196`；`$SRC/packages/client/web/src/platform.ts:8-15`；`$SRC/packages/client/web/src/seed.ts:30-42` |
| HMR 轮询 | `$INSTALL/dsh-client-hmr/lib/index.js:22,29,46-50,96-108`；`$INSTALL/dsh-client-hmr/README.zh.md:30-48` |
| 整页面板 + 侧栏入口 | `$INSTALL/dsh-client-ui-layout/lib/client.js:127`；`$INSTALL/dsh-client-ui-sidebar/lib/client.js:206-228`；`$INSTALL/dsh-client-ui-plugin-manager/lib/client.js:7680,7744-7760,7820-7826` |
| settings 内整页 | `$SRC/packages/client/ui-settings/src/client/contract/slots.ts:46-66`；`$INSTALL/dsh-client-ui-settings-general/lib/client.js:1586-1596` |
| no workbench / no route | `$SRC` 全库检索（仅 `ui-dockkit` 测试描述）；`$SRC/docs/subsystems/slots.zh.md`、`web-client.zh.md` |
| 精确 Fetch 路由 | `$INSTALL/dsh-client-connection/lib/index.js:820-838,840-854`；`$SRC/packages/client/connection/src/rpc-host.ts:361-370,401-412`；`$SRC/docs/subsystems/web-server.zh.md:80,110-149` |
| DSH trust fence | `$SRC/packages/client/connection/src/api-request-trust.ts:113-151`；`$SRC/docs/user/guide/public-deployments.zh.md:11-27` |
| 客户端 isLoopback 提示 | `$SRC/packages/client/connection/src/client/index.ts:143-151,268`；`$INSTALL/dsh-client-ui-settings-general/lib/client.js:1403` |
| typert / api-remotes 显式选择 | `$SRC/docs/api-gateway.zh.md:82,104-122,126-132`；`$INSTALL/dsh-api-remotes/lib/client.js:28306-28320` |
| engines.dsh 兼容检查 | `$INSTALL/dsh-app-boot/lib/index.js:1094-1131`；`$SRC/docs/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh/guide.zh.md:11-20` |
| 网关代理改写/注入 | `src/proxy.ts:5-7,180-205,295`（仓库） |
| 网关 local 判定 | `src/gateway.ts:656-673`；`src/util.ts:175-200`（仓库） |
| 网关 admin 仅 local | `src/gateway.ts:860-870,1096-1108`；`src/routes/router.ts:68-71`（仓库） |
| 网关 origin/publicBase | `src/gateway.ts:287-294`（仓库） |
| 网关 admin 路由可复用点 | `src/routes/admin.ts:14-60,95-106`；`src/routes/devices.ts:16-20`（仓库） |
| 现有构建（esbuild） | `scripts/build-web.mjs`（仓库，esm PWA 构建，与客户端 bundle 无关但证明 esbuild 已就绪） |

## 附录 B：术语

- **客户端半侧 / browser half**：包内 `exports["./client"]` 的 lazy-CJS bundle，在 DSH 页面里运行。
- **main panel**：`main` keyed slot，唯一可替换整页的根级面板；`conversation` 是保留 key。
- **panellist**：`sidebar.panellist` list，侧栏全局面板图标；与 main key 同 id。
- **精确 Fetch 路由**：`ctx.connection.fetch.register()` 注册在 `/api/*` 下的一元 HTTP 端点，自动获得 DSH 的栅栏与认证。
- **分类头**：网关在反代时注入、DSH 桥读取的“此请求经网关代理”标记（本文建议名 `x-dsh-gateway-proxied`）。
