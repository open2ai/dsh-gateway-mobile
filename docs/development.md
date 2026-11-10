# Development

[English](./development.md) | [中文](./development.zh.md)

```powershell
npm install
npm run build             # tsc: src/*.ts -> lib/*.js; esbuild: web/src/*.ts -> web/assets/*.js
npm test                  # builds, then 117 tests
npm run test:integration  # real dsh web + temp profile (needs dsh on PATH)
npm run check-docs        # version/doc/package-list consistency check
npm run pack              # builds, then dist/dsh-gateway-mobile-<version>.zip
```

## Phone asset cache busting

The phone and admin pages are backed by a service worker (`web/sw.js`). Versioning is
generated, no longer hand-maintained:

- `npm run build:web` hashes every generated bundle and the stable CSS files, then writes
  `web/assets/build.json` (`{ version, generatedAt, assets: { "admin.js": "ab12cd34", … } }`).
  The file is git-ignored.
- The gateway rewrites `/mobile/assets/<file>` references in every served HTML document to
  `?v=<content hash from build.json>`, so a rebuilt bundle is fetched even when a page's
  hard-coded `?v=` was not bumped (if the manifest is missing, URLs are left untouched).
- `web/sw.js` fetches `build.json` during install, names its cache from the combined
  version, and derives its shell list from the hashed asset URLs, falling back to a small
  static list when the manifest cannot be fetched.
- Rebuild and commit nothing under `web/assets/*.js`; adjusting CSS or HTML still requires a
  build (`npm run build`) so the hashes change.

## Plugin page introduction

The **Plugins** page in DSH shows the long description the package declares: `meta.detail`
in `locale/<language>.json` when present, otherwise the package README. This repository
uses `docs/DETAIL.zh.md` and `docs/DETAIL.md` so the page stays short and curated instead
of rendering the whole README. `meta.title` and `meta.description` in the same locale files
label the plugin card. When changing the introduction, edit those two documents and keep
the paths declared in `locale/zh.json` and `locale/en.json` in sync; `package.json`'s
`files` list must include `locale/` and `docs/DETAIL*.md` for the published package.

## Layout

```
src/        TypeScript plugin modules (config, tunnel, pairing, auth, proxy, gateway, oauth, ws)
src/routes/ HTTP route modules (public, session, devices, admin, weixin, oauth) + router
lib/        generated JS output from `npm run build` (git-ignored)
web/src/    TypeScript PWA sources (admin, pair, app, devices, oauth, diag, shell, common)
web/assets/ generated browser bundles + stable CSS
test/       node:test suites + fake DSH upstream
scripts/    integration check, frontend build, packaging
pre_docs1/  original product documents (source of truth for intent)
docs/       architecture, API, security, configuration, admin console, development
```

## TypeScript

Both halves are strict: `src/*.ts` and `web/src/*.ts` compile with `strict`,
`noImplicitAny`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; there is no
`// @ts-nocheck`, no class index signature and no explicit `any`. Domain models and Node
HTTP/stream plus browser DOM boundaries are typed; dynamic JSON is validated into
`unknown`/`Record<string, unknown>` at the edge. `npm run typecheck` runs both compilers
without emitting.

## Consistency check: check-docs

```powershell
npm run check-docs            # human-readable ✅/⚠/❌ report
node scripts/check-docs.mjs --json
```

`check-docs` validates that `package.json` (`version`, `engines.dsh`, `engines.node`),
the README status lines and Node/DSH requirements, the first CHANGELOG version,
`docs/DETAIL*.md`, the `version`/`gatewayVersion` examples in `docs/api.md`, and the
version references in `docs/architecture-flow.md` / `docs/deviations.md` all agree. It also
checks that `scripts/pack.mjs` derives its distribution list from `package.json.files` and
that the package list includes the bundle patch, LICENSE and DETAIL documents. Any ❌ exits
1; ⚠ findings (for example a missing `lib/` before the first build) do not.

## Diagnostics: doctor

```powershell
npm run doctor                       # human-readable ✅/⚠/❌ report
npm run doctor -- --json             # machine-readable JSON
npm run doctor -- --strict           # warnings also fail (exit 1)
node scripts/doctor.mjs --json --strict
```

`doctor` is read-only. It checks the Node.js version against `engines.node`, the DSH CLI
version against `engines.dsh`, cloudflared availability (PATH, `CLOUDFLARED_PATH`,
`tunnel.binaryPath` or the cache under the data directory), the configured gateway port,
dataDir writability, whether a DSH profile links this plugin, and whether secret material
exists. It never prints tokens, pairing codes or key contents. Each finding comes with a
suggested fix; any ❌ exits 1, and `--strict` also exits 1 for ⚠. The configured port is
read from the linked profile's `cordis.patch.yml` (best effort) and defaults to 3091;
`DSH_HOME` and `DSH_GATEWAY_DATA_DIR` override the location of the DSH home/data dir.

## Diagnostics: hot-reload check

```powershell
npm run build                        # hmr-check needs lib/ to exist
npm run hmr-check                    # skips with exit 0 when dsh is not on PATH
npm run hmr-check -- --strict        # missing dsh is exit 1 instead of a skip
$env:DSH_BIN = '<dsh-install>\lib\bin.js'
node scripts/hmr-check.mjs
```

`hmr-check` creates a throwaway DSH home (`.dsh-hmr-check`, or `%TEMP%`-independent repo
path), initializes a `gwtest-hmr` profile from the shipped `web` template, links this
repository, and starts `dsh web` on free loopback ports with `tunnel.enabled: false`. It
then waits for the gateway `/health`, touches `lib/index.js`, waits up to 30 s for the host
to re-apply the plugin (observed via a changed deep-health `startedAt`, or a brief
unhealthy window that recovers), and asserts that `/health` is still OK and the gateway
port has exactly one listener. The child process tree is killed on exit (`taskkill /T /F`
on Windows); set `KEEP=1` to keep the temporary DSH home for inspection.

Both scripts are optional developer tooling; they are not part of `npm test`. A missing
cloudflared binary or a stopped gateway is reported as ⚠ rather than ❌ so `doctor` stays
usable before the first start.
