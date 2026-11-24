// Bundles the two browser apps (TV host + phone controller) with esbuild.
// --watch keeps rebuilding while the dev server runs.
import { build, context } from 'esbuild'
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { format } from 'node:util'

// ── build id ──
// Minted on the dev machine (git exists here, never on the droplet) and
// stamped into BOTH the client bundles (esbuild define) and the server
// (dist/build-id.json, served by GET /version). Clients compare their
// baked id against the server's — inequality means "this tab is stale,
// refresh". The timestamp suffix is mandatory even on clean builds: two
// back-to-back builds of the same SHA must never collide — for a
// deploy-detection feature, a MISSED deploy is the catastrophic failure,
// while a false positive costs one free reload of already-fresh bundles.
function computeBuildId() {
  try {
    const sha = execSync('git rev-parse --short=8 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0 ? '-dirty' : ''
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13) // YYYYMMDDTHHMM UTC
    return `${sha}${dirty}-${stamp}`
  } catch {
    return `0.1.0-${Date.now()}`
  }
}

const buildId = process.argv.includes('--watch') ? 'dev' : computeBuildId()

const common = {
  bundle: true,
  format: 'esm',
  target: 'es2020',
  sourcemap: true,
  logLevel: 'info',
  define: { __BUILD_ID__: JSON.stringify(buildId) },
}

const entries = [
  { entryPoints: ['src/client/host/main.ts'], outfile: 'public/host.js' },
  { entryPoints: ['src/client/controller/main.ts'], outfile: 'public/controller.js' },
  { entryPoints: ['src/client/sim/main.ts'], outfile: 'public/sim.js' },
]

const watch = process.argv.includes('--watch')

// The server side of the id: read per-request by GET /version so a
// swapped-without-restart deploy still flips instantly. Written even in
// watch mode ('dev') so the dev server and watch bundles agree — no
// banner noise while developing.
mkdirSync('dist', { recursive: true })
writeFileSync('dist/build-id.json', JSON.stringify({ id: buildId }, null, 2) + '\n')

if (watch) {
  const ctxs = await Promise.all(entries.map((e) => context({ ...common, ...e })))
  await Promise.all(ctxs.map((c) => c.watch()))
  console.log(format('[clients] watching for changes... build id %s', buildId))
} else {
  await Promise.all(entries.map((e) => build({ ...common, ...e })))
  console.log(format('[clients] built public/host.js + public/controller.js, build id %s', buildId))
}
