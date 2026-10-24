# Development

```powershell
npm install
npm run build             # tsc: src/*.ts -> lib/*.js; esbuild: web/src/*.ts -> web/assets/*.js
npm test                  # builds, then 45 tests
npm run test:integration  # real dsh web + temp profile (needs dsh on PATH)
npm run pack              # builds, then dist/dsh-gateway-mobile-<version>.zip
```

## Phone asset cache busting

The phone pages are backed by a service worker (`web/sw.js`). When changing
`web/assets/app.css`, `pair.css` or a phone bundle, bump the matching `?v=` query in the
page HTML **and** the `CACHE` constant in `sw.js`; otherwise installed PWAs keep serving
the cached files. The admin console uses the same `?v=` convention on its own assets.

## Layout

```
src/        TypeScript plugin modules (config, tunnel, pairing, auth, proxy, gateway, oauth, ws)
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
