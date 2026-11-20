// Bundles the two browser apps (TV host + phone controller) with esbuild.
// --watch keeps rebuilding while the dev server runs.
import { build, context } from 'esbuild'

const common = {
  bundle: true,
  format: 'esm',
  target: 'es2020',
  sourcemap: true,
  logLevel: 'info',
}

const entries = [
  { entryPoints: ['src/client/host/main.ts'], outfile: 'public/host.js' },
  { entryPoints: ['src/client/controller/main.ts'], outfile: 'public/controller.js' },
]

const watch = process.argv.includes('--watch')

if (watch) {
  const ctxs = await Promise.all(entries.map((e) => context({ ...common, ...e })))
  await Promise.all(ctxs.map((c) => c.watch()))
  console.log('[clients] watching for changes...')
} else {
  await Promise.all(entries.map((e) => build({ ...common, ...e })))
  console.log('[clients] built public/host.js + public/controller.js')
}
