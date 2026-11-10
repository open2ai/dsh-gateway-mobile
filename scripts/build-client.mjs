/**
 * Build the DSH browser half of dsh-gateway-mobile.
 *
 * The DSH client-modules system loads a package's `./client` export as a
 * lazy-CJS factory: a classic script that only registers
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 *
 * with the page's module loader. The module body runs when the factory is
 * materialized; `require()` resolves against the shell's frozen platform
 * module table, so React and every DSH client package must stay external.
 *
 * This build is intentionally independent from `scripts/build-web.mjs` (the
 * standalone PWA/admin console build). It writes a single file, `lib/client.js`.
 *
 * Usage:
 *   node scripts/build-client.mjs           # one-shot build
 *   node scripts/build-client.mjs --watch   # rebuild on change (DSH HMR swaps)
 *
 * @module dsh-gateway-mobile/scripts/build-client
 */

import { readFile } from 'node:fs/promises'
import { build, context } from 'esbuild'

const root = new URL('..', import.meta.url)
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

/**
 * Modules the DSH Web shell provides through its frozen platform table.
 * They must never be bundled: a second React (or a second zod instance)
 * breaks hooks and identity checks. Only `react` / `react/jsx-runtime` are
 * imported by our client code today; the rest are listed defensively so a
 * future accidental import fails loudly instead of silently inlining.
 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const banner = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`,
  'var module = { exports: {} };',
  'var exports = module.exports;',
  'Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
].join('\n')

const footer = ['return module.exports;', '}});'].join('\n')

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [new URL('src/client/index.tsx', root).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
  outfile: new URL('lib/client.js', root).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  jsxImportSource: 'react',
  external: PLATFORM_MODULES,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  legalComments: 'none',
  sourcemap: true,
  logLevel: 'info',
  banner: { js: banner },
  footer: { js: footer },
}

if (process.argv.includes('--watch')) {
  const ctx = await context(options)
  await ctx.watch()
  console.log('[build-client] watching src/client → lib/client.js')
} else {
  await build(options)
}
