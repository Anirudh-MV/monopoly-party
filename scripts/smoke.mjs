// End-to-end smoke test: boots the real server, drives a real game through
// socket.io clients (one TV + three phones), then breaks a connection and
// proves reconnect works. Run: npm run smoke

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
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

// ── boot-restore fixture ──
// One valid snapshot, one corrupt file (parse failure), one that parses
// but fails validation. The boot must restore the first — through the same
// validateSnapshot + restoreRoomFromSnapshot the god import uses — and
// QUARANTINE the broken two (renamed .bad, never deleted), then continue.
const SNAPFIX = 'snapshots-test'
mkdirSync(SNAPFIX, { recursive: true })
const FIXTURES = [
  ['ZZZQ.json', JSON.stringify({
    v: 1,
    code: 'ZZZQ',
    hostToken: 'fixture-host-token-000000',
    hostPlayerId: 'fix0',
    turnTimeoutMs: 0,
    players: [
      { meta: { id: 'fix0', name: 'FixA', color: '#8b5cf6', token: '🚢' }, token: 'fixture-seat-token-a' },
      { meta: { id: 'fix1', name: 'FixB', color: '#f43f5e', token: '🚗' }, token: 'fixture-seat-token-b' },
    ],
    state: null,
  })],
  ['ZZZX.json', '{corrupt json,,'],
  ['ZZZY.json', JSON.stringify({ players: 'nope' })],
]
for (const [name, body] of FIXTURES) writeFileSync(`${SNAPFIX}/${name}`, body)

console.log('booting server …')
const server = spawn(process.execPath, ['dist/server/index.js'], {
  env: { ...process.env, PORT: String(PORT), SNAP_DIR: 'snapshots-test' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let bootLog = ''
server.stdout.on('data', (d) => {
  bootLog += String(d)
  process.stdout.write(d)
})
// The quarantine/restore diagnostics log through console.error — the boot
// assertions need them too.
server.stderr.on('data', (d) => {
  bootLog += String(d)
  process.stderr.write(d)
})

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
  // ── boot restore: quarantine + valid-file restore, boot completes ──
  // (The whole rest of this suite running IS the proof the boot continued
  // past the broken files.)
  assert(bootLog.includes('restored room ZZZQ'), 'boot restored the valid snapshot room')
  assert(bootLog.includes('quarantined ZZZX.json'), 'the corrupt JSON file was quarantined')
  assert(bootLog.includes('quarantined ZZZY.json'), 'the invalid snapshot file was quarantined')
  assert(existsSync(`${SNAPFIX}/ZZZX.json.bad`), 'quarantine renames, never deletes (.bad present)')
  assert(existsSync(`${SNAPFIX}/ZZZY.json.bad`), 'the invalid snapshot was renamed out of the boot path too')
  assert(!existsSync(`${SNAPFIX}/ZZZX.json`), 'the broken file is out of the boot path')
  {
    const fixTv = connect()
    const fh = await emitAck(fixTv, 'room:hostJoin', { code: 'ZZZQ', hostToken: 'fixture-host-token-000000' })
    assert(fh.ok, 'a boot-restored room reclaims via its persisted host token')
    fixTv.disconnect()
  }

  // ── room + lobby ──
  const host = connect()
  const created = await emitAck(host, 'room:create')
  assert(created.ok && /^[A-Z]{4}$/.test(created.code || ''), `room created: ${created.code}`)
  const code = created.code
  assert(Array.isArray(created.urls), `join URLs advertised (${(created.urls || []).length} LAN interface(s))`)
  assert(created.urls.every((u) => u.endsWith('code=' + created.code)), 'join URLs carry the room code (QR prefills it)')

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

  // ── lobby leave: the seat is removed before the game starts ──
  {
    let l = null
    host.on('lobby', (x) => {
      l = x
    })
    const extra = connect()
    const eres = await emitAck(extra, 'room:join', { code, name: 'Ravi' })
    assert(eres.ok, 'fourth phone joined the lobby')
    await sleep(100)
    assert(l && l.players.length === 4, 'lobby shows 4 players')
    const lres = await emitAck(extra, 'room:leave', {})
    assert(lres.ok, 'lobby leave accepted')
    await sleep(150)
    assert(l && l.players.length === 3 && !l.players.some((p) => p.name === 'Ravi'), 'lobby back to 3 players')
    extra.disconnect()
  }

  // ── piece change + host kick (lobby only) ──
  {
    let l = null
    host.on('lobby', (x) => {
      l = x
    })
    // the host swaps pieces; the lobby (and the avatar) follow
    const sres = await emitAck(phones[0].sock, 'room:setPiece', { piece: '🚢' })
    assert(sres.ok, 'lobby piece change accepted')
    await sleep(150)
    assert(l && l.players.find((p) => p.id === phones[0].id)?.token === '🚢', 'the lobby shows the new piece')
    // nobody else can take it
    const dres = await emitAck(phones[1].sock, 'room:setPiece', { piece: '🚢' })
    assert(dres && !dres.ok, 'a taken piece stays taken')

    // colours: chosen at join, changeable in the lobby, unique per room
    const zoe = connect()
    let zoeKicked = false
    zoe.on('kicked', () => { zoeKicked = true })
    const cres = await emitAck(zoe, 'room:join', { code, name: 'Zoe', color: '#8b5cf6' })
    assert(cres.ok, 'a colour chosen at join is honoured')
    await sleep(150)
    assert(l && l.players.find((p) => p.name === 'Zoe')?.color === '#8b5cf6', 'the lobby shows the chosen colour')
    // someone else cannot take an occupied colour
    const c2sock = connect()
    const c2res = await emitAck(c2sock, 'room:join', { code, name: 'Rin', color: '#8b5cf6' })
    assert(c2res && !c2res.ok, 'an occupied colour is refused at join')
    c2sock.disconnect()
    const scres = await emitAck(phones[1].sock, 'room:setColor', { color: '#f43f5e' })
    assert(scres.ok, 'lobby colour change accepted')
    await sleep(150)
    assert(l && l.players.find((p) => p.id === phones[1].id)?.color === '#f43f5e', 'the lobby shows the new colour')
    const scdup = await emitAck(phones[2].sock, 'room:setColor', { color: '#f43f5e' })
    assert(scdup && !scdup.ok, 'a taken colour stays taken')
    const scbad = await emitAck(phones[2].sock, 'room:setColor', { color: 'hotpink' })
    assert(scbad && !scbad.ok, 'non-palette colours are refused')

    // the host kicks Zoe; only the host can kick
    const bad = await emitAck(phones[1].sock, 'room:kick', { playerId: cres.playerId })
    assert(bad && !bad.ok, 'only the party host can kick')
    const kres = await emitAck(phones[0].sock, 'room:kick', { playerId: cres.playerId })
    assert(kres.ok, 'host kicked the coloured joiner')
    await sleep(200)
    assert(zoeKicked, 'the kicked phone was told')
    assert(l && l.players.length === 3 && !l.players.some((p) => p.name === 'Zoe'), 'lobby back to 3 after the kick')
    const back = connect()
    const bres = await emitAck(back, 'room:rejoin', { token: cres.token })
    assert(bres && !bres.ok, 'the kicked token is dead')
    back.disconnect()
    zoe.disconnect()
  }

  // ── rename: your own name, lobby only ──
  {
    let l = null
    host.on('lobby', (x) => {
      l = x
    })
    const rres = await emitAck(phones[0].sock, 'room:rename', { name: 'Maya2' })
    assert(rres.ok, 'lobby rename accepted')
    await sleep(150)
    assert(l && l.players.find((p) => p.id === phones[0].id)?.name === 'Maya2', 'TV lobby broadcast shows the new name')
    // someone else's case-variant of it is a duplicate
    const dres = await emitAck(phones[2].sock, 'room:rename', { name: 'maya2' })
    assert(dres && !dres.ok && dres.error === 'Someone already took that name', 'case-insensitive duplicate name refused')
    // the TV is nobody's seat — a host socket cannot rename
    const hres = await emitAck(host, 'room:rename', { name: 'TV' })
    assert(hres && !hres.ok, 'a host socket cannot rename')
  }

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
  assert(
    curPhone.view.waitingOn != null &&
      curPhone.view.waitingOn.kind === 'roll' &&
      curPhone.view.waitingOn.playerId === lastHostView.currentPlayerId &&
      typeof curPhone.view.waitingOn.key === 'string' &&
      curPhone.view.waitingOn.key.startsWith('roll:'),
    "current player's phone view carries waitingOn (kind roll, owned by the roller)",
  )
  assert(
    lastHostView.waitingOn != null &&
      lastHostView.waitingOn.kind === 'roll' &&
      lastHostView.waitingOn.playerId === lastHostView.currentPlayerId,
    'the TV view carries the same waitingOn projection',
  )

  // rename is a lobby-only power: the started game locks names
  const lateRename = await emitAck(phones[0].sock, 'room:rename', { name: 'Maya3' })
  assert(lateRename && !lateRename.ok && lateRename.error === 'The game already started', 'mid-game rename refused')

  // ── drive the game via allowed actions ──
  // Interactive rent (and auctions) pause the table on a pending decision;
  // settleTable closes those so the script always drives from a live phase.
  // Relay cards (birthday, chairman) queue several debts behind one another —
  // with always-outflow the whole table pays through DEBT states now. Drain
  // the relay: each iteration, the debtor's phone taps Pay. When they can't
  // cover a row outright the phone raises funds (sell/mortgage) exactly like
  // a human would — the script never declares bankruptcy. Bounded so a
  // pathological queue can never hang the suite.
  async function settleDebt() {
    for (let n = 0; n < 20 && lastHostView.debt; n++) {
      let acted = false
      const debtorId = lastHostView.debt.debtor
      const phone = phones.find((p) => p.id === debtorId)
      if (phone && phone.view) {
        const acts = phone.view.allowed || []
        if (acts.includes('payDebt')) {
          await emitAck(phone.sock, 'game:action', { type: 'payDebt' })
          acted = true
        } else {
          const owned = Object.entries(phone.view.props || {})
            .filter(([, st]) => st.owner === debtorId)
            .map(([i]) => Number(i))
          const sell = owned.find((i) => acts.includes('sellHouse') && phone.view.props[i].houses > 0)
          const mort = owned.find((i) => acts.includes('mortgage') && !phone.view.props[i].mortgaged)
          if (sell != null) {
            await emitAck(phone.sock, 'game:action', { type: 'sellHouse', space: sell })
            acted = true
          } else if (mort != null) {
            await emitAck(phone.sock, 'game:action', { type: 'mortgage', space: mort })
            acted = true
          }
        }
      }
      await sleep(120)
      if (!acted) return // nothing to raise and nothing to pay — leave it to the clock
    }
  }
  async function settleAuction() {
    for (const p of phones) {
      const acts = (p.view && p.view.allowed) || []
      if (acts.includes('passBid')) {
        await emitAck(p.sock, 'game:action', { type: 'passBid' })
        await sleep(80)
      }
    }
  }
  async function settleTable() {
    for (let k = 0; k < 8; k++) {
      if (lastHostView.debt) {
        await settleDebt()
        continue
      }
      if (lastHostView.auction) {
        // every live auction must name the whole table as the blocker
        assert(
          lastHostView.waitingOn != null &&
            lastHostView.waitingOn.kind === 'auc' &&
            lastHostView.waitingOn.playerId === null,
          'view during an auction: waitingOn is auc with playerId null (everyone)',
        )
        await settleAuction()
        await sleep(120)
        continue
      }
      if (lastHostView.pendingJail) {
        // the announced arrest executes from the arrested player's phone
        const arrested = phones.find((p) => p.id === lastHostView.pendingJail?.player)
        if (arrested) await emitAck(arrested.sock, 'game:action', { type: 'goToJail' })
        await sleep(120)
        continue
      }
      return
    }
  }

  async function playRounds(n, label, minOk) {
    let okCount = 0
    for (let i = 0; i < n; i++) {
      await settleTable()
      const me = phones.find((p) => p.id === lastHostView.currentPlayerId)
      if (!me || !me.view) break
      const acts = me.view.allowed || []
      const action =
        acts.includes('roll') ? { type: 'roll' }
        : acts.includes('drawCard') ? { type: 'drawCard' }
        : acts.includes('goToJail') ? { type: 'goToJail' } // an announced arrest executes from the phone
        : acts.includes('payDebt') ? { type: 'payDebt' } // rent is paid by hand now
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
    assert(okCount >= (minOk ?? Math.min(3, n)), `${label}: ${okCount} actions accepted`)
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

  // ── a stale socket cannot act for a seat that has moved ──
  // The current player reconnects on a new socket; the OLD socket (still
  // open) tries to act for the seat first — and must be refused.
  {
    await settleTable()
    const cur = phones.find((p) => p.id === lastHostView.currentPlayerId)
    const old = cur.sock
    const fresh = connect()
    fresh.on('view', (v) => {
      cur.view = v
    })
    const rres = await emitAck(fresh, 'room:rejoin', { token: cur.token })
    assert(rres.ok, 'current player reconnected on a second socket')
    cur.sock = fresh
    await sleep(150)
    const acts = (cur.view && cur.view.allowed) || []
    const pick = ['payDebt', 'roll', 'drawCard', 'goToJail', 'buy', 'declineBuy', 'passBid', 'payTax', 'endTurn']
    const kind = pick.find((a) => acts.includes(a))
    const probe = kind === 'payTax' ? { type: 'payTax', choice: 'flat' } : kind ? { type: kind } : null
    assert(probe != null, 'current player has a probe action for the stale-socket test')
    if (probe) {
      const staleRes = await emitAck(old, 'game:action', probe)
      assert(staleRes && !staleRes.ok, `stale socket cannot act for the seat (${staleRes && staleRes.error})`)
      const liveRes = await emitAck(fresh, 'game:action', probe)
      assert(liveRes.ok, 'the live connection still can')
    }
    old.disconnect()
  }

  // ── god console ──
  // phones are never allowed in
  const gbad = await emitAck(phones[0].sock, 'god:command', { cmd: 'skipTurn' })
  assert(gbad && !gbad.ok, 'phones cannot use the god console')

  // interactive rent (or a leftover auction) can leave the table paused on
  // a pending decision — settle it so the god flow runs from a clean phase
  await settleTable()
  assert(!lastHostView.debt && !lastHostView.auction, 'the table reached a clean phase for the god flow')

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
    assert(
      curPhone.view.waitingOn != null &&
        curPhone.view.waitingOn.kind === 'draw' &&
        curPhone.view.waitingOn.playerId === curPhone.view.currentPlayerId,
      "drawer's phone view carries waitingOn (kind draw, owned by the drawer)",
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

  // ── god kick mid-game ──
  // Fresh room: kicking shrinks the living table, and the main room still
  // needs its full quorum for the exit section below.
  {
    const tvk = connect()
    const ck = await emitAck(tvk, 'room:create')
    const kphones = []
    for (const n of ['Kim', 'Liv', 'Moa']) {
      const s = connect()
      const res = await emitAck(s, 'room:join', { code: ck.code, name: n })
      kphones.push({ sock: s, id: res.playerId, token: res.token, view: null })
    }
    let kv = null
    tvk.on('view', (v) => {
      kv = v
    })
    for (const p of kphones) p.sock.on('view', (v) => { p.view = v })
    const sk = await emitAck(tvk, 'game:start', {})
    assert(sk.ok, 'three-player game started for the kick test')
    await waitFor(() => kv != null && kphones.every((p) => p.view != null), 8000, 'kick-room views')

    // phones never reach the god console
    const pres = await emitAck(kphones[0].sock, 'god:command', { cmd: 'kick', playerId: kphones[1].id })
    assert(pres && !pres.ok, 'god kick from a phone is rejected')

    let wasKicked = false
    kphones[1].sock.on('kicked', () => {
      wasKicked = true
    })
    const kres = await emitAck(tvk, 'god:command', { cmd: 'kick', playerId: kphones[1].id })
    assert(kres.ok, 'god kicked a player mid-game')
    await sleep(200)
    assert(wasKicked, 'the kicked phone was told')
    assert(kv && kv.players.find((p) => p.id === kphones[1].id)?.bankrupt === true, 'the TV shows them bankrupt')
    assert(kv && kv.phase !== 'GAME_OVER', 'the game is not over — two players remain')
    // the seat's rejoin token died with the eviction
    const back = connect()
    const bres = await emitAck(back, 'room:rejoin', { token: kphones[1].token })
    assert(bres && !bres.ok, 'the kicked token cannot rejoin')
    back.disconnect()
    // the game continues without them
    const cur = kphones.find((p) => p.id === kv.currentPlayerId)
    const acts = (cur && cur.view && cur.view.allowed) || []
    const action = acts.includes('roll') ? { type: 'roll' } : null
    assert(action != null, 'the surviving table is still live')
    if (action && cur) {
      const rres = await emitAck(cur.sock, 'game:action', action)
      assert(rres.ok, 'the game rolls on without the kicked seat')
    }
    for (const p of kphones) p.sock.disconnect()
    tvk.disconnect()
  }

  // ── lobby reset: dissolve the room, mint a fresh one ──
  // Own rooms only — this dissolves seats by design. Covers the council
  // spec: ack shape, phone evacuation, watcher follow, timer carry-over,
  // dead old code/tokens, refusals, snapshot hygiene, and the crown path.
  {
    const rtv = connect()
    const rc = await emitAck(rtv, 'room:create')
    await emitAck(rtv, 'room:settings', { turnTimeoutMs: 120000 })
    let rlobby = null
    rtv.on('lobby', (l) => {
      rlobby = l
    })
    const rp1 = connect()
    const rj1 = await emitAck(rp1, 'room:join', { code: rc.code, name: 'Ada' })
    const rp2 = connect()
    await emitAck(rp2, 'room:join', { code: rc.code, name: 'Bea' })
    let closed1 = null
    let closed2 = null
    let closedW = null
    rp1.on('room:closed', (p) => {
      closed1 = p
    })
    rp2.on('room:closed', (p) => {
      closed2 = p
    })
    const rw = connect()
    await emitAck(rw, 'room:watch', { code: rc.code })
    rw.on('room:closed', (p) => {
      closedW = p
    })
    await sleep(150)

    const nonHost = await emitAck(rp2, 'room:reset')
    assert(nonHost && !nonHost.ok, 'a plain phone cannot reset the room')

    const rres = await emitAck(rtv, 'room:reset')
    assert(rres && rres.ok && /^[A-Z]{4}$/.test(rres.code || ''), 'reset minted a new room')
    assert(rres.code !== rc.code, 'the new room code differs')
    assert(typeof rres.hostToken === 'string' && rres.hostToken.length > 0 && Array.isArray(rres.urls), 'reset ack carries a fresh host token + urls')
    await sleep(350)

    assert(closed1 && closed1.code === rres.code && closed2 && closed2.code === rres.code, 'every seated phone was told the new code')
    assert(closedW && closedW.code === rres.code, 'the mirror was told the new code')
    assert(rlobby && rlobby.code === rres.code && rlobby.players.length === 0, 'the TV is in the fresh empty lobby')
    assert(rlobby && rlobby.turnTimeoutMs === 120000, 'the decision-timer preference carried over')

    const oldJoin = await emitAck(connect(), 'room:join', { code: rc.code, name: 'Zed' })
    assert(oldJoin && !oldJoin.ok, 'the old room code is dead')
    const oldRejoin = await emitAck(connect(), 'room:rejoin', { token: rj1.token })
    assert(oldRejoin && !oldRejoin.ok, 'old rejoin tokens are dead')
    const oldHost = await emitAck(connect(), 'room:hostJoin', { code: rc.code, hostToken: rc.hostToken })
    assert(oldHost && !oldHost.ok, 'the old host token is dead')
    const rtv2 = connect()
    const newHost = await emitAck(rtv2, 'room:hostJoin', { code: rres.code, hostToken: rres.hostToken })
    assert(newHost && newHost.ok, 'the fresh host token reclaims the new room')
    const newJoin = await emitAck(connect(), 'room:join', { code: rres.code, name: 'Cy' })
    assert(newJoin && newJoin.ok, 'a phone can join the new room')
    await sleep(400)
    assert(!existsSync('snapshots-test/' + rc.code + '.json'), 'the old room snapshot is deleted')
    assert(existsSync('snapshots-test/' + rres.code + '.json'), "the new room's snapshot appears")

    // mid-game refusal: start the fresh room and try to reset
    const dj = connect()
    await emitAck(dj, 'room:join', { code: rres.code, name: 'Di' })
    const startNew = await emitAck(rtv, 'game:start', {})
    assert(startNew && startNew.ok, 'the new room starts a game')
    const midReset = await emitAck(rtv, 'room:reset')
    assert(midReset && !midReset.ok, 'a started game refuses the reset (' + (midReset && midReset.error) + ')')
    rtv.disconnect()
    rtv2.disconnect()
    rp1.disconnect()
    rp2.disconnect()
    rw.disconnect()

    // crown phone path: the party host can reset, and the TV follows room:moved
    const ctv = connect()
    const cc = await emitAck(ctv, 'room:create')
    let moved = null
    ctv.on('room:moved', (p) => {
      moved = p
    })
    const cphone = connect()
    await emitAck(cphone, 'room:join', { code: cc.code, name: 'Eve' }) // first joiner = crown
    const crownReset = await emitAck(cphone, 'room:reset')
    assert(crownReset && crownReset.ok && crownReset.code !== cc.code, 'the crown phone can reset the room')
    await sleep(300)
    assert(moved && moved.code === crownReset.code && typeof moved.hostToken === 'string', 'the TV was told to move (room:moved)')
    const ctv2 = connect()
    const movedHost = await emitAck(ctv2, 'room:hostJoin', { code: moved.code, hostToken: moved.hostToken })
    assert(movedHost && movedHost.ok, 'the moved host token reclaims the new room')
    ctv.disconnect()
    ctv2.disconnect()
    cphone.disconnect()
  }

  // ── exit mid-game: forfeit — the estate goes under the hammer ──
  // Runs after every section that needs all phones attached: walking out
  // is an immediate bankrupt-to-bank forfeit. The game plays on without
  // them, their deeds are auctioned, and this phone can never return.
  {
    // never the current player, never the debtor, never an already-kicked
    // bankrupt seat — chosen from a settled state so the game keeps
    // moving right after
    await settleTable()
    const gone = phones.find((p) => {
      const seat = lastHostView.players.find((q) => q.id === p.id)
      return (
        seat != null &&
        !seat.bankrupt &&
        p.id !== lastHostView.currentPlayerId &&
        p.id !== lastHostView.debt?.debtor
      )
    })
    const goneToken = gone.token

    // guarantee the estate has something to auction: god hands them a deed
    await emitAck(host, 'god:command', { cmd: 'setProperty', space: 6, owner: gone.id })
    await sleep(150)
    assert(lastHostView.props[6].owner === gone.id, 'the leaver owns a deed before walking out')

    const xres = await emitAck(gone.sock, 'room:leave', {})
    assert(xres.ok, 'mid-game exit accepted')
    await sleep(200)

    // the seat stays in the array (that is how bankruptcy renders) but is
    // flagged bankrupt on the TV view
    const seat = lastHostView.players.find((p) => p.id === gone.id)
    assert(seat != null, 'their seat stays in the player list')
    assert(seat.bankrupt === true, 'the TV shows them bankrupt')
    assert(seat.connected === false, 'the TV sees them offline')

    // the deed went under the hammer immediately
    assert(lastHostView.auction != null, 'their deed is under the hammer')
    assert(
      lastHostView.waitingOn != null &&
        lastHostView.waitingOn.kind === 'auc' &&
        lastHostView.waitingOn.playerId === null,
      'the liquidation auction blocks the whole table (waitingOn auc, playerId null)',
    )
    const survivor = phones.find((p) => p.id !== gone.id && p.view != null)
    assert(
      survivor && survivor.view.waitingOn != null &&
        survivor.view.waitingOn.kind === 'auc' &&
        survivor.view.waitingOn.playerId === null,
      "a seated phone's view carries waitingOn during the auction (auc, playerId null)",
    )

    // the rejoin token is destroyed — this phone can't wander back
    const back = connect()
    const bres = await emitAck(back, 'room:rejoin', { token: goneToken })
    assert(bres && !bres.ok, 'the destroyed token cannot rejoin')
    back.disconnect()

    // the auctions settle and everyone else keeps playing
    let okCount = 0
    let auctionSettled = false
    for (let i = 0; i < 8; i++) {
      await settleTable()
      if (lastHostView.auction == null) auctionSettled = true
      const me = phones.find((p) => p.id === lastHostView.currentPlayerId)
      if (!me || !me.view) break
      const acts = me.view.allowed || []
      const action =
        acts.includes('roll') ? { type: 'roll' }
        : acts.includes('drawCard') ? { type: 'drawCard' }
        : acts.includes('goToJail') ? { type: 'goToJail' }
        : acts.includes('payDebt') ? { type: 'payDebt' }
        : acts.includes('buy') ? { type: 'buy' }
        : acts.includes('declineBuy') ? { type: 'declineBuy' }
        : acts.includes('payTax') ? { type: 'payTax', choice: 'flat' }
        : acts.includes('passBid') ? { type: 'passBid' }
        : acts.includes('endTurn') ? { type: 'endTurn' }
        : null
      if (!action) break
      const res = await emitAck(me.sock, 'game:action', action)
      if (res.ok) okCount++
      await sleep(60)
    }
    assert(auctionSettled, 'the liquidation auctions settled')
    assert(okCount >= 1, `post-exit gameplay: ${okCount} actions accepted`)
    assert(lastHostView.phase !== 'GAME_OVER', 'the game continues without them')

    // and the exited phone can start over in a different room
    const tv2 = connect()
    const created2 = await emitAck(tv2, 'room:create')
    const fresh = connect()
    const jres = await emitAck(fresh, 'room:join', { code: created2.code, name: gone.name })
    assert(jres.ok, 'the exited phone can join a new lobby')
    fresh.disconnect()
    tv2.disconnect()
  }

  // ── TV reconnect ──
  host.disconnect()
  await sleep(250)
  const host2 = connect()
  const hres = await emitAck(host2, 'room:hostJoin', { code, hostToken: created.hostToken })
  assert(hres.ok, 'TV reconnected with its token')
  assert((hres.urls || []).every((u) => u.endsWith('code=' + code)), 'hostJoin URLs carry the room code too')

  // ── update detection: the build-id pipeline serves a stable non-empty id ──
  {
    const v1 = await fetch(`http://localhost:${PORT}/version`).then((r) => r.json()).catch(() => null)
    const v2 = await fetch(`http://localhost:${PORT}/version`).then((r) => r.json()).catch(() => null)
    assert(v1 && typeof v1.id === 'string' && v1.id.length > 0, 'GET /version serves a non-empty id')
    assert(v2 && v2.id === v1.id, 'the id is stable across requests')
  }

  // ── automatic win detection: a two-player walk-off ends the game ──
  // A fresh room, no host intervention: one player leaves mid-game and the
  // game must detect the win on its own.
  {
    const tv3 = connect()
    const c3 = await emitAck(tv3, 'room:create')
    const pa = connect()
    const ra = await emitAck(pa, 'room:join', { code: c3.code, name: 'Ana' })
    const pb = connect()
    const rb = await emitAck(pb, 'room:join', { code: c3.code, name: 'Bo' })
    assert(ra.ok && rb.ok, 'two phones joined the fresh room')
    let v3 = null
    tv3.on('view', (v) => {
      v3 = v
    })
    const s3 = await emitAck(tv3, 'game:start', {})
    assert(s3.ok, 'two-player game started')
    await waitFor(() => v3 != null && v3.phase !== 'LOBBY', 8000, 'fresh game views')

    // Ana walks out mid-game — forfeit, last one standing
    const xres = await emitAck(pa, 'room:leave', {})
    assert(xres.ok, 'the walk-out was accepted')
    await waitFor(() => v3 && v3.phase === 'GAME_OVER', 8000, 'automatic win detection')
    assert(v3 && v3.winner === rb.playerId, 'Bo wins automatically — no host intervention')
    assert(v3 && v3.players.find((p) => p.id === ra.playerId)?.bankrupt === true, 'Ana is bankrupt on the record')

    pa.disconnect()
    pb.disconnect()
    tv3.disconnect()
  }

  // ── per-socket rate limit: burst → error acks; sustained → disconnect ──
  {
    const tvr = connect()
    const cr = await emitAck(tvr, 'room:create')
    assert(cr.ok, 'rate-limit room created')
    // 'Oth' joins first → the current player; the flood socket is a bystander
    const other = connect()
    const oj = await emitAck(other, 'room:join', { code: cr.code, name: 'Oth' })
    const flood = connect()
    const fj = await emitAck(flood, 'room:join', { code: cr.code, name: 'Fln' })
    assert(oj.ok && fj.ok, 'two phones joined the rate-limit room')
    let ov = null
    let fv = null
    other.on('view', (v) => {
      ov = v
    })
    flood.on('view', (v) => {
      fv = v
    })
    const sk = await emitAck(tvr, 'game:start', {})
    assert(sk.ok, 'rate-limit game started')
    await waitFor(() => ov != null && fv != null, 8000, 'rate-limit views')

    // A burst past the bucket (capacity 30 + 10/s refill): the over-limit
    // events get error acks — never silence — while another player's
    // action still lands.
    const acks = [new Promise((res) => other.emit('game:action', { type: 'roll' }, res))]
    for (let i = 0; i < 45; i++) acks.push(new Promise((res) => flood.emit('game:action', { type: 'roll' }, res)))
    const rs = await Promise.all(acks)
    assert(rs[0] && rs[0].ok === true, `the other player's roll still landed (${rs[0] && rs[0].error})`)
    const served = rs.slice(1).filter((r) => r && r.ok === false && !/slow/i.test(r.error || ''))
    const denied = rs.slice(1).filter((r) => r && r.ok === false && /slow/i.test(r.error || ''))
    assert(denied.length > 0, `over-limit events get rate error acks (${denied.length} of 45)`)
    assert(served.length > 0, `the first ${served.length} burst events were served their normal rejection`)
    assert(ov && ov.dice != null, 'the game state moved despite the flood')

    // Sustained exhaustion: the bucket continuously empty past the 10s
    // rule disconnects the socket — and disconnects are never punished:
    // the SAME seat rejoins cleanly with its stored token.
    let disconnected = false
    flood.on('disconnect', () => {
      disconnected = true
    })
    const t0 = Date.now()
    let sent = 0
    while (Date.now() - t0 < 12_000 && !disconnected) {
      flood.emit('game:action', { type: 'roll' })
      sent++
      await sleep(10)
    }
    assert(disconnected, `sustained flood disconnected the socket after ~${((Date.now() - t0) / 1000).toFixed(1)}s (${sent} events)`)
    const back = connect()
    const bres = await emitAck(back, 'room:rejoin', { token: fj.token })
    assert(bres.ok && bres.playerId === fj.playerId, 'the same seat rejoins cleanly after the rate disconnect')
    back.disconnect()
    other.disconnect()
    tvr.disconnect()
  }

  // ── round-cap presets: the worth victory, end to end ──
  // A Quick-cap room created through the TV settings, started, god-driven to
  // the boundary (export → patch turn via import — the import is validated,
  // so the crafted state must be legal), and asserted to auto-end with the
  // worth winner. Plus the lobby-settings validation probe.
  {
    const tvc = connect()
    const cc = await emitAck(tvc, 'room:create')
    assert(cc.ok, 'cap room created')
    let clobby = null
    tvc.on('lobby', (l) => {
      clobby = l
    })

    // lobby-settings validation probe: the host sets every preset…
    for (const cap of [0, 20, 35, 999]) {
      const res = await emitAck(tvc, 'room:settings', { roundsCap: cap })
      assert(res.ok, `host sets roundsCap ${cap}`)
    }
    await sleep(150)
    assert(clobby && clobby.roundsCap === 999, 'the lobby broadcast carries the cap')
    // …and out-of-range / non-number values are rejected with the standard copy
    for (const bad of [1000, -1, 1.5, 'quick', null, [20]]) {
      const res = await emitAck(tvc, 'room:settings', { roundsCap: bad })
      assert(!res.ok, `room:settings rejects roundsCap ${JSON.stringify(bad)}`)
    }
    // the timer dial still works on the same channel
    const tok = await emitAck(tvc, 'room:settings', { turnTimeoutMs: 120000 })
    assert(tok.ok, 'the timer dial still works beside the cap')

    // three phones join; a plain phone cannot set the cap
    const cphones = []
    for (const n of ['Capa', 'Capb', 'Capp']) {
      const s = connect()
      const res = await emitAck(s, 'room:join', { code: cc.code, name: n })
      assert(res.ok, `phone joined as ${n}`)
      cphones.push({ sock: s, id: res.playerId, view: null })
    }
    const phoneSet = await emitAck(cphones[1].sock, 'room:settings', { roundsCap: 5 })
    assert(phoneSet && !phoneSet.ok, 'a plain phone cannot set the cap')

    // Quick 20 for the boundary drive: cap × 3 players = turn 60 is the
    // boundary turn (ending it would open round 21)
    const quick = await emitAck(tvc, 'room:settings', { roundsCap: 20 })
    assert(quick.ok, 'the room takes Quick 20 for the game')
    await sleep(150)
    assert(clobby && clobby.roundsCap === 20, 'the lobby shows Quick 20')

    let cv = null
    tvc.on('view', (v) => {
      cv = v
    })
    for (const p of cphones) p.sock.on('view', (v) => { p.view = v })
    const sv = await emitAck(tvc, 'game:start', {})
    assert(sv.ok, 'the Quick-cap game started')
    await waitFor(() => cv != null && cphones.every((p) => p.view != null), 8000, 'cap-room views')
    assert(cv && cv.roundsCap === 20, 'the game view carries roundsCap (the TV badge derives Round N of 20 from turn + seats)')

    // god-driven to the boundary: export, patch the turn, re-import
    const eres = await emitAck(tvc, 'god:command', { cmd: 'export' })
    assert(eres.ok && eres.snapshot && eres.snapshot.state, 'god exported the running game')
    const snap = eres.snapshot
    snap.state.turn = 60 // the boundary turn: ending it opens round 21
    snap.state.players[0].cash = 5000 // the worth leader, beyond any dispute
    const ires = await emitAck(tvc, 'god:command', { cmd: 'import', json: snap })
    assert(ires.ok, 'the crafted boundary snapshot imported (validateSnapshot accepted it)')
    await sleep(200)
    assert(cv && cv.turn === 60, 'the game sits on the boundary turn')

    // drive the boundary: the current player finishes turn 60, the cap ends it
    let okActs = 0
    for (let i = 0; i < 40 && cv && cv.phase !== 'GAME_OVER'; i++) {
      if (cv.debt) {
        const debtor = cphones.find((p) => p.id === cv.debt.debtor)
        if (debtor && debtor.view) {
          const acts = debtor.view.allowed || []
          if (acts.includes('payDebt')) await emitAck(debtor.sock, 'game:action', { type: 'payDebt' })
          else if (acts.includes('bankrupt')) await emitAck(debtor.sock, 'game:action', { type: 'bankrupt' })
        }
        await sleep(100)
        continue
      }
      if (cv.auction) {
        for (const p of cphones) await emitAck(p.sock, 'game:action', { type: 'passBid' })
        await sleep(100)
        continue
      }
      if (cv.pendingJail) {
        const arrested = cphones.find((p) => p.id === cv.pendingJail.player)
        if (arrested) await emitAck(arrested.sock, 'game:action', { type: 'goToJail' })
        await sleep(100)
        continue
      }
      const me = cphones.find((p) => p.id === cv.currentPlayerId)
      const acts = (me && me.view && me.view.allowed) || []
      const action =
        acts.includes('roll') ? { type: 'roll' }
        : acts.includes('drawCard') ? { type: 'drawCard' }
        : acts.includes('buy') ? { type: 'buy' }
        : acts.includes('declineBuy') ? { type: 'declineBuy' }
        : acts.includes('payTax') ? { type: 'payTax', choice: 'flat' }
        : acts.includes('endTurn') ? { type: 'endTurn' }
        : null
      if (!me || !action) break
      const res = await emitAck(me.sock, 'game:action', action)
      if (res.ok) okActs++
      await sleep(60)
    }
    assert(okActs >= 1, `boundary drive: ${okActs} actions accepted`)
    let ended = false
    try {
      await waitFor(() => cv != null && cv.phase === 'GAME_OVER', 8000, 'the capped game to auto-end')
      ended = true
    } catch {
      /* asserted below */
    }
    assert(ended && cv && cv.phase === 'GAME_OVER', 'the capped game auto-ended at the boundary')
    assert(cv && cv.turn === 60, 'the boundary turn was the last — no extra turn played')
    assert(
      cv && Array.isArray(cv.winners) && cv.winners.length === 1 && cv.winners[0] === cphones[0].id,
      'the worth leader (the fat wallet) wins',
    )
    assert(cv && cv.winner === cv.winners[0], 'winner === winners[0]')
    assert(cv && cv.roundsCap === 20, 'the served view still carries the cap for the Round N of M badge')
    assert(cv && (cv.log || []).some((l) => l.text.includes('WINS ON WORTH')), 'the game-over log names the worth win')
    assert(cphones[0].view && cphones[0].view.phase === 'GAME_OVER', "the winner's phone shows the game-over screen")
    assert(cphones[0].view && cphones[0].view.winners && cphones[0].view.winners[0] === cphones[0].id, "the winner's phone view carries the winners record")

    // mid-game the cap is a promise, not a preference: changing it is refused
    const midCap = await emitAck(tvc, 'room:settings', { roundsCap: 35 })
    assert(midCap && !midCap.ok, 'a started game refuses cap changes')

    for (const p of cphones) p.sock.disconnect()
    tvc.disconnect()
  }

  // boot-restore fixture cleanup (quarantine keeps party records; the
  // fixtures are ours, so they go)
  for (const f of ['ZZZQ.json', 'ZZZX.json.bad', 'ZZZY.json.bad']) {
    try {
      unlinkSync(`${SNAPFIX}/${f}`)
    } catch {
      /* already gone */
    }
  }
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
