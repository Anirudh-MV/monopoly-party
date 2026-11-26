// ── The one commit path + the decision clock ──
// Every state change funnels through commit(): clone, apply, commit only on
// success, then ONE broadcast — which re-schedules the decision clock, runs
// the stall watchdog, arms the auction grace fuse and flushes the snapshot.
// The clock's expiry plays (auto-actions, the watchdog's remedy) commit
// through the same path, so commit → broadcast → clock is ONE loop and lives
// in ONE module; the lobby, god and socket layers only call into it.
//
// Also lives here, as state-transition plays on behalf of a seat:
//   - forfeitSeat   — the one estate rule (voluntary exit / god kick)
//   - remedyActionsFor — the watchdog's rescue table (exported for checks)

import type { Server as IOServer } from 'socket.io'
import {
  applyAction,
  declareBankruptcy,
  forfeitEstate,
  liquidationPlan,
  MAX_GAME_LOG,
  type Result,
} from '../shared/engine.js'
import { hostView, playerView } from '../shared/views.js'
import { allowedActions, alivePlayers, blockingDecision, netWorth } from '../shared/rules.js'
import type { Action, GameState } from '../shared/types.js'
import {
  AUCTION_DISCONNECT_GRACE_MS,
  AUCTION_IDLE_MS,
  AUCTION_OPEN_MS,
  getIoRef,
  hostRoom,
  lobbyInfo,
  playerRoom,
  type Room,
  safe,
} from './core.js'
import { saveRoom } from './persist.js'

const MAX_LOG = MAX_GAME_LOG

// ── The one commit path ──
// `mutate` is one of:
//   - an Action            → applied for `actor` (the socket player path)
//   - a [by, Action] list   → applied in order (timer/auto paths); the
//                            commit carries every step the reducer accepted
//   - a function           → raw engine mutation (god console, forfeit);
//                            returning {ok:false} vetoes the commit
//
// The `gate` option is the socket player-action path ONLY: it asks the
// engine's own allowedActions list BEFORE the state is even cloned, so an
// illegal action from a phone costs no state copy. God (the tamper-proof TV
// console), forfeits, decision-clock auto-actions and imports deliberately
// bypass the gate — the reducer still enforces legality on every path, so
// the gate is an optimization, not a second source of truth.
export function commit(
  room: Room,
  io: IOServer | null,
  actor: string,
  mutate: Action | Array<[string, Action]> | ((s: GameState) => Result | void),
  opts: { broadcast?: boolean; gate?: boolean } = {},
): Result {
  const cur = room.state
  if (!cur) return { ok: false, error: 'No game running' }
  if (opts.gate && !Array.isArray(mutate) && typeof mutate !== 'function') {
    if (!allowedActions(cur, actor).includes(mutate.type)) {
      return { ok: false, error: `You can't do that right now (${mutate.type})` }
    }
  }
  const next = structuredClone(cur)
  let res: Result = { ok: true }
  if (typeof mutate === 'function') {
    const r = mutate(next)
    if (r != null && !r.ok) res = r
  } else if (Array.isArray(mutate)) {
    // Timer/auto path: apply in order against one clone; a failed step
    // just means the state moved on — exactly what the per-action commit
    // loop did before, minus the intermediate (never-emitted) copies.
    let any = false
    let firstError = 'rejected'
    for (const [by, action] of mutate) {
      const r = applyAction(next, action, by)
      if (r.ok) any = true
      else if (!any) firstError = r.error
    }
    if (!any) res = { ok: false, error: firstError }
  } else {
    const r = applyAction(next, mutate, actor)
    if (!r.ok) res = r
  }
  if (!res.ok) return res
  room.state = next
  if (opts.broadcast !== false && io) broadcastGame(io, room)
  return { ok: true }
}

export function broadcastLobby(io: IOServer, room: Room): void {
  const info = lobbyInfo(room)
  io.to(hostRoom(room.code)).emit('lobby', info)
  for (const e of room.players) io.to(playerRoom(room.code, e.meta.id)).emit('lobby', info)
  void saveRoom(room)
}

export function broadcastGame(io: IOServer, room: Room): void {
  let s = room.state
  if (!s) return

  // Safety: a phone that has been gone for a while mid-auction is auto-passed
  // so a missing device can never stall the table — but a screen-lock blip
  // gets a grace period first. Copy-and-commit through the one commit path —
  // no broadcast here, THIS call is the broadcast: a failed pass never
  // leaves half-applied state behind, and the pass below rides the same
  // clone-apply-commit rules as every other state change.
  if (s.phase === 'AUCTION' && s.auction) {
    const due = auctionGraceActions(room)
    if (due.length > 0) {
      commit(room, io, '', due, { broadcast: false })
      if (room.state) s = room.state
    }
  }

  for (const e of room.players) {
    const p = s.players.find((q) => q.id === e.meta.id)
    if (p) p.connected = e.socketId != null
  }

  // Stall watchdog: if the game is waiting on a decision whose owner has no
  // legal move (a rules-combination bug), attempt a targeted rescue instead
  // of hanging the party — and fall through to normal emission either way,
  // so a failed remedy never leaves clients on a stale view. The check is
  // precise: the decision's OWNER must be able to act. ("Nobody can act"
  // was too coarse — proposeTrade and bankrupt are almost always available,
  // which blinded the old check to real stalls.)
  if (s.phase !== 'GAME_OVER' && !room.watchdogBusy && alivePlayers(s).length > 1) {
    const decision = blockingDecision(s)
    const stuck = decision != null && decision.playerId != null && allowedActions(s, decision.playerId).length === 0
    if (stuck) {
      console.error(`[watchdog] room ${room.code}: stuck at phase ${s.phase}, turn ${s.turn} — attempting remedy`)
      const remedy = remedyActionsFor(s)
      let committed = false
      room.watchdogBusy = true
      try {
        if (remedy.length > 0) committed = applyServerAction(room, remedy)
      } finally {
        room.watchdogBusy = false
      }
      if (committed) return // the nested broadcastGame shipped views + snapshot
      console.error(
        `[watchdog] room ${room.code}: remedy ${remedy.length > 0 ? 'rejected' : 'unavailable'} — shipping state as-is for diagnosis`,
      )
      // fall through: emit whatever we have
    }
  }

  // The deadline lives on the state so every view carries it.
  scheduleDeadline(room)
  // …and a missing phone mid-auction gets its own guaranteed fuse, so the
  // grace pass happens even when nothing else re-broadcasts the room.
  scheduleAuctionGrace(room)

  io.to(hostRoom(room.code)).emit('view', hostView(s, room.code, room.hostPlayerId, room.turnTimeoutMs))
  for (const e of room.players) {
    io.to(playerRoom(room.code, e.meta.id)).emit('view', playerView(s, room.code, e.meta.id, room.hostPlayerId, room.turnTimeoutMs))
  }
  void saveRoom(room)
}

// Lobby or game, whichever the room is in.
export function broadcast(room: Room, io: IOServer): void {
  if (room.state) broadcastGame(io, room)
  else broadcastLobby(io, room)
}

// The seats a live auction is waiting on that have been gone past the
// grace window: alive, not yet passed, not the high bidder, and
// disconnected. Extracted verbatim from the old inline broadcastGame check
// (same seats it passed today) — exported so the remedy checks can pin
// predicate parity.
export function auctionGraceActions(room: Room): Array<[string, Action]> {
  const s = room.state
  const due: Array<[string, Action]> = []
  if (!s || s.phase !== 'AUCTION' || !s.auction) return due
  for (const e of room.players) {
    const p = s.players.find((q) => q.id === e.meta.id)
    if (
      p &&
      !p.bankrupt &&
      e.socketId == null &&
      e.disconnectedAt != null &&
      Date.now() - e.disconnectedAt >= AUCTION_DISCONNECT_GRACE_MS &&
      !s.auction.passed.includes(p.id) &&
      s.auction.bidder !== p.id
    ) {
      due.push([p.id, { type: 'passBid' }])
    }
  }
  return due
}

// ── Auction disconnect grace: a guaranteed one-shot fuse ──
// The piggybacked check above only fires when something else re-broadcasts;
// this timer makes the pass happen even when the room is otherwise quiet.
// Every rejoin/re-broadcast re-evaluates it (fresh disconnectedAt, a new
// bidder, the auction over) — the same clear-and-re-arm pattern the
// decision clock's timerKey machinery uses. One-shot: when it fires, the
// commit's own broadcast re-arms whatever fuse (if any) comes next.
function scheduleAuctionGrace(room: Room): void {
  const clear = (): void => {
    if (room.graceTimer) clearTimeout(room.graceTimer)
    room.graceTimer = null
    room.graceKey = null
  }
  const s = room.state
  if (!s || s.phase !== 'AUCTION' || !s.auction) {
    clear()
    return
  }
  // The earliest moment an eligible seat crosses the grace line.
  let dueAt: number | null = null
  let seat = ''
  for (const e of room.players) {
    const p = s.players.find((q) => q.id === e.meta.id)
    if (!p || p.bankrupt || e.socketId != null || e.disconnectedAt == null) continue
    if (s.auction.passed.includes(p.id) || s.auction.bidder === p.id) continue
    const at = e.disconnectedAt + AUCTION_DISCONNECT_GRACE_MS
    if (dueAt == null || at < dueAt) {
      dueAt = at
      seat = p.id
    }
  }
  if (dueAt == null) {
    clear()
    return
  }
  const key = `aucgrace:${s.auction.space}:${seat}:${dueAt}`
  if (room.graceKey === key) return // already ticking for this seat/moment
  if (room.graceTimer) clearTimeout(room.graceTimer)
  room.graceKey = key
  room.graceTimer = setTimeout(() => {
    safe('auction grace', undefined, () => {
      room.graceTimer = null
      room.graceKey = null
      const st = room.state
      if (!st || st.phase !== 'AUCTION' || !getIoRef()) return
      const due = auctionGraceActions(room)
      if (due.length === 0) return
      commit(room, getIoRef(), '', due) // the commit's broadcast re-arms the next fuse
    })
  }, Math.max(0, dueAt - Date.now()))
}

// The rescue the watchdog plays for a stuck state, by phase and pendings:
// reveal any pending card, resolve any pending purchase/tax, then fall back
// to advancing the turn. Pure — exported for the remedy checks.
export function remedyActionsFor(s: GameState): Array<[string, Action]> {
  const cur = s.currentPlayerId
  if (s.phase === 'DEBT' && s.debt) {
    const p = s.players.find((q) => q.id === s.debt?.debtor)
    const amount = s.debt.amount
    return [[s.debt.debtor, p && p.cash >= amount ? { type: 'payDebt' } : { type: 'bankrupt' }]]
  }
  if (s.phase === 'ACTION') {
    if (s.pendingJail) return [[s.pendingJail.player, { type: 'goToJail' }]]
    if (s.pendingCardDraw) return [[cur, { type: 'drawCard' }]]
    if (s.pendingPurchase != null) return [[cur, { type: 'declineBuy' }]]
    if (s.pendingTax) return [[cur, { type: 'payTax', choice: 'flat' }]]
    return [[cur, { type: 'endTurn' }]]
  }
  if (s.phase === 'ROLL') return [[cur, { type: 'roll' }]]
  return []
}

// ── The one estate rule ──
// What happens to a seat's holdings when its human walks out mid-game
// (voluntary exit) or the host removes them (god kick): an immediate
// bankrupt forfeit. A pending PLAYER-debt routes through
// declareBankruptcy instead — the lender inherits the estate per the
// existing, tested rules. The headline logs BEFORE routing so both
// branches leave a trace of the leaving itself. Pure (engine-only) —
// exported for the scenario suite; the caller commits via
// clone-apply-commit.
export function forfeitSeat(s: GameState, pid: string, headline: string): Result {
  const p = s.players.find((q) => q.id === pid)
  if (!p) return { ok: false, error: 'Not in this game' }
  if (p.bankrupt) return { ok: false, error: 'Already bankrupt' }
  s.log.push({ text: headline, kind: 'bad' })
  if (s.log.length > MAX_LOG) s.log.splice(0, s.log.length - MAX_LOG)
  if (s.phase === 'DEBT' && s.debt && s.debt.debtor === pid && s.debt.creditor != null) {
    // a walk-off win still reads like one, even when the lender gets paid
    return declareBankruptcy(s, p, true)
  }
  return forfeitEstate(s, pid)
}

// ── Decision deadlines ──

// What single decision is currently blocking play, if any: the room layer
// calls the shared blockingDecision() projection (shared/rules.ts) — the
// exact same helper that fills HostView.waitingOn for every screen, so the
// clock and the phones can never disagree on who/what blocks. Only the
// key and playerId matter to the clock; the kind rides along for the views.

// The debt-clock expiry play. An affordable debt is one tap away — pay it.
// An unaffordable one liquidates minimally (liquidationPlan) and pays on the
// same single commit; only when even a full liquidation cannot cover the
// bill does the existing bankruptcy cascade fire. The headline (rooms layer,
// same pattern as forfeitSeat) logs on that same commit. Pure on the state —
// exported for the scenario suite.
export function debtAutoActions(s: GameState, playerId: string): { autos: Array<[string, Action]>; headline: string | null } {
  const d = s.debt
  const p = s.players.find((q) => q.id === playerId)
  const amount = d?.amount ?? 0
  if (!d || d.debtor !== playerId || !p) return { autos: [], headline: null }
  if (p.cash >= amount) return { autos: [[playerId, { type: 'payDebt' }]], headline: null }
  const plan = liquidationPlan(s, playerId, amount)
  if (plan.length > 0) {
    // The plan is only used when replaying it actually covers the bill — a
    // partial liquidation must never commit ahead of a bankruptcy. Replay
    // on a scratch copy: each step was planned against exactly this state.
    const sim = structuredClone(s)
    for (const [by, act] of plan) applyAction(sim, act, by)
    const simP = sim.players.find((q) => q.id === playerId)
    if (simP && simP.cash >= amount) {
      return {
        autos: [...plan, [playerId, { type: 'payDebt' }]],
        headline: `⏰ Time's up — the bank liquidates ${p.name}'s estate to cover the $${amount} debt`,
      }
    }
  }
  return {
    autos: [[playerId, { type: 'bankrupt' }]],
    headline: `⏰ Time's up — even fully liquidated, ${p.name} can't cover the $${amount}`,
  }
}

// The sensible default each deadline plays on expiry.
// The deadline machinery's working type: the key and the owner are all
// the auto-play table needs (decisionFor's slim answer satisfies it).
interface ClockedDecision {
  key: string
  playerId: string | null // null = everyone (auction)
}

function autoActionsFor(room: Room, d: ClockedDecision): Array<[string, Action]> {
  const s = room.state
  if (!s || !d.playerId) return []
  if (d.key.startsWith('roll:')) return [[d.playerId, { type: 'roll' }]]
  if (d.key.startsWith('jail:')) return [[d.playerId, { type: 'goToJail' }]]
  if (d.key.startsWith('draw:')) return [[d.playerId, { type: 'drawCard' }]]
  if (d.key.startsWith('buy:')) return [[d.playerId, { type: 'declineBuy' }]]
  if (d.key.startsWith('tax:')) {
    const flat = 200
    const percent = Math.ceil(netWorth(s, d.playerId) / 10)
    return [[d.playerId, { type: 'payTax', choice: percent < flat ? 'percent' : 'flat' }]]
  }
  if (d.key.startsWith('end:')) return [[d.playerId, { type: 'endTurn' }]]
  if (d.key.startsWith('debt:')) {
    // autoSettle: liquidate minimally, then pay — bankruptcy only when even
    // a full liquidation cannot cover the bill.
    return debtAutoActions(s, d.playerId).autos
  }
  return []
}

// The single source of truth for the decision clock, pure so the remedy
// checks can test it directly: which decision is ticking, whose hands are
// tied, and how long it gets. null = no clock (nothing is blocking play).
//
// With the host timer ON, the host clock governs byte-identically to the
// classic behaviour (auctions keep their min() shape). With the timer OFF,
// every blocking decision still arms a FIXED default — one idle phone can
// never stall a timer-off table, the expiry plays the sensible default:
//   roll 60s (auto-roll) · draw 30s · buy 60s (decline → auction) ·
//   tax 60s (cheaper of flat/percent) · jail/end 30s ·
//   debt 30s affordable / 90s raise-funds (expiry auto-settles) ·
//   auction 30s open / 15s after a bid (the hammer path).
// Trades and portfolio taps are never clocked at any setting, and during a
// DEBT freeze the clock belongs to exactly one blocking owner: the debtor.
export function decisionFor(s: GameState, turnTimeoutMs: number): { key: string; playerId: string | null; ms: number } | null {
  const decision = blockingDecision(s)
  if (!decision) return null
  const key = decision.key
  // Arrests and end-of-turn waits run on a fixed 30-second clock at any
  // host setting — they must never strand.
  if (key.startsWith('jail:') || key.startsWith('end:')) return { key, playerId: decision.playerId, ms: 30_000 }
  if (key.startsWith('debt:')) {
    const d = s.debt
    if (!d) return null
    const debtor = s.players.find((q) => q.id === d.debtor)
    if (debtor && debtor.cash >= d.amount) return { key, playerId: decision.playerId, ms: 30_000 }
    // Unaffordable: the host clock when it's on; a fixed 90-second
    // raise-funds window when it's off — on expiry the bank auto-settles
    // the estate (liquidationPlan) instead of bankrupting a recoverable seat.
    return { key, playerId: decision.playerId, ms: turnTimeoutMs > 0 ? turnTimeoutMs : 90_000 }
  }
  if (key.startsWith('auc:')) {
    // Auctions: a generous opening window, then a short fuse that every bid
    // resets. The host fuse shortens it when set below the fixed windows.
    const auctionIdle = s.auction != null && (s.auction.bidder != null || s.auction.bid > 0)
    const ms = auctionIdle ? AUCTION_IDLE_MS : AUCTION_OPEN_MS
    return { key, playerId: decision.playerId, ms: turnTimeoutMs > 0 ? Math.min(turnTimeoutMs, ms) : ms }
  }
  if (turnTimeoutMs > 0) return { key, playerId: decision.playerId, ms: turnTimeoutMs }
  // Timer-off defaults: the phase names the wait, the wait names the clock.
  const fixed = key.startsWith('roll:') ? 60_000
    : key.startsWith('draw:') ? 30_000
    : key.startsWith('buy:') ? 60_000
    : key.startsWith('tax:') ? 60_000
    : 0
  // Only {key, playerId, ms} ships on purpose: the clock answer stays
  // stable even if the projection grows new fields (the kind never clocked).
  return fixed > 0 ? { key, playerId: decision.playerId, ms: fixed } : null
}

function scheduleDeadline(room: Room): void {
  const s = room.state
  if (!s) return
  const decision = decisionFor(s, room.turnTimeoutMs)
  if (!decision) {
    // Host disabled the decision clock entirely (and no fixed-clock wait is
    // pending), or nothing is blocking play.
    if (room.timer) clearTimeout(room.timer)
    room.timer = null
    room.timerKey = null
    s.deadline = null
    s.deadlineFor = null
    return
  }
  if (room.timerKey === decision.key) return // already ticking for this decision
  if (room.timer) clearTimeout(room.timer)
  room.timerKey = decision.key
  const duration = decision.ms
  s.deadline = Date.now() + duration
  s.deadlineFor = decision.playerId
  room.timer = setTimeout(() => {
    safe(`deadline ${decision.key}`, undefined, () => {
      room.timer = null
      const key = room.timerKey
      room.timerKey = null
      const st = room.state
      if (!st || key !== decision.key) return // decision already resolved
      let committed = false
      if (decision.playerId != null) {
        committed = autoCommit(room, decision)
      } else {      // Auction silence: pass everyone who could still bid — the hammer falls.
        const au = st.auction
        if (!au) return
        for (const q of alivePlayers(st)) {
          if (!au.passed.includes(q.id) && q.id !== au.bidder) {
            if (applyServerAction(room, [[q.id, { type: 'passBid' }]])) committed = true
            if (!room.state || room.state.phase !== 'AUCTION') break
          }
        }
      }
      // A rejected auto-action must not silently kill the clock: nothing
      // was committed, so re-broadcast (which re-arms whatever decision
      // the state waits on now). The watchdog rides along if it's stuck.
      if (!committed) {
        const io = getIoRef()
        if (io && room.state) broadcastGame(io, room)
      }
    })
  }, duration)
}

// The deadline expiry play, committed through the one commit path. The
// autoSettle headline rides on the same single commit as the liquidation
// steps and the payment — no mid-state is ever emitted, a reconnecting
// player sees the debt either still pending or fully settled, and the
// per-step reducer log lines (every sellHouse/mortgage carries a ledger
// entry) provide the paper trail right behind the headline.
function autoCommit(room: Room, decision: ClockedDecision): boolean {
  const s = room.state
  if (!s || decision.playerId == null) return false
  if (decision.key.startsWith('debt:')) {
    const { autos, headline } = debtAutoActions(s, decision.playerId)
    if (autos.length === 0) return false
    if (headline == null) return applyServerAction(room, autos)
    const res = commit(room, getIoRef(), decision.playerId, (n) => {
      n.log.push({ text: headline, kind: 'bad' })
      if (n.log.length > MAX_LOG) n.log.splice(0, n.log.length - MAX_LOG)
      let any = false
      for (const [by, act] of autos) if (applyAction(n, act, by).ok) any = true
      if (!any) return { ok: false, error: 'auto-action rejected' }
    })
    return res.ok
  }
  return applyServerAction(room, autoActionsFor(room, decision))
}

// Timer-side commit path: same clone-apply-commit rules as player actions,
// but no socket to ack to. Auto-actions are NOT human activity — they must
// never extend the room's idle TTL, or an abandoned auto-playing game
// lives forever.
function applyServerAction(room: Room, autos: Array<[string, Action]>): boolean {
  return commit(room, getIoRef(), '', autos).ok
}
