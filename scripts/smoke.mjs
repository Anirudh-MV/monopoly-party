// End-to-end smoke test: boots the real server, drives a real game through
// socket.io clients (one TV + three phones), then breaks a connection and
// proves reconnect works. Run: npm run smoke

import { spawn } from 'node:child_process'
import { io } from 'socket.io-client'

const PORT = 3123
const URL = `http://localhost:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
function assert(cond, msg) {
  if (cond) console.log(`  \u2713 ${msg}`)
  else {
    failed++
    console.error(`  \u2717 ${msg}`)
  }
}

async function waitFor(pred, timeoutMs = 8000, label = 'condition') {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await sleep(50)
  }
}

function connect() {
  return io(URL, { reconnection: false })
}
function emitAck(sock, event, ...args) {
  return new Promise((resolve) => sock.emit(event, ...args, resolve))
}

console.log('booting server …')
const server = spawn(process.execPath, ['dist/server/index.js'], {
  env: { ...process.env, PORT: String(PORT), SNAP_DIR: 'snapshots-test' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', (d) => process.stdout.write(d))
server.stderr.on('data', (d) => process.stderr.write(d))

// Wait for the child to actually bind before dialing it — dialing early
// races the listen() and, with reconnection disabled, wedges the client.
let banner = ''
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server did not announce itself within 20s')), 20000)
  server.stdout.on('data', (d) => {
    banner += String(d)
    if (banner.includes('localhost')) {
      clearTimeout(t)
      resolve()
    }
  })
  server.on('exit', (code) => {
    clearTimeout(t)
    reject(new Error(`server exited early (code ${code}) — is port ${PORT} already in use?`))
  })
})

try {
  // ── room + lobby ──
  const host = connect()
  const created = await emitAck(host, 'room:create')
  assert(created.ok && /^[A-Z]{4}$/.test(created.code || ''), `room created: ${created.code}`)
  const code = created.code
  assert(Array.isArray(created.urls), `join URLs advertised (${(created.urls || []).length} LAN interface(s))`)

  const names = ['Maya', 'Leo', 'Sam']
  const phones = []
  for (const n of names) {
    const s = connect()
    const res = await emitAck(s, 'room:join', { code, name: n })
    assert(res.ok, `phone joined as ${n}`)
    phones.push({ sock: s, id: res.playerId, token: res.token, name: n, view: null })
  }

  const dup = connect()
  const dupRes = await emitAck(dup, 'room:join', { code, name: 'maya' })
  assert(dupRes && !dupRes.ok, 'duplicate name rejected')
  dup.disconnect()

  // ── start ──
  let lastHostView = null
  host.on('view', (v) => {
    lastHostView = v
  })
  for (const p of phones) {
    p.sock.on('view', (v) => {
      p.view = v
    })
  }

  const startRes = await emitAck(host, 'game:start', {})
  assert(startRes.ok, 'host started the game')
  await waitFor(() => lastHostView != null && phones.every((p) => p.view != null), 8000, 'first views')

  assert(lastHostView.players.length === 3, 'TV sees all 3 players')
  assert(phones[0].view.you === phones[0].id, 'phone view is personalised')
  const curPhone = phones.find((p) => p.id === lastHostView.currentPlayerId)
  assert(curPhone.view.allowed.includes('roll'), "current player's phone offers ROLL")

  // ── drive the game via allowed actions ──
  async function playRounds(n, label) {
    let okCount = 0
    for (let i = 0; i < n; i++) {
      const me = phones.find((p) => p.id === lastHostView.currentPlayerId)
      if (!me || !me.view) break
      const acts = me.view.allowed || []
      const action =
        acts.includes('roll') ? { type: 'roll' }
        : acts.includes('drawCard') ? { type: 'drawCard' }
        : acts.includes('buy') ? { type: 'buy' }
        : acts.includes('declineBuy') ? { type: 'declineBuy' }
        : acts.includes('payTax') ? { type: 'payTax', choice: 'flat' }
        : acts.includes('passBid') ? { type: 'passBid' } // a declined buy starts an auction — pass to keep the script moving
        : acts.includes('endTurn') ? { type: 'endTurn' }
        : null
      if (!action) break
      const res = await emitAck(me.sock, 'game:action', action)
      if (res.ok) okCount++
      await waitFor(() => me.view !== null, 4000, 'view refresh')
      await sleep(30)
    }
    assert(okCount >= Math.min(3, n), `${label}: ${okCount} actions accepted`)
    return okCount
  }

  await playRounds(10, 'gameplay')

  // unauthorized action bounces
  const victim = phones.find((p) => p.id !== lastHostView.currentPlayerId)
  const badRes = await emitAck(victim.sock, 'game:action', { type: 'roll' })
  assert(badRes && !badRes.ok, 'non-current player cannot roll')

  // ── reconnect a phone mid-game ──
  const token = phones[1].token
  phones[1].sock.disconnect()
  await sleep(250)
  const rejoined = connect()
  rejoined.on('view', (v) => {
    phones[1].view = v
  })
  const rres = await emitAck(rejoined, 'room:rejoin', { token })
  assert(rres.ok, 'phone reconnected with its stored token')
  phones[1].sock = rejoined
  await sleep(150)
  assert(phones[1].view != null && phones[1].view.you === phones[1].id, 'reconnected phone got its seat back')

  await playRounds(8, 'post-reconnect gameplay')

  // ── a stale socket must not steal the crown ──
  // The host's phone reconnects on a new socket; only afterwards does the
  // OLD socket get closed (in real life socket.io notices ~45s later).
  {
    const old = phones[0].sock
    const fresh = connect()
    fresh.on('view', (v) => {
      phones[0].view = v
    })
    const rres2 = await emitAck(fresh, 'room:rejoin', { token: phones[0].token })
    assert(rres2.ok, 'host phone reconnected on a second socket')
    phones[0].sock = fresh
    await sleep(150)
    old.disconnect() // the stale socket dies late
    await sleep(300)
    assert(lastHostView.hostId === phones[0].id, 'stale socket could not steal the crown')
  }

  // ── god console ──
  // phones are never allowed in
  const gbad = await emitAck(phones[0].sock, 'god:command', { cmd: 'skipTurn' })
  assert(gbad && !gbad.ok, 'phones cannot use the god console')

  // force a reveal and drive the drawer's phone through it
  {
    const curPhone = phones.find((p) => p.id === lastHostView.currentPlayerId)
    const seqBefore = curPhone.view.cardDrawSeq
    const fres = await emitAck(host, 'god:command', { cmd: 'forceDraw', deck: 'chest' })
    assert(fres.ok, 'god forced a Community Chest draw')
    await sleep(150)
    assert(
      curPhone.view.pendingCardDraw && curPhone.view.pendingCardDraw.deck === 'chest',
      "drawer's phone shows the Open prompt",
    )
    const dres = await emitAck(curPhone.sock, 'game:action', { type: 'drawCard' })
    assert(dres.ok, 'drawer opens the chest from their phone')
    await sleep(150)
    assert(curPhone.view.pendingCard != null, 'the drawn card is in the view')
    assert(curPhone.view.cardDrawSeq > seqBefore, 'reveal counted for animations')
  }

  // skip a turn
  {
    const before = lastHostView.currentPlayerId
    const turnBefore = lastHostView.turn
    const sres = await emitAck(host, 'god:command', { cmd: 'skipTurn' })
    assert(sres.ok, 'god skipped the turn')
    await sleep(150)
    assert(
      lastHostView.turn > turnBefore || lastHostView.currentPlayerId !== before,
      'the game advanced after the skip',
    )
  }

  // snapshot export → import round trip, then keep playing
  {
    const eres = await emitAck(host, 'god:command', { cmd: 'export' })
    assert(eres.ok && eres.snapshot && eres.snapshot.state, 'export returned a snapshot with game state')
    const turnBefore = lastHostView.turn
    const ires = await emitAck(host, 'god:command', { cmd: 'import', json: eres.snapshot })
    assert(ires.ok, 'import accepted the snapshot')
    await sleep(150)
    assert(lastHostView.turn === turnBefore, 'game resumed at the same turn after import')
    await playRounds(6, 'post-import gameplay')
  }

  // ── TV reconnect ──
  host.disconnect()
  await sleep(250)
  const host2 = connect()
  const hres = await emitAck(host2, 'room:hostJoin', { code, hostToken: created.hostToken })
  assert(hres.ok, 'TV reconnected with its token')
} catch (err) {
  failed++
  console.error(`  \u2717 smoke crashed: ${err && err.message ? err.message : err}`)
} finally {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    server.kill('SIGKILL')
  }
  await sleep(500)
}

console.log(failed === 0 ? '\nSMOKE PASSED \u2705' : `\nSMOKE FAILED (${failed} assertion(s)) \u274c`)
process.exit(failed === 0 ? 0 : 1)
