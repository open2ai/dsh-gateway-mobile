import { build } from 'esbuild'

const entries = ['admin', 'app', 'common', 'devices', 'diag', 'oauth', 'pair', 'shell']

await build({
  entryPoints: entries.map((name) => `web/src/${name}.ts`),
  outdir: 'web/assets',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  splitting: false,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
})
