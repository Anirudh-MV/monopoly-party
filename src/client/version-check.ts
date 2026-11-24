// ── update detection ──
// Every bundle bakes a build id at build time (esbuild __BUILD_ID__,
// minted in scripts/build-clients.mjs); the server serves its own from
// GET /version. On INEQUALITY — newer OR older, rollbacks count — this
// tab is stale, and a fixed, undismissable pill offers one tap to
// reload. Never auto-reloads: a reload is safe (rejoin tokens restore
// seats; the decision clock bridges the gap) but an uninvited one is
// hostile mid-decision. The pill is the integrity guard, not a hint.

declare const __BUILD_ID__: string

export interface UpdaterOptions {
  socket: { on: (ev: string, fn: () => void) => void }
  title: string
  note: string
  button: string
}

const THROTTLE_MS = 15_000
let lastCheck = 0

function check(opts: UpdaterOptions, force: boolean): void {
  const now = Date.now()
  if (!force && now - lastCheck < THROTTLE_MS) return
  lastCheck = now
  void fetch('/version', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((body: { id?: unknown } | null) => {
      const id = body && typeof body.id === 'string' ? body.id : ''
      // empty or garbage ids are ignored — never banner on noise
      if (!id || id === __BUILD_ID__) {
        document.querySelector('.mp-updater')?.remove()
        return
      }
      if (document.querySelector('.mp-updater')) return
      const pill = document.createElement('div')
      pill.className = 'mp-updater'
      const title = document.createElement('b')
      title.textContent = opts.title
      const note = document.createElement('span')
      note.textContent = opts.note
      const btn = document.createElement('button')
      btn.textContent = opts.button
      btn.addEventListener('click', () => location.reload())
      pill.append(title, note, btn)
      document.body.appendChild(pill)
    })
    .catch(() => {
      /* offline / route missing — nothing to do */
    })
}

export function startUpdater(opts: UpdaterOptions): void {
  check(opts, true) // the load-time check
  // the deploy alarm: every deploy restarts the server, which drops and
  // reconnects every socket — a forced check lands the banner in seconds
  opts.socket.on('connect', () => check(opts, true))
  // backgrounded phones: OS timers are throttled by design, so the unlock
  // path is the visibilitychange → visible check (throttled)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check(opts, false)
  })
  // jittered slow poll — covers exotic bundle-swaps without a restart
  const fiveMin = 5 * 60_000 * (0.8 + Math.random() * 0.4)
  setInterval(() => check(opts, false), fiveMin)
}
