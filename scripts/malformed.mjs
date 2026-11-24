// Network-layer hardening test: boots the real server and throws malformed,
// hostile and half-broken payloads at EVERY message type — wrong shapes,
// missing fields, wrong-typed fields, huge strings, fractional numbers,
// prototype-pollution attempts, and the known crash vectors from the
// security review. The server must survive it all, reject everything with
// {ok:false} (or a silent no-op where no ack exists), and keep playing a
// normal game afterwards. Run: npm run malformed
//
// Server must stay up: this is the one property under test.

import { spawn } from 'node:child_process'
import { io } from 'socket.io-client'

const PORT = 3124
const URL = `http://localhost:${PORT}`
// The suite runs the server WITH a party key so the auth gate (express
// middleware + io.use) is exercised — that's where a malformed cookie used
// to crash the whole process.
const PARTY_KEY = 'testpartykey'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
function assert(cond, msg) {
  if (cond) console.log(`  \u2713 ${msg}`)
  else {
    failed++
    console.error(`  \u2717 ${msg}`)
  }
}

function connect() {
  return io(URL, { reconnection: false, auth: { key: PARTY_KEY } })
}
function emitAck(sock, event, ...args) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: 'no ack' }), 5000)
    sock.emit(event, ...args, (res) => {
      clearTimeout(t)
      resolve(res ?? { ok: false, error: 'no ack' })
    })
  })
}

console.log('booting server …')
const server = spawn(process.execPath, ['dist/server/index.js'], {
  env: { ...process.env, PORT: String(PORT), SNAP_DIR: 'snapshots-test', PARTY_KEY },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', (d) => process.stdout.write(d))
server.stderr.on('data', (d) => process.stderr.write(d))
server.on('exit', (code) => {
  server.dead = true
})

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
  const alive = () => !server.dead

  // ── the auth gate must fail closed on hostile headers ──
  // A malformed cookie from ANY other app on the domain used to crash the
  // process (URIError inside io.use). It must simply be rejected.
  {
    const hostile = io(URL, {
      transports: ['polling'],
      extraHeaders: { Cookie: 'x=%zz' },
      reconnection: false,
    })
    const outcome = await new Promise((resolve) => {
      hostile.on('connect', () => resolve('connected'))
      hostile.on('connect_error', () => resolve('rejected'))
      setTimeout(() => resolve('timeout'), 5000)
    })
    hostile.close()
    assert(outcome === 'rejected', `poisoned-cookie socket rejected (${outcome})`)
    assert(alive(), 'server alive after the poisoned cookie')

    const noKey = await fetch(URL).catch(() => null)
    assert(noKey && noKey.status === 401, `express gate 401 without key (${noKey && noKey.status})`)
    const withKey = await fetch(`${URL}/?key=${PARTY_KEY}`).catch(() => null)
    assert(withKey && withKey.status === 200, 'express gate 200 with key')
    assert(alive(), 'server alive after gate pokes')

    // GET /version: gated like everything else, ignores garbage input,
    // serves the build id behind the party key
    const vNoKey = await fetch(`${URL}/version`).catch(() => null)
    assert(vNoKey && vNoKey.status === 401, `version route is gated (${vNoKey && vNoKey.status})`)
    const vOk = await fetch(`${URL}/version?key=${PARTY_KEY}`).catch(() => null)
    const vBody = vOk ? await vOk.json().catch(() => null) : null
    assert(vOk && vOk.status === 200 && vBody && typeof vBody.id === 'string', 'version route serves {id} with the key')
    const vJunk = await fetch(`${URL}/version?key=${PARTY_KEY}&junk=${'x'.repeat(5000)}`).catch(() => null)
    assert(vJunk && vJunk.status === 200, 'version route ignores garbage query input')
    assert(alive(), 'server alive after version pokes')
  }

  // ── stage a normal game so payloads have something to bite ──
  const tv = connect()
  const created = await emitAck(tv, 'room:create')
  assert(created.ok, 'room created')
  const code = created.code
  const players = []
  for (const n of ['Maya', 'Leo', 'Sam']) {
    const s = connect()
    const res = await emitAck(s, 'room:join', { code, name: n })
    assert(res.ok, `phone joined as ${n}`)
    players.push({ sock: s, id: res.playerId, view: null })
  }
  for (const p of players) p.sock.on('view', (v) => { p.view = v })
  let hv = null
  tv.on('view', (v) => { hv = v })
  const started = await emitAck(tv, 'game:start', {})
  assert(started.ok, 'game started')

  // ── the battery ──
  const BIG = 'x'.repeat(100_000)

  const badActions = [
    null,
    undefined,
    42,
    'roll',
    true,
    [],
    {},
    { type: null },
    { type: 7 },
    { type: 'roll', extra: BIG },
    { type: 'roll', __proto__: null },
    { type: 'nope' },
    { type: 'bid' },
    { type: 'bid', amount: 'ten' },
    { type: 'bid', amount: NaN },
    { type: 'bid', amount: 0 },
    { type: 'bid', amount: -5 },
    { type: 'bid', amount: 1.5 },
    { type: 'bid', amount: 1e15 },
    { type: 'bid', amount: { value: 10 } },
    { type: 'buyHouse' },
    { type: 'buyHouse', space: -1 },
    { type: 'buyHouse', space: 40 },
    { type: 'buyHouse', space: 5.5 },
    { type: 'buyHouse', space: '5' },
    { type: 'mortgage', space: 1e9 },
    { type: 'payTax' },
    { type: 'payTax', choice: 'sometimes' },
    { type: 'payTax', choice: null },
    { type: 'proposeTrade', to: players[1].id }, // missing give/receive — crashed the server pre-fix
    { type: 'proposeTrade', to: players[1].id, give: null, receive: null },
    { type: 'proposeTrade', to: players[1].id, give: {}, receive: {} },
    { type: 'proposeTrade', to: players[1].id, give: { cash: 'abc', spaces: [], jailCards: 0 }, receive: { cash: 0, spaces: [], jailCards: 0 } }, // NaN-poison pre-fix
    { type: 'proposeTrade', to: players[1].id, give: { cash: 0, spaces: [], jailCards: 0.5 }, receive: { cash: 0, spaces: [], jailCards: 0 } },
    { type: 'proposeTrade', to: players[1].id, give: { cash: -1, spaces: [], jailCards: 0 }, receive: { cash: 0, spaces: [], jailCards: 0 } },
    { type: 'proposeTrade', to: players[1].id, give: { cash: 0, spaces: [3, 3], jailCards: 0 }, receive: { cash: 0, spaces: [], jailCards: 0 } },
    { type: 'proposeTrade', to: players[1].id, give: { cash: 0, spaces: 'nope', jailCards: 0 }, receive: { cash: 0, spaces: [], jailCards: 0 } },
    { type: 'proposeTrade', to: players[1].id, give: { cash: 0, spaces: [], jailCards: 9 }, receive: { cash: 0, spaces: [], jailCards: 0 } },
    { type: 'proposeTrade', to: BIG, give: { cash: 0, spaces: [], jailCards: 0 }, receive: { cash: 0, spaces: [], jailCards: 0 } },
    { type: 'respondTrade' },
    { type: 'respondTrade', tradeId: 5, accept: 'yes' },
    { type: 'respondTrade', tradeId: 't', accept: 1 },
    { type: 'cancelTrade', tradeId: { deep: { deeper: [BIG] } } },
    { type: { type: 'type' } },
    { __proto__: { type: 'roll' } },
  ]

  let rejected = 0
  const brief = (x) => String(JSON.stringify(x ?? null)).slice(0, 48)
  for (const bad of badActions) {
    // any connected player sends it; who sends it must not matter
    const sender = players[Math.floor(Math.random() * players.length)].sock
    const res = await emitAck(sender, 'game:action', bad)
    if (!res.ok) rejected++
    else console.log('      NOTE: accepted', brief(bad), '→ likely a legal move, fine')
    assert(alive(), `server alive after ${brief(bad)}`)
  }
  assert(rejected >= badActions.length - 3, `malformed actions rejected (${rejected}/${badActions.length} — a couple may be legal moves)`)

  // ── hostile god commands from the TV (valid seat) ──
  const badGods = [
    null,
    'skipTurn',
    { cmd: null },
    { cmd: 'nope' },
    { cmd: 'setCash' },
    { cmd: 'setCash', playerId: players[0].id }, // missing amount
    { cmd: 'setCash', playerId: players[0].id, amount: 'rich' }, // NaN pre-fix
    { cmd: 'setCash', playerId: players[0].id, amount: 1.5 },
    { cmd: 'setCash', playerId: players[0].id, amount: -1 },
    { cmd: 'setCash', playerId: BIG, amount: 100 },
    { cmd: 'setPos', playerId: players[0].id, pos: 99 },
    { cmd: 'setPos', playerId: players[0].id, pos: -1 },
    { cmd: 'setPos', playerId: players[0].id, pos: 4.2 },
    { cmd: 'setJail', playerId: players[0].id, jail: 'yes' },
    { cmd: 'setJailCards', playerId: players[0].id, count: 99 },
    { cmd: 'setJailCards', playerId: players[0].id, count: 0.5 },
    { cmd: 'setProperty', space: 999, owner: null },
    { cmd: 'setProperty', space: 1, owner: 42 },
    { cmd: 'setHouses', space: 1, count: 'many' },
    { cmd: 'setHouses', space: 1, count: -2 },
    { cmd: 'setMortgaged', space: 1, mortgaged: 'maybe' },
    { cmd: 'forceDraw', deck: 'uno' },
    { cmd: 'setTimer', ms: 'soon' },
    { cmd: 'setTimer', ms: -100 },
    { cmd: 'setTimer', ms: 1e12 },
    { cmd: 'replayTurn', playerId: { nested: BIG } },
    { cmd: 'endGame', winner: 7 },
    { cmd: 'kick' },
    { cmd: 'kick', playerId: 42 },
    { cmd: 'kick', playerId: { evil: BIG } },
    { cmd: 'kick', playerId: BIG },
    { cmd: 'kick', playerId: 'ghost' }, // well-formed but nobody's seat
    { cmd: 'import' }, // no json
    { cmd: 'import', json: 'not-an-object' },
    { cmd: 'import', json: { players: 'nope' } },
  ]
  for (const bad of badGods) {
    const res = await emitAck(tv, 'god:command', bad)
    assert(!res.ok, `god rejected ${brief(bad)}`)
    assert(alive(), `server alive after god ${brief(bad)}`)
  }

  // ── hostile room-level messages ──
  const roomCases = [
    ['room:hostJoin', null],
    ['room:hostJoin', { code: code, hostToken: { guess: BIG } }],
    ['room:hostJoin', { code: BIG, hostToken: 'x' }],
    ['room:hostJoin', { code: code.toLowerCase(), hostToken: created.hostToken }], // case-folded but real: must SUCCEED
    ['room:watch', null],
    ['room:watch', { code: 'OIOI' }],
    ['room:watch', { code: BIG }],
    ['room:watch', 5],
    ['room:join', null],
    ['room:join', { code: code, name: 42 }],
    ['room:join', { code: code, name: null }],
    ['room:join', { code: code, name: BIG }],
    ['room:join', { code: BIG, name: 'okay' }],
    ['room:rejoin', null],
    ['room:rejoin', { token: 7 }],
    ['room:rejoin', { token: BIG }],
    ['room:settings', null],
    ['room:settings', { turnTimeoutMs: 'ten minutes' }],
    ['room:settings', { turnTimeoutMs: [] }],
    ['room:settings', { turnTimeoutMs: 1.5 }],
    ['room:settings', { turnTimeoutMs: -50 }],
    ['game:handOver', null],
    ['game:handOver', { to: { evil: BIG } }],
    ['game:start', { force: true }],
    ['room:setPiece', null],
    ['room:setPiece', { piece: 42 }],
    ['room:setPiece', { piece: BIG }],
    ['room:setColor', null],
    ['room:setColor', { color: 'hotpink' }],
    ['room:setColor', { color: { evil: BIG } }],
    ['room:rename', null],
    ['room:rename', { name: 42 }],
    ['room:rename', { name: '' }],
    ['room:rename', { name: '🎲🎲🎲' }],
    ['room:rename', { name: BIG }],
    ['room:rename', { name: { evil: BIG } }],
  ]
  for (const [ev, payload] of roomCases) {
    const res = await emitAck(tv, ev, payload)
    assert(alive(), `server alive after ${ev} ${JSON.stringify(payload).slice(0, 40)}`)
    if (ev === 'room:hostJoin' && payload && payload.hostToken === created.hostToken) {
      assert(res.ok, 'legit hostJoin (case-folded code) still works')
    } else if (res.ok !== undefined && res.ok === true && ev !== 'room:watch' && ev !== 'room:join') {
      // room:watch/join with garbage codes legitimately fail; a stray ok elsewhere is worth seeing
      console.log(`      NOTE: ${ev} accepted ${JSON.stringify(payload).slice(0, 40)}`)
    }
  }

  // a payload where the ack callback belongs (crashed the server pre-fix)
  tv.emit('room:create', { hostile: true })
  await sleep(300)
  assert(alive(), 'server alive after room:create sent with a payload in the ack slot')

  // …and a create storm on one connection: five rooms per socket is the cap
  // (two were already minted above), everything past it is refused.
  for (let i = 0; i < 3; i++) {
    const res = await emitAck(tv, 'room:create')
    assert(res.ok && /^[A-Z]{4}$/.test(res.code || ''), `room:create #${i + 2} on the same connection ok (${res.code})`)
    assert(alive(), 'server alive')
  }
  for (let i = 0; i < 2; i++) {
    const res = await emitAck(tv, 'room:create')
    assert(!res.ok, `room:create refused past the per-socket cap (#${i + 5})`)
    assert(alive(), 'server alive after the refusal')
  }
  assert(alive(), 'server alive after the create storm')

  // ── rename battery: name validation needs a real lobby seat ──
  // (the roomCases above were sent from the TV socket, which is nobody's
  // seat — they die on that guard before the payload is even read)
  {
    const tvr = connect()
    const cr = await emitAck(tvr, 'room:create')
    assert(cr.ok, 'rename battery room created')
    const amy = connect()
    const ar = await emitAck(amy, 'room:join', { code: cr.code, name: 'Amy' })
    const ben = connect()
    const brr = await emitAck(ben, 'room:join', { code: cr.code, name: 'Ben' })
    assert(ar.ok && brr.ok, 'two lobby seats staged')
    let lr = null
    tvr.on('lobby', (x) => {
      lr = x
    })

    const r1 = await emitAck(amy, 'room:rename', null)
    assert(!r1.ok && r1.error === 'Enter your name (letters and numbers)', 'rename null payload rejected')
    assert(alive(), 'server alive after rename null')
    const r2 = await emitAck(amy, 'room:rename', { name: 42 })
    assert(!r2.ok, 'rename non-string name rejected')
    assert(alive(), 'server alive after rename non-string')
    const r3 = await emitAck(amy, 'room:rename', { name: '' })
    assert(!r3.ok, 'rename empty name rejected')
    const r4 = await emitAck(amy, 'room:rename', { name: '🎲🎲🎲' })
    assert(!r4.ok && r4.error === 'Enter your name (letters and numbers)', 'rename emoji-only name rejected (empty after strip)')
    assert(alive(), 'server alive after rename emoji-only')

    // a huge name is silently sliced to 16 chars, exactly like join
    const r5 = await emitAck(amy, 'room:rename', { name: 'x'.repeat(30) })
    assert(r5.ok, 'rename 30+ chars accepted (sliced like join)')
    await sleep(150)
    assert(lr && lr.players.find((p) => p.id === ar.playerId)?.name === 'x'.repeat(16), 'the long name was sliced to 16')

    const r6 = await emitAck(amy, 'room:rename', { name: 'Amelia2' })
    assert(r6.ok, 'rename to a fresh name accepted')
    await sleep(150)
    assert(lr && lr.players.find((p) => p.id === ar.playerId)?.name === 'Amelia2', 'TV lobby broadcast shows the new name')
    const r7 = await emitAck(ben, 'room:rename', { name: 'amelia2' })
    assert(!r7.ok && r7.error === 'Someone already took that name', 'case-insensitive duplicate refused')
    // renaming to your own current name is a no-op, not a duplicate
    const r8 = await emitAck(amy, 'room:rename', { name: 'Amelia2' })
    assert(r8.ok, 'renaming to your own name is a no-op')
    // a host socket has no seat — the guard fires before the payload
    const r9 = await emitAck(tvr, 'room:rename', { name: 'The TV' })
    assert(!r9.ok && r9.error === 'Not your seat', 'a host socket cannot rename')

    // mid-game: the names lock
    const skk = await emitAck(tvr, 'game:start', {})
    assert(skk.ok, 'rename battery game started')
    await sleep(150)
    const r10 = await emitAck(amy, 'room:rename', { name: 'AmyAgain' })
    assert(!r10.ok && r10.error === 'The game already started', 'mid-game rename refused')
    assert(alive(), 'server alive after the mid-game rename refusal')

    amy.disconnect()
    ben.disconnect()
    tvr.disconnect()
  }

  // ── prototype pollution attempt through a snapshot import ──
  const poison = await emitAck(tv, 'god:command', {
    cmd: 'import',
    json: {
      code: 'AAAA',
      hostToken: 't',
      hostPlayerId: null,
      turnTimeoutMs: 300000,
      players: [{ meta: { id: '__proto__', name: 'x', color: '#000', token: '??' }, token: 'tok' }],
      state: { phase: 'ACTION', players: [], currentPlayerId: '__proto__', dice: null, doubles: 0, props: {}, chanceDeck: [], chestDeck: [], pendingCard: null, pendingCardDraw: null, cardDrawSeq: 0, pendingJail: null, pendingPurchase: null, pendingTax: null, pendingMove: null, auction: null, auctionQueue: [], debt: null, debtQueue: [], trades: [], lastLanded: null, lastMove: null, ledger: [], deadline: null, deadlineFor: null, log: [], turn: 1, winner: null },
    },
  })
  assert(alive(), 'server alive after poisoned import (ack ok=' + poison.ok + ')')

  // ── god import: validate-then-commit ──
  // The room is only touched if EVERY field of the snapshot is known-safe;
  // hostile values are normalized (never rendered) or the import is rejected.
  {
    const tvg = connect()
    await new Promise((r) => tvg.emit('room:create', r))
    const seats = (n) =>
      Array.from({ length: n }, (_, i) => ({
        meta: { id: `p${i}`, name: `P${i}`, color: '#000000', token: '🎩' },
        token: `t${i}`,
      }))
    const bare = (over) => ({
      phase: 'ROLL',
      players: [],
      currentPlayerId: 'p0',
      props: {},
      chanceDeck: [],
      chestDeck: [],
      trades: [],
      ledger: [],
      log: [],
      turn: 1,
      doubles: 0,
      cardDrawSeq: 0,
      ...over,
    })
    const tries = [
      ['5000 seats', { players: seats(5000) }],
      ['one seat', { players: seats(1) }],
      ['bad phase', { players: seats(2), state: bare({ phase: 'NOT_A_PHASE' }) }],
      [
        'huge ledger',
        {
          players: seats(2),
          state: bare({
            ledger: Array.from({ length: 10000 }, () => ({ seq: 1, turn: 1, playerId: 'p0', delta: 1, memo: 'x', balance: 1 })),
          }),
        },
      ],
      ['state with no players', { players: seats(2), state: bare({}) }],
    ]
    for (const [label, json] of tries) {
      const res = await emitAck(tvg, 'god:command', { cmd: 'import', json })
      assert(!res.ok, `import rejected: ${label}`)
      assert(alive(), `server alive after import: ${label}`)
    }

    const big = { players: seats(2), junk: 'x'.repeat(300 * 1024) }
    const bres = await emitAck(tvg, 'god:command', { cmd: 'import', json: big })
    assert(!bres.ok, 'import rejected: oversized payload')
    assert(alive(), 'server alive after the oversized import')

    // a hostile COLOR/PIECE is normalized to safe values, never rendered
    const xres = await emitAck(tvg, 'god:command', {
      cmd: 'import',
      json: {
        players: [
          { meta: { id: 'p0', name: 'Evil', color: 'red"><img src=x onerror=alert(1)>', token: '<script>alert(1)</script>' }, token: 'tk0' },
          { meta: { id: 'p1', name: 'Good', color: '#123456', token: '🚗' }, token: 'tk1' },
        ],
      },
    })
    const eres = await emitAck(tvg, 'god:command', { cmd: 'export' })
    const snapPlayers = eres.snapshot && eres.snapshot.players
    const okColor = Array.isArray(snapPlayers) && snapPlayers.every((p) => /^#[0-9a-f]{6}$/i.test(p.meta.color))
    const okToken = Array.isArray(snapPlayers) && snapPlayers.every((p) => typeof p.meta.token === 'string' && p.meta.token.length <= 8 && !p.meta.token.includes('<'))
    assert(xres.ok && okColor && okToken, 'injected color/piece normalized to safe values')
    tvg.close()
  }

  // ── god kick: TV-only, guarded, idempotent-refusing ──
  {
    // a phone must never reach the god console
    const pres = await emitAck(players[0].sock, 'god:command', { cmd: 'kick', playerId: players[1].id })
    assert(pres && !pres.ok, 'god kick from a phone is rejected')

    // the create storm moved the first TV onto junk rooms — reattach one
    const tvk = connect()
    let kv = null
    tvk.on('view', (v) => {
      kv = v
    })
    const hj = await emitAck(tvk, 'room:hostJoin', { code, hostToken: created.hostToken })
    assert(hj.ok, 'a TV reattached to the original room')

    // the kick lands mid-game: the phone is told, the TV records the forfeit
    let leoKicked = false
    players[1].sock.on('kicked', () => {
      leoKicked = true
    })
    const kres = await emitAck(tvk, 'god:command', { cmd: 'kick', playerId: players[1].id })
    assert(kres.ok, 'god kicked a player mid-game')
    await sleep(200)
    assert(leoKicked, 'the kicked phone was told')
    assert(kv && kv.players.find((p) => p.id === players[1].id)?.bankrupt === true, 'the TV shows them bankrupt')
    assert(alive(), 'server alive after the kick')

    // kicking a bankrupt player is refused
    const kres2 = await emitAck(tvk, 'god:command', { cmd: 'kick', playerId: players[1].id })
    assert(kres2 && !kres2.ok, 'kicking a bankrupt player is refused')
    assert(alive(), 'server alive after the refusal')
    tvk.close()
  }

  // ── the game must still be fully playable ──
  // The TV socket moved to fresh rooms during the create storm; the original
  // game room is still live on the phone sockets — check through them. The
  // god-kicked seat is gone from the living table, so it is excluded.
  await sleep(300)
  const standing = players.filter((p) => p.id !== players[1].id)
  const phoneView = standing.find((p) => p.view && p.view.phase)
  assert(phoneView != null, 'phones still receive views from the original game')
  const active = standing.find((p) => p.view && (p.view.allowed || []).length > 0)
  assert(active != null, 'a phone still has legal moves after the barrage')
  if (active) {
    const first = active.view.allowed.find((a) =>
      ['roll', 'drawCard', 'buy', 'declineBuy', 'payTax', 'passBid', 'endTurn'].includes(a),
    )
    const action = first === 'payTax' ? { type: 'payTax', choice: 'flat' } : { type: first }
    const res = await emitAck(active.sock, 'game:action', action)
    assert(res.ok, `legal action still accepted after the barrage (${first})`)
  }
  assert(alive(), 'server alive at the end')

  // NaN must never be in any player's cash
  const cashes = ((phoneView && phoneView.view.players) || []).map((p) => p.cash)
  assert(cashes.length > 0 && cashes.every((c) => Number.isInteger(c)), `cash never corrupted (${cashes.join(', ')})`)

  console.log(failed === 0 ? '\nMALFORMED-PAYLOAD TEST PASSED ✅' : `\nMALFORMED-PAYLOAD TEST FAILED (${failed}) ❌`)
} catch (e) {
  failed++
  console.error('test error:', e)
} finally {
  server.kill()
}

process.exit(failed === 0 && !server.dead ? 0 : 1)
