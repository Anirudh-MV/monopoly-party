// ── Room manager + socket glue ──
// One process hosts many rooms. Each room has:
//   - a 4-letter code, a TV token, and per-player rejoin tokens
//   - a PLAYER host: first joiner by default, migrates down the join queue
//     when they leave/disconnect, and can hand duties to another player.
// The TV joins channel h:<code>; each phone joins p:<code>:<playerId>.
// Every applied action triggers a full view push (state is tiny — party scale).

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import path from 'node:path'
import type { Server as IOServer, Socket } from 'socket.io'
import {
  applyAction,
  createGame,
  declareBankruptcy,
  forfeitEstate,
  liquidationPlan,
  MAX_GAME_LOG,
  type PlayerMeta,
  type Result,
} from '../shared/engine.js'
import { ALL_CARDS } from '../shared/cards.js'
import { hostView, playerView } from '../shared/views.js'
import { allowedActions, alivePlayers, netWorth } from '../shared/rules.js'
import { TOKENS, stripEmoji } from '../shared/tokens.js'
import { COLORS } from '../shared/colors.js'
import type {
  Action,
  AuctionState,
  DebtState,
  GameState,
  LobbyInfo,
  LobbyPlayer,
  TradeOffer,
  TradeSide,
} from '../shared/types.js'
import { validAction, validCode, validGodCommand, validToken } from '../shared/validate.js'

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ' // no I/O — they confuse party guests
const MAX_PLAYERS = 8
const MIN_PLAYERS = 2
const ROOM_TTL_MS = 3 * 60 * 60 * 1000
// An empty, unstarted room with no TV attached is junk (create-spam, or a
// TV that closed before anyone joined) — it doesn't need the full TTL.
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000
// Room-minting caps: one screen needs one room. A create storm must not be
// able to fill the ~330k code space, eat memory and litter the disk.
const MAX_ROOMS_PER_SOCKET = 5
const MAX_ROOMS = 200
// Every decision point gets 5 minutes by default (host-configurable in the
// lobby, or live from the god console). Phones only show the countdown in
// the final 30 seconds; on expiry the server plays a sensible default so a
// stalled phone can never stall the table.
const DEFAULT_TURN_TIMEOUT_MS = 300_000

// Auction pacing: the opening window is more generous than the restarts —
// every bid resets a short fuse, so the hammer only falls after real silence,
// never mid-bidding-war.
const AUCTION_OPEN_MS = 30_000
const AUCTION_IDLE_MS = 15_000
// How long a missing phone may hold up an auction before the server passes
// on its behalf — long enough to survive a screen-lock blip, short enough
// that one lost device can't stall the table.
const AUCTION_DISCONNECT_GRACE_MS = 15_000

// ── Per-socket rate limit ──
// A token bucket per connection applied to every inbound event: a hostile
// or runaway client must not eat the event loop or trigger clone storms.
// Capacity 30 with 10 tokens/second refill comfortably clears fast human
// play (and the test suites); only SUSTAINED exhaustion — the bucket
// continuously empty for 10 seconds — disconnects the socket, which is
// auto-rejoinable: disconnects are never punished, the seat waits.
const RATE_CAPACITY = 30
const RATE_REFILL_PER_SEC = 10
const RATE_EXHAUSTION_MS = 10_000

interface PlayerEntry {
  meta: PlayerMeta
  token: string // rejoin secret, stored in the phone's localStorage
  socketId: string | null
  disconnectedAt: number | null // when the live socket went away (grace timers)
}

export interface Room {
  code: string
  hostToken: string // TV rejoin secret
  hostPlayerId: string | null // the player who is "party host" (crown)
  turnTimeoutMs: number // decision deadline; 0 = off
  state: GameState | null
  hostSockets: Set<string>
  players: PlayerEntry[]
  lastActive: number
  timer: ReturnType<typeof setTimeout> | null
  timerKey: string | null
  watchdogBusy: boolean
  // One-shot auction disconnect-grace fuse (see scheduleAuctionGrace) —
  // separate from the decision clock so the two never fight over `timer`.
  graceTimer: ReturnType<typeof setTimeout> | null
  graceKey: string | null
}

interface SocketData {
  code?: string
  role?: 'host' | 'player' | 'watcher'
  playerId?: string
  roomsCreated?: number
}

const rooms = new Map<string, Room>()
const playerTokens = new Map<string, { code: string; playerId: string }>()
let ioRef: IOServer | null = null

function newCode(): string {
  // The 24^4 space holds ~330k codes — a few hundred attempts all colliding
  // means the map is effectively full. Fail (the handler acks {ok:false})
  // instead of spinning forever.
  for (let i = 0; i < 500; i++) {
    const c = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('')
    if (!rooms.has(c)) return c
  }
  throw new Error('room code space exhausted')
}

function hostRoom(code: string): string {
  return `h:${code}`
}
function playerRoom(code: string, playerId: string): string {
  return `p:${code}:${playerId}`
}

// One room-minting path for create and reset, so the guards and defaults
// can never drift apart.
function mintRoom(turnTimeoutMs: number = DEFAULT_TURN_TIMEOUT_MS): Room {
  return {
    code: newCode(),
    hostToken: randomUUID(),
    hostPlayerId: null,
    turnTimeoutMs,
    state: null,
    hostSockets: new Set(),
    players: [],
    lastActive: Date.now(),
    timer: null,
    timerKey: null,
    watchdogBusy: false,
    graceTimer: null,
    graceKey: null,
  }
}

// True if this socket is the player's CURRENT connection for its seat. A
// stale socket (phone already rejoined elsewhere; socket.io notices the old
// one ~45s later) must never act, leave, or hand over duties for a seat
// it no longer holds.
function isCurrentConnection(room: Room, data: SocketData, socketId: string): boolean {
  if (data.role !== 'player' || !data.playerId) return false
  const e = room.players.find((x) => x.meta.id === data.playerId)
  return e != null && e.socketId === socketId
}

function lobbyInfo(room: Room): LobbyInfo {
  const players: LobbyPlayer[] = room.players.map((e) => ({
    id: e.meta.id,
    name: e.meta.name,
    color: e.meta.color,
    token: e.meta.token,
    connected: e.socketId != null,
  }))
  return {
    code: room.code,
    players,
    canStart: room.players.length >= MIN_PLAYERS,
    hostId: room.hostPlayerId,
    turnTimeoutMs: room.turnTimeoutMs,
  }
}

// ── Host migration ──
// "The first person to join is the host by default; if the host leaves or
// disconnects, the next person in the queue becomes the host."

function nextHostInQueue(room: Room, fromIndex: number): string | null {
  const n = room.players.length
  if (n === 0) return null
  for (let step = 1; step <= n; step++) {
    const cand = room.players[(fromIndex + step) % n]
    if (cand) return cand.meta.id
  }
  return null
}

// Called AFTER the leaver was spliced out at `seatIndex`: the player who now
// sits at that index (wrapping to the front) inherits the crown.
function promoteHostOnLeave(room: Room, leaverId: string, seatIndex: number): void {
  if (room.hostPlayerId !== leaverId) return
  room.hostPlayerId = room.players.length > 0 ? room.players[seatIndex % room.players.length].meta.id : null
}

function promoteHostOnDisconnect(room: Room): void {
  if (!room.hostPlayerId) return
  const idx = room.players.findIndex((e) => e.meta.id === room.hostPlayerId)
  if (idx < 0) return
  const n = room.players.length
  // Prefer a player whose phone is actually at the table — the crown must
  // never end up with someone who isn't there while someone else is.
  for (let step = 1; step <= n; step++) {
    const cand = room.players[(idx + step) % n]
    if (cand && cand.socketId != null) {
      room.hostPlayerId = cand.meta.id
      return
    }
  }
  room.hostPlayerId = nextHostInQueue(room, idx)
}

// Nothing a client sends may take the process down: every socket handler and
// every timer runs inside safe(), which turns a throw into a logged error
// plus a {ok:false} ack — instead of a crash that kills every room at once.
function safe(label: string, ack: unknown, fn: () => void): void {
  try {
    fn()
  } catch (e) {
    console.error(`[guard] ${label} threw:`, e)
    if (typeof ack === 'function') {
      try {
        ack({ ok: false, error: 'Bad request' })
      } catch {
        /* client vanished mid-ack */
      }
    }
  }
}

// ── The one commit path ──
// Every state change funnels through here: clone, apply, commit only on
// success, then ONE broadcast (which re-schedules the decision clock and
// flushes the snapshot). A refused mutation never leaves half-applied state
// behind, and no mid-state is ever emitted.
//
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

// A connection belongs to exactly one room. Attaching (create, hostJoin,
// watch, join, rejoin) detaches from any previous room first, so a TV that
// mints a second room can never receive two rooms' events mixed together,
// and its god/start/settings always land in the room it currently shows.
function leaveCurrentRoom(io: IOServer, socket: Socket, data: SocketData): void {
  const room = data.code ? rooms.get(data.code) : undefined
  if (!room) return
  if (data.role === 'host' || data.role === 'watcher') {
    socket.leave(hostRoom(room.code))
    room.hostSockets.delete(socket.id)
  }
  if (data.role === 'player' && data.playerId) {
    socket.leave(playerRoom(room.code, data.playerId))
    const e = room.players.find((x) => x.meta.id === data.playerId)
    if (e && e.socketId === socket.id) {
      e.socketId = null
      e.disconnectedAt = Date.now()
    }
  }
  data.code = undefined
  data.role = undefined
  data.playerId = undefined
  broadcast(room, io)
}

function broadcastLobby(io: IOServer, room: Room): void {
  const info = lobbyInfo(room)
  io.to(hostRoom(room.code)).emit('lobby', info)
  for (const e of room.players) io.to(playerRoom(room.code, e.meta.id)).emit('lobby', info)
  void saveRoom(room)
}

function broadcastGame(io: IOServer, room: Room): void {
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
    const decision = currentDecision(s)
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
      if (!st || st.phase !== 'AUCTION' || !ioRef) return
      const due = auctionGraceActions(room)
      if (due.length === 0) return
      commit(room, ioRef, '', due) // the commit's broadcast re-arms the next fuse
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

function broadcast(room: Room, io: IOServer): void {
  if (room.state) broadcastGame(io, room)
  else broadcastLobby(io, room)
}

// ── Decision deadlines ──

interface Decision {
  key: string
  playerId: string | null // null = everyone (auction)
}

// What single decision is currently blocking play, if any.
function currentDecision(s: GameState): Decision | null {
  if (s.phase === 'ROLL') {
    // dice+doubles in the key so a doubles bonus roll gets a fresh clock
    const d = s.dice ? `${s.dice[0] + s.dice[1]}` : '0'
    return { key: `roll:${s.turn}:${s.currentPlayerId}:${d}:${s.doubles}`, playerId: s.currentPlayerId }
  }
  if (s.phase === 'ACTION') {
    if (s.pendingJail) return { key: `jail:${s.turn}:${s.pendingJail.player}`, playerId: s.pendingJail.player }
    if (s.pendingCardDraw) return { key: `draw:${s.turn}:${s.pendingCardDraw.deck}:${s.pendingCardDraw.space}`, playerId: s.currentPlayerId }
    if (s.pendingPurchase != null) return { key: `buy:${s.turn}:${s.pendingPurchase}`, playerId: s.currentPlayerId }
    if (s.pendingTax) return { key: `tax:${s.turn}`, playerId: s.currentPlayerId }
    return { key: `end:${s.turn}:${s.currentPlayerId}`, playerId: s.currentPlayerId }
  }
  if (s.phase === 'DEBT' && s.debt) {
    const d = s.debt
    // debtor AND creditor AND amount AND queue-depth in the key: a same-debtor
    // relay (chairman paying each player) reuses one debtor+turn — with only
    // those fields every relay row looked like the SAME decision, the timer
    // never re-armed and later debts inherited an expired clock.
    return {
      key: `debt:${s.turn}:${d.debtor}:${d.creditor ?? 'bank'}:${d.amount}:${s.debtQueue.length}`,
      playerId: d.debtor,
    }
  }
  if (s.phase === 'AUCTION' && s.auction) {
    // The bid and bidder are in the key so every new bid restarts the clock
    // — the hammer falls only after real silence, never mid-bidding-war.
    return { key: `auc:${s.turn}:${s.auction.space}:${s.auction.bid}:${s.auction.bidder ?? '-'}`, playerId: null }
  }
  return null
}

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
function autoActionsFor(room: Room, d: Decision): Array<[string, Action]> {
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
  const decision = currentDecision(s)
  if (!decision) return null
  const key = decision.key
  // Arrests and end-of-turn waits run on a fixed 30-second clock at any
  // host setting — they must never strand.
  if (key.startsWith('jail:') || key.startsWith('end:')) return { ...decision, ms: 30_000 }
  if (key.startsWith('debt:')) {
    const d = s.debt
    if (!d) return null
    const debtor = s.players.find((q) => q.id === d.debtor)
    if (debtor && debtor.cash >= d.amount) return { ...decision, ms: 30_000 }
    // Unaffordable: the host clock when it's on; a fixed 90-second
    // raise-funds window when it's off — on expiry the bank auto-settles
    // the estate (liquidationPlan) instead of bankrupting a recoverable seat.
    return { ...decision, ms: turnTimeoutMs > 0 ? turnTimeoutMs : 90_000 }
  }
  if (key.startsWith('auc:')) {
    // Auctions: a generous opening window, then a short fuse that every bid
    // resets. The host fuse shortens it when set below the fixed windows.
    const auctionIdle = s.auction != null && (s.auction.bidder != null || s.auction.bid > 0)
    const ms = auctionIdle ? AUCTION_IDLE_MS : AUCTION_OPEN_MS
    return { ...decision, ms: turnTimeoutMs > 0 ? Math.min(turnTimeoutMs, ms) : ms }
  }
  if (turnTimeoutMs > 0) return { ...decision, ms: turnTimeoutMs }
  // Timer-off defaults: the phase names the wait, the wait names the clock.
  const fixed = key.startsWith('roll:') ? 60_000
    : key.startsWith('draw:') ? 30_000
    : key.startsWith('buy:') ? 60_000
    : key.startsWith('tax:') ? 60_000
    : 0
  return fixed > 0 ? { ...decision, ms: fixed } : null
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
      if (!committed && ioRef && room.state) broadcastGame(ioRef, room)
    })
  }, duration)
}

// The deadline expiry play, committed through the one commit path. The
// autoSettle headline rides on the same single commit as the liquidation
// steps and the payment — no mid-state is ever emitted, a reconnecting
// player sees the debt either still pending or fully settled, and the
// per-step reducer log lines (every sellHouse/mortgage carries a ledger
// entry) provide the paper trail right behind the headline.
function autoCommit(room: Room, decision: Decision): boolean {
  const s = room.state
  if (!s || decision.playerId == null) return false
  if (decision.key.startsWith('debt:')) {
    const { autos, headline } = debtAutoActions(s, decision.playerId)
    if (autos.length === 0) return false
    if (headline == null) return applyServerAction(room, autos)
    const res = commit(room, ioRef, decision.playerId, (n) => {
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
  return commit(room, ioRef, '', autos).ok
}

// ── Room snapshots ──
// Every state change is persisted to disk, so a dev restart never ends the
// party: on boot the rooms come back and phones rejoin via their tokens.
// The same serialization powers the god console's export/import.

interface RoomSnapshot {
  v: number
  code: string
  hostToken: string
  hostPlayerId: string | null
  turnTimeoutMs: number
  players: Array<{ meta: PlayerMeta; token: string }>
  state: GameState | null
}

function serializeRoom(room: Room): RoomSnapshot {
  return {
    v: 1,
    code: room.code,
    hostToken: room.hostToken,
    hostPlayerId: room.hostPlayerId,
    turnTimeoutMs: room.turnTimeoutMs,
    players: room.players.map((e) => ({ meta: e.meta, token: e.token })),
    state: room.state,
  }
}

let SNAP_DIR = 'snapshots'

// Serialized, atomic snapshot writes. Rooms are marked dirty and flushed in
// batches: one write in flight at a time, each written to a temp file and
// renamed into place — so bursts of updates coalesce, and a crash mid-write
// can never leave a half-written JSON behind for the restore to choke on.
const dirtyRooms = new Set<Room>()
let flushing = false
let flushChain: Promise<void> = Promise.resolve()

function flushSnapshot(room: Room): Promise<void> {
  const file = path.join(SNAP_DIR, `${room.code}.json`)
  const tmp = `${file}.tmp`
  return fsp
    .mkdir(SNAP_DIR, { recursive: true })
    .then(() => fsp.writeFile(tmp, JSON.stringify(serializeRoom(room))))
    .then(() => fsp.rename(tmp, file))
}

function saveRoom(room: Room): void {
  dirtyRooms.add(room)
  if (flushing) return // a flush is already draining — this mark rides it
  flushing = true
  flushChain = flushChain
    .then(async () => {
      // Let a burst of updates coalesce before the first disk write.
      await new Promise((r) => setTimeout(r, 250))
      while (dirtyRooms.size > 0) {
        const batch = [...dirtyRooms]
        dirtyRooms.clear()
        for (const r of batch) {
          // a room dissolved mid-flush (lobby reset) must not resurrect its
          // snapshot after the unlink — skip anything no longer registered
          if (!rooms.has(r.code)) continue
          try {
            await flushSnapshot(r)
          } catch (e) {
            console.error(`[snapshots] failed to save ${r.code}:`, e)
          }
        }
      }
    })
    .catch(() => {})
    .finally(() => {
      flushing = false
      // anything marked while the last write was closing gets a new flush
      if (dirtyRooms.size > 0) {
        const first = dirtyRooms.values().next().value
        if (first) saveRoom(first)
      }
    })
}

function loadSnapshots(): void {
  try {
    mkdirSync(SNAP_DIR, { recursive: true })
    // Orphaned temp files from a crash mid-write are never valid state.
    for (const f of readdirSync(SNAP_DIR).filter((x) => x.endsWith('.tmp'))) {
      try {
        unlinkSync(path.join(SNAP_DIR, f))
      } catch {
        /* already gone */
      }
    }
    for (const f of readdirSync(SNAP_DIR).filter((x) => x.endsWith('.json'))) {
      try {
        const raw: unknown = JSON.parse(readFileSync(path.join(SNAP_DIR, f), 'utf8'))
        // Boot restore gets the same treatment as a god import: every
        // renderable field is validated and normalized BEFORE anything
        // reaches a room, a client, or the disk. The one relaxation: a
        // live party's lobby may hold a single waiting phone, so the boot
        // accepts 1-seat lobbies (a 0-seat record is create-spam junk —
        // the TTL's own definition — and still quarantines).
        const snap = validateSnapshot(raw, { minSeats: 1 })
        if (!snap) throw new Error('failed snapshot validation')
        if (!validCode(snap.code)) throw new Error('snapshot carries no usable room code')
        const room: Room = {
          code: snap.code,
          hostToken: '', // restoreRoomFromSnapshot never touches the host
          // token (a same-room god import keeps the live TV's), so the
          // boot applies the snapshot's own identity here.
          hostPlayerId: null,
          turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
          state: null,
          hostSockets: new Set(),
          players: [],
          lastActive: Date.now(),
          timer: null,
          timerKey: null,
          watchdogBusy: false,
          graceTimer: null,
          graceKey: null,
        }
        restoreRoomFromSnapshot(room, snap)
        room.hostToken = snap.hostToken
        rooms.set(room.code, room)
        console.log(
          `[snapshots] restored room ${room.code} (${room.players.length} players, ${room.state ? `turn ${room.state.turn}` : 'lobby'})`,
        )
      } catch (e) {
        // QUARANTINE, never delete — these are party records. The file is
        // renamed out of the boot path with a .bad suffix (a crashed
        // half-write, a corrupt or tampered JSON — all the same here) and
        // the boot continues with the rest.
        const why = e instanceof Error ? e.message : String(e)
        try {
          renameSync(path.join(SNAP_DIR, f), path.join(SNAP_DIR, `${f}.bad`))
          console.error(`[snapshots] quarantined ${f} (${why}) — boot continues`)
        } catch {
          console.error(`[snapshots] failed to restore ${f} and could not quarantine it:`, why)
        }
      }
    }
  } catch {
    /* no snapshot dir yet — fine */
  }
}

// ── Snapshot validation (the god import path) ──
// The import validates BEFORE anything touches the room: a fully checked,
// normalized snapshot is built first, and only committed if every field
// passed. The TV is a browser like any other — a 5000-seat room, a color
// like `red"><img onerror=…`, or a state that throws in the view layer must
// never reach the room, the clients, or the disk.
const SNAPSHOT_MAX_BYTES = 256 * 1024 // real snapshots top out around 20KB
const MAX_OPEN_TRADES = 16
const MAX_LEDGER = 600
const MAX_LOG = MAX_GAME_LOG // must equal the engine's cap: a god export of any live game has to survive god import
const PHASES = new Set(['LOBBY', 'ROLL', 'ACTION', 'AUCTION', 'DEBT', 'GAME_OVER'])
const HEX_COLOR = /^#[0-9a-f]{6}$/i
const CARD_IDS = new Set(ALL_CARDS.map((c) => c.id))
const LOG_KINDS = new Set(['info', 'good', 'bad', 'money'])

function snapStr(x: unknown, max: number): string | null {
  return typeof x === 'string' && x.length > 0 && x.length <= max ? x : null
}

function snapInt(x: unknown, min: number, max: number): number | null {
  return typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max ? x : null
}

function snapTradeSide(raw: unknown): TradeSide | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const d = raw as Record<string, unknown>
  const cash = snapInt(d.cash, 0, 1_000_000_000)
  const jailCards = snapInt(d.jailCards, 0, 5)
  if (cash === null || jailCards === null) return null
  if (!Array.isArray(d.spaces) || d.spaces.length > 40) return null
  const spaces: number[] = []
  for (const sp of d.spaces) {
    const i = snapInt(sp, 0, 39)
    if (i === null) return null
    spaces.push(i)
  }
  return { cash, spaces, jailCards }
}

function snapDeck(raw: unknown, what: string): string[] | null {
  if (!Array.isArray(raw) || raw.length > 32) return null
  for (const id of raw) if (!CARD_IDS.has(id)) return null
  return raw as string[]
}

// Returns a normalized snapshot whose every renderable field is known-safe,
// or null if anything about the input is off. `minSeats` relaxes the seat
// floor for the boot restore (a live party's lobby may legitimately hold a
// single waiting phone — a restart must bring it back); the god import
// keeps the full 2-seat quorum.
function validateSnapshot(raw: unknown, opts: { minSeats?: number } = {}): RoomSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  let bytes: number
  try {
    bytes = JSON.stringify(raw).length
  } catch {
    return null
  }
  if (bytes > SNAPSHOT_MAX_BYTES) return null
  const d = raw as Record<string, unknown>

  // ── seats: clean metas, unique ids and pieces ──
  const minSeats = opts.minSeats ?? MIN_PLAYERS
  if (!Array.isArray(d.players) || d.players.length < minSeats || d.players.length > MAX_PLAYERS) return null
  const players: Array<{ meta: PlayerMeta; token: string }> = []
  const metas = new Map<string, PlayerMeta>()
  const usedPieces = new Set<string>()
  for (let seat = 0; seat < d.players.length; seat++) {
    const e = d.players[seat]
    if (!e || typeof e !== 'object') return null
    const m = (e as { meta?: unknown }).meta
    if (!m || typeof m !== 'object') return null
    const meta = m as Record<string, unknown>
    const id = snapStr(meta.id, 64)
    const name = stripEmoji(typeof meta.name === 'string' ? meta.name : '').slice(0, 16)
    if (!id || !name || metas.has(id)) return null
    // Colors are rendered into style attributes and pieces into markup —
    // only known-safe values survive validation.
    const color =
      typeof meta.color === 'string' && HEX_COLOR.test(meta.color)
        ? meta.color
        : COLORS.find((c) => !players.some((q) => q.meta.color === c)) ?? COLORS[seat % COLORS.length]
    let piece = typeof meta.token === 'string' && TOKENS.includes(meta.token) ? meta.token : ''
    if (!piece) piece = TOKENS.find((t) => !usedPieces.has(t)) ?? TOKENS[0]
    const metaOut: PlayerMeta = { id, name, color, token: piece }
    metas.set(id, metaOut)
    usedPieces.add(piece)
    const rejoin = snapStr((e as { token?: unknown }).token, 64) ?? randomUUID()
    players.push({ meta: metaOut, token: rejoin })
  }

  const hostPlayerId = d.hostPlayerId == null ? null : snapStr(d.hostPlayerId, 64)
  if (hostPlayerId != null && !metas.has(hostPlayerId)) return null
  const turnTimeoutMs = snapInt(d.turnTimeoutMs, 0, 3_600_000) ?? DEFAULT_TURN_TIMEOUT_MS

  // ── state: null (lobby) or a fully checked GameState ──
  let state: GameState | null = null
  if (d.state != null) {
    if (typeof d.state !== 'object' || Array.isArray(d.state)) return null
    const st = d.state as Record<string, unknown>
    if (typeof st.phase !== 'string' || !PHASES.has(st.phase)) return null

    if (!Array.isArray(st.players) || st.players.length !== players.length) return null
    for (const p of st.players as unknown[]) {
      if (!p || typeof p !== 'object') return null
      const q = p as Record<string, unknown>
      const meta = metas.get(snapStr(q.id, 64) ?? '')
      if (!meta) return null
      if (snapInt(q.cash, 0, 1_000_000_000) === null) return null
      if (snapInt(q.pos, 0, 39) === null) return null
      if (typeof q.jail !== 'boolean' || typeof q.bankrupt !== 'boolean' || typeof q.connected !== 'boolean') return null
      if (snapInt(q.jailRolls, 0, 3) === null || snapInt(q.jailCards, 0, 5) === null) return null
      // display copies are forced to the validated meta values
      q.name = meta.name
      q.color = meta.color
      q.token = meta.token
      q.jailReason = typeof q.jailReason === 'string' ? q.jailReason.slice(0, 120) : null
      q.jailCardDecks = Array.isArray(q.jailCardDecks) ? q.jailCardDecks.filter((x) => x === 'chance' || x === 'chest') : []
    }

    const currentPlayerId = snapStr(st.currentPlayerId, 64)
    if (currentPlayerId == null || !metas.has(currentPlayerId)) return null

    const props = st.props
    if (!props || typeof props !== 'object' || Array.isArray(props)) return null
    for (const [, t] of Object.entries(props)) {
      if (!t || typeof t !== 'object') return null
      const q = t as Record<string, unknown>
      if (q.owner != null && !metas.has(snapStr(q.owner, 64) ?? '')) return null
      if (snapInt(q.houses, 0, 5) === null || typeof q.mortgaged !== 'boolean') return null
    }

    const chanceDeck = snapDeck(st.chanceDeck, 'chance')
    const chestDeck = snapDeck(st.chestDeck, 'chest')
    if (chanceDeck === null || chestDeck === null) return null

    const snapDebt = (x: unknown): DebtState | null => {
      if (x == null) return null
      if (!x || typeof x !== 'object') return null
      const q = x as Record<string, unknown>
      const debtor = metas.has(snapStr(q.debtor, 64) ?? '') ? (q.debtor as string) : null
      const amount = snapInt(q.amount, 1, 1_000_000_000)
      const creditor = q.creditor == null ? null : metas.has(snapStr(q.creditor, 64) ?? '') ? (q.creditor as string) : null
      if (debtor === null || amount === null) return null
      // The memo rides along: with always-outflow debts the phone banner reads
      // its reason from here. Anything that isn't a plain, bounded string
      // (an object, a number, a 4KB blob) is dropped — the debt defaults to
      // a generic blurb instead of ever rendering hostile input.
      const memo = typeof q.memo === 'string' && q.memo.length > 0 && q.memo.length <= 120 ? q.memo : undefined
      const d: DebtState = { debtor, amount, creditor }
      if (memo !== undefined) d.memo = memo
      return d
    }
    const debt = snapDebt(st.debt)
    if (debt === null && st.debt != null) return null
    if (!Array.isArray(st.debtQueue) || st.debtQueue.length > 16) return null
    const debtQueue: DebtState[] = []
    for (const x of st.debtQueue) {
      const dq = snapDebt(x)
      if (dq === null) return null
      debtQueue.push(dq)
    }

    const snapAuction = (x: unknown): AuctionState | null => {
      if (x == null) return null
      if (!x || typeof x !== 'object') return null
      const q = x as Record<string, unknown>
      const space = snapInt(q.space, 0, 39)
      const bid = snapInt(q.bid, 0, 1_000_000_000)
      if (space === null || bid === null) return null
      const bidder = q.bidder == null ? null : metas.has(snapStr(q.bidder, 64) ?? '') ? (q.bidder as string) : null
      if (!Array.isArray(q.passed)) return null
      const passed: string[] = []
      for (const pid of q.passed) {
        const id = metas.has(snapStr(pid, 64) ?? '') ? (pid as string) : null
        if (id === null) return null
        passed.push(id)
      }
      return { space, bid, bidder, passed }
    }
    const auction = snapAuction(st.auction)
    if (auction === null && st.auction != null) return null
    if (!Array.isArray(st.auctionQueue) || st.auctionQueue.length > 40) return null
    const auctionQueue: number[] = []
    for (const x of st.auctionQueue) {
      const i = snapInt(x, 0, 39)
      if (i === null) return null
      auctionQueue.push(i)
    }

    if (!Array.isArray(st.trades) || st.trades.length > MAX_OPEN_TRADES) return null
    const trades: TradeOffer[] = []
    for (const x of st.trades) {
      if (!x || typeof x !== 'object') return null
      const q = x as Record<string, unknown>
      const id = snapStr(q.id, 64)
      const from = metas.has(snapStr(q.from, 64) ?? '') ? (q.from as string) : null
      const to = metas.has(snapStr(q.to, 64) ?? '') ? (q.to as string) : null
      const give = snapTradeSide(q.give)
      const receive = snapTradeSide(q.receive)
      if (id === null || from === null || to === null || !give || !receive) return null
      trades.push({ id, from, to, give, receive })
    }

    let pendingTax: { player: string; space: number } | null = null
    if (st.pendingTax != null) {
      if (!st.pendingTax || typeof st.pendingTax !== 'object') return null
      const q = st.pendingTax as Record<string, unknown>
      const player = metas.has(snapStr(q.player, 64) ?? '') ? (q.player as string) : null
      const space = snapInt(q.space, 0, 39)
      if (player === null || space === null) return null
      pendingTax = { player, space }
    }

    if (!Array.isArray(st.ledger) || st.ledger.length > MAX_LEDGER) return null
    for (const x of st.ledger) {
      if (!x || typeof x !== 'object') return null
      const q = x as Record<string, unknown>
      if (snapInt(q.seq, 0, 1_000_000) === null || snapInt(q.turn, 0, 100_000) === null) return null
      if (!metas.has(snapStr(q.playerId, 64) ?? '')) return null
      if (snapInt(q.delta, -1_000_000_000, 1_000_000_000) === null) return null
      if (snapInt(q.balance, 0, 1_000_000_000) === null) return null
      if (typeof q.memo !== 'string' || q.memo.length > 120) return null
    }

    if (!Array.isArray(st.log) || st.log.length > MAX_LOG) return null
    for (const x of st.log) {
      if (!x || typeof x !== 'object') return null
      const q = x as Record<string, unknown>
      if (typeof q.text !== 'string' || q.text.length > 200) return null
      if (typeof q.kind !== 'string' || !LOG_KINDS.has(q.kind)) return null
    }

    // Dice and counters must be sane wherever they exist.
    if (st.dice != null) {
      if (!Array.isArray(st.dice) || st.dice.length !== 2) return null
      if (snapInt(st.dice[0], 1, 6) === null || snapInt(st.dice[1], 1, 6) === null) return null
    }
    if (snapInt(st.doubles, 0, 3) === null) return null
    if (snapInt(st.cardDrawSeq, 0, 1_000_000) === null) return null
    if (snapInt(st.turn, 0, 100_000) === null) return null
    if (st.winner != null && !metas.has(snapStr(st.winner, 64) ?? '')) return null

    // Rebuild the state as the normalized object: known-safe values only.
    // Transient reveal pendings (card draw, jail sentence, pending card)
    // don't survive an import — the room re-schedules its clock on the next
    // broadcast, so the game simply continues from a stable point.
    state = {
      ...(st as unknown as GameState),
      chanceDeck,
      chestDeck,
      debt,
      debtQueue,
      auction,
      auctionQueue,
      trades,
      pendingTax,
      pendingCard: null,
      pendingCardDraw: null,
      pendingJail: null,
      pendingPurchase: null,
      pendingMove: null,
      deadline: null,
      deadlineFor: null,
    }
  }

  return {
    v: 1,
    code: snapStr(d.code, 4) ?? '',
    hostToken: snapStr(d.hostToken, 64) ?? '',
    hostPlayerId,
    turnTimeoutMs,
    players,
    state,
  }
}

// ── God console ──
// Emergency operator controls for the TV host: rescue turns, edit wallets,
// reassign properties, force reveals, export/import the whole game.

function godLog(next: GameState, note: string): void {
  next.log.push({ text: `GOD: ${note}`, kind: 'info' })
  if (next.log.length > MAX_LOG) next.log.splice(0, next.log.length - MAX_LOG)
}

function godMutate(io: IOServer, room: Room, note: string, fn: (s: GameState) => void): boolean {
  // The tamper-proof TV console: clone, mutate, log, commit — the same one
  // commit path everything else uses (ungated by design: god is trusted).
  return commit(room, io, '', (n: GameState) => {
    fn(n)
    godLog(n, note)
  }).ok
}

// Consumes a snapshot that validateSnapshot already accepted — every field
// is known-safe. Same-room imports keep live sockets attached to seats that
// survive.
function restoreRoomFromSnapshot(room: Room, snap: RoomSnapshot): boolean {
  const prevConnected = new Map(room.players.map((e) => [e.meta.id, e.socketId]))
  // re-key rejoin tokens to the incoming seats
  for (const [tok, ref] of playerTokens) if (ref.code === room.code) playerTokens.delete(tok)
  room.hostPlayerId = snap.hostPlayerId
  room.turnTimeoutMs = snap.turnTimeoutMs
  room.players = snap.players.map((e) => ({
    meta: e.meta,
    token: e.token,
    // same-room imports keep live sockets attached to their seats
    socketId: prevConnected.get(e.meta.id) ?? null,
    disconnectedAt: null,
  }))
  for (const e of room.players) playerTokens.set(e.token, { code: room.code, playerId: e.meta.id })
  room.state = snap.state
  // The imported state's deadline timer is stale by definition: drop it so
  // the next broadcast re-arms the real decision with a fresh clock.
  if (room.timer) clearTimeout(room.timer)
  room.timer = null
  room.timerKey = null
  if (room.graceTimer) clearTimeout(room.graceTimer)
  room.graceTimer = null
  room.graceKey = null
  return true
}

// Flush pending snapshot writes right now — called on SIGTERM/SIGINT so a
// systemd restart can never lose a move that was already acknowledged.
export async function flushSnapshots(): Promise<void> {
  try {
    await flushChain.catch(() => {})
    const batch = [...dirtyRooms]
    dirtyRooms.clear()
    for (const r of batch) {
      try {
        await flushSnapshot(r)
      } catch (e) {
        console.error(`[snapshots] failed to save ${r.code}:`, e)
      }
    }
  } catch {
    /* nothing more we can do at shutdown */
  }
}

export function attach(io: IOServer, getJoinUrls: (code: string) => string[], snapshotDir = 'snapshots'): void {
  ioRef = io
  SNAP_DIR = snapshotDir
  loadSnapshots()
  io.on('connection', (socket: Socket) => {
    const data = socket.data as SocketData
    socket.onAny(() => {
      const room = data.code ? rooms.get(data.code) : undefined
      if (room) room.lastActive = Date.now()
    })

    // Register a handler that can never take the process down: safe() turns
    // any throw into a logged error plus a {ok:false} ack. The ack is
    // whichever argument arrived as a function — most events are
    // (payload, ack), a few are (ack) only.
    //
    // Every inbound event first passes this socket's token bucket
    // (capacity 30, refill 10/s). Over-limit events are dropped with an
    // error ack — never silently — and logged with room + socket id; only
    // sustained exhaustion (bucket continuously empty ≥10s) disconnects
    // the socket, which is auto-rejoinable: the seat waits.
    const bucket = { tokens: RATE_CAPACITY, at: Date.now(), emptySince: null as number | null, dropped: 0 }
    const rateTake = (ack?: (res: unknown) => void): boolean => {
      const now = Date.now()
      bucket.tokens = Math.min(RATE_CAPACITY, bucket.tokens + ((now - bucket.at) / 1000) * RATE_REFILL_PER_SEC)
      bucket.at = now
      if (bucket.tokens < 1) {
        if (bucket.emptySince == null) bucket.emptySince = now
        if (now - bucket.emptySince >= RATE_EXHAUSTION_MS) {
          console.error(`[rate] room ${data.code ?? '-'} socket ${socket.id}: sustained exhaustion — disconnecting (${bucket.dropped} dropped)`)
          ack?.({ ok: false, error: 'Slow down — you are sending too fast' })
          socket.disconnect(true)
          return false
        }
        // Never silent to the CLIENT (error ack always goes out), but the
        // journal only sees the first drops and then a heartbeat — a flood
        // must not turn the log into its second victim.
        bucket.dropped++
        if (bucket.dropped <= 5 || bucket.dropped % 100 === 0) {
          console.error(`[rate] room ${data.code ?? '-'} socket ${socket.id}: event dropped (rate limit) (${bucket.dropped})`)
        }
        ack?.({ ok: false, error: 'Slow down — you are sending too fast' })
        return false
      }
      bucket.tokens -= 1
      // Only a serve from a mostly-refilled bucket clears the exhaustion
      // clock — the client genuinely stopped hammering. A lucky 1-token
      // refill mid-flood (batched arrivals) must never reset it.
      if (bucket.tokens >= RATE_CAPACITY / 2) {
        bucket.emptySince = null
        bucket.dropped = 0
      }
      return true
    }
    const on = (ev: string, handler: (raw: unknown, ack?: (res: unknown) => void) => void): void => {
      socket.on(ev, (...args: unknown[]) => {
        const ack = args.find((a): a is (res: unknown) => void => typeof a === 'function')
        if (!rateTake(ack)) return
        safe(ev, ack, () => handler(args[0], ack))
      })
    }

    // ── TV ──
    on('room:create', (_raw: unknown, ack?: (res: unknown) => void) => {
      // Well-formed TVs emit only the ack; a payload in that slot is
      // simply ignored (the ack is picked out by the registrar).
      if ((data.roomsCreated ?? 0) >= MAX_ROOMS_PER_SOCKET) {
        return ack?.({ ok: false, error: 'This screen has made too many rooms — reload the page' })
      }
      if (rooms.size >= MAX_ROOMS) {
        return ack?.({ ok: false, error: 'Server is full — try again in a few minutes' })
      }
      const room: Room = mintRoom()
      rooms.set(room.code, room)
      data.roomsCreated = (data.roomsCreated ?? 0) + 1
      // one connection, one room: detach from any previous room first
      leaveCurrentRoom(io, socket, data)
      socket.join(hostRoom(room.code))
      room.hostSockets.add(socket.id)
      data.code = room.code
      data.role = 'host'
      socket.emit('lobby', lobbyInfo(room)) // render the empty lobby immediately
      ack?.({ ok: true, code: room.code, hostToken: room.hostToken, urls: getJoinUrls(room.code) })
    })

    on('room:hostJoin', (raw: unknown, ack?: (res: unknown) => void) => {
      const code = validCode((raw as { code?: unknown } | null | undefined)?.code)
      const hostToken = validToken((raw as { hostToken?: unknown } | null | undefined)?.hostToken)
      if (!code || !hostToken) return ack?.({ ok: false, error: 'Room not found' })
      const room = rooms.get(code)
      if (!room || room.hostToken !== hostToken) {
        return ack?.({ ok: false, error: 'Room not found' })
      }
      leaveCurrentRoom(io, socket, data)
      socket.join(hostRoom(room.code))
      room.hostSockets.add(socket.id)
      data.code = room.code
      data.role = 'host'
      if (room.state) socket.emit('view', hostView(room.state, room.code, room.hostPlayerId, room.turnTimeoutMs))
      else socket.emit('lobby', lobbyInfo(room))
      ack?.({ ok: true, code: room.code, urls: getJoinUrls(room.code) })
    })

    // Extra TVs: mirror the room on any other screen. The watcher joins the
    // host broadcast room but NEVER hostSockets — god, start and settings
    // check that set, so mirrored screens are view-only by construction.
    on('room:watch', (raw: unknown, ack?: (res: unknown) => void) => {
      const code = validCode((raw as { code?: unknown } | null | undefined)?.code)
      if (!code) return ack?.({ ok: false, error: 'Room not found' })
      const room = rooms.get(code)
      if (!room) return ack?.({ ok: false, error: 'Room not found' })
      leaveCurrentRoom(io, socket, data)
      socket.join(hostRoom(room.code))
      data.code = room.code
      data.role = 'watcher'
      if (room.state) socket.emit('view', hostView(room.state, room.code, room.hostPlayerId, room.turnTimeoutMs))
      else socket.emit('lobby', lobbyInfo(room))
      ack?.({ ok: true, code: room.code, urls: getJoinUrls(room.code) })
    })

    // ── Phones ──
    on('room:join', (raw: unknown, ack?: (res: unknown) => void) => {
      const p = (raw ?? {}) as { code?: unknown; name?: unknown; piece?: unknown }
      const code = validCode(p.code)
      if (!code) return ack?.({ ok: false, error: 'No room with that code' })
      const room = rooms.get(code)
      if (!room) return ack?.({ ok: false, error: 'No room with that code' })
      if (room.state) return ack?.({ ok: false, error: 'That game already started' })
      if (room.players.length >= MAX_PLAYERS) return ack?.({ ok: false, error: 'Room is full (8 players)' })

      // Names never carry emojis — strip server-side, never trust the client.
      const name = stripEmoji(typeof p.name === 'string' ? p.name : '').slice(0, 16)
      if (name.length < 1) return ack?.({ ok: false, error: 'Enter your name (letters and numbers)' })
      if (room.players.some((e) => e.meta.name.toLowerCase() === name.toLowerCase())) {
        return ack?.({ ok: false, error: 'Someone already took that name' })
      }

      // Piece: must come from the allowed list and be unique in the room.
      // Missing/invalid piece falls back to the first free one (keeps
      // old clients and the smoke test working).
      const wanted = typeof p.piece === 'string' ? p.piece : ''
      let piece: string
      if (wanted && TOKENS.includes(wanted)) {
        if (room.players.some((e) => e.meta.token === wanted)) {
          return ack?.({ ok: false, error: `${wanted} is already taken — pick another piece` })
        }
        piece = wanted
      } else {
        piece = TOKENS.find((t) => !room.players.some((e) => e.meta.token === t)) ?? TOKENS[0]
      }

      // Colour: same contract as the piece — from the palette, unique in
      // the room, first free colour as the fallback.
      const wantedColor = typeof (p as { color?: unknown }).color === 'string' ? ((p as { color?: string }).color ?? '') : ''
      let color: string
      if (wantedColor && COLORS.includes(wantedColor)) {
        if (room.players.some((e) => e.meta.color === wantedColor)) {
          return ack?.({ ok: false, error: `${wantedColor} is already taken — pick another colour` })
        }
        color = wantedColor
      } else {
        color = COLORS.find((c) => !room.players.some((e) => e.meta.color === c)) ?? COLORS[0]
      }

      const meta: PlayerMeta = {
        id: randomUUID(),
        name,
        color,
        token: piece,
      }
      const entry: PlayerEntry = { meta, token: randomUUID(), socketId: socket.id, disconnectedAt: null }
      room.players.push(entry)
      playerTokens.set(entry.token, { code: room.code, playerId: meta.id })

      // First joiner is the party host by default.
      if (!room.hostPlayerId) room.hostPlayerId = meta.id

      leaveCurrentRoom(io, socket, data)
      socket.join(playerRoom(room.code, meta.id))
      data.code = room.code
      data.role = 'player'
      data.playerId = meta.id
      broadcastLobby(io, room)
      ack?.({ ok: true, code: room.code, playerId: meta.id, token: entry.token })
    })

    on('room:rejoin', (raw: unknown, ack?: (res: unknown) => void) => {
      const token = validToken((raw as { token?: unknown } | null | undefined)?.token)
      if (!token) return ack?.({ ok: false, error: 'Session expired — rejoin with the room code' })
      const t = playerTokens.get(token)
      if (!t) return ack?.({ ok: false, error: 'Session expired — rejoin with the room code' })
      const room = rooms.get(t.code)
      const entry = room?.players.find((e) => e.meta.id === t.playerId)
      if (!room || !entry) return ack?.({ ok: false, error: 'Session expired — rejoin with the room code' })

      // The OLD connection loses its player identity the moment the seat
      // moves — a stale socket must not be able to act for this seat later.
      if (entry.socketId != null && entry.socketId !== socket.id) {
        const stale = io.sockets.sockets.get(entry.socketId)
        if (stale) {
          const sd = stale.data as SocketData
          if (sd.code === room.code && sd.playerId === entry.meta.id) {
            sd.code = undefined
            sd.role = undefined
            sd.playerId = undefined
          }
        }
      }

      leaveCurrentRoom(io, socket, data)
      socket.join(playerRoom(room.code, entry.meta.id))
      entry.socketId = socket.id
      entry.disconnectedAt = null
      data.code = room.code
      data.role = 'player'
      data.playerId = entry.meta.id
      broadcast(room, io)
      ack?.({ ok: true, code: room.code, playerId: entry.meta.id })
    })

    on('room:leave', (_raw: unknown, ack?: (res: unknown) => void) => {
      const room = data.code ? rooms.get(data.code) : undefined
      if (!room || data.role !== 'player' || !data.playerId) return ack?.({ ok: false })
      const idx = room.players.findIndex((e) => e.meta.id === data.playerId)
      if (idx < 0) return ack?.({ ok: false })
      // Only the seat's live connection can give it up — a stale socket
      // must not be able to destroy the seat's rejoin token.
      if (!isCurrentConnection(room, data, socket.id)) return ack?.({ ok: false })
      const entry = room.players[idx]
      if (room.state) {
        // Mid-game exit = forfeit (the one estate rule): the estate goes
        // under the hammer and the game plays on without them — detecting
        // the win automatically if nobody else is left. Clone-apply-commit
        // like every other state change; a refused mutation (already
        // bankrupt) commits nothing. A finished game has nothing left to
        // protect — the recorded winner stands.
        if (room.state.phase !== 'GAME_OVER') {
          const s = room.state
          const pid = data.playerId
          const name = s.players.find((q) => q.id === pid)?.name ?? entry.meta.name
          // Clone-apply-commit through the one commit path, no broadcast
          // yet — the eviction bookkeeping below must land first. A refused
          // mutation (already bankrupt) commits nothing. A finished game
          // has nothing left to protect — the recorded winner stands.
          commit(
            room,
            io,
            pid,
            (n) => forfeitSeat(n, pid, `${name} left the party — their properties go under the hammer`),
            { broadcast: false },
          )
        }
        // this phone is out for good: its rejoin token is destroyed, so it
        // can never wander back.
        if (entry) {
          playerTokens.delete(entry.token)
          entry.socketId = null
          entry.disconnectedAt = Date.now()
          if (room.hostPlayerId === data.playerId) promoteHostOnDisconnect(room)
          socket.leave(playerRoom(room.code, data.playerId))
        }
        data.code = undefined
        data.role = undefined
        data.playerId = undefined
        broadcastGame(io, room)
        return ack?.({ ok: true })
      }

      // Lobby: the seat is removed entirely and the crown slides down.
      const [gone] = room.players.splice(idx, 1)
      playerTokens.delete(gone.token)
      promoteHostOnLeave(room, gone.meta.id, idx)
      broadcastLobby(io, room)
      ack?.({ ok: true })
    })

    // Swap your piece while still in the lobby — identities lock once the
    // game starts (each piece is a distinct 3D avatar; mid-game swaps would
    // confuse the table).
    on('room:setPiece', (raw: unknown, ack?: (res: unknown) => void) => {
      const room = data.code ? rooms.get(data.code) : undefined
      if (!room || !isCurrentConnection(room, data, socket.id)) return ack?.({ ok: false, error: 'Not your seat' })
      if (room.state) return ack?.({ ok: false, error: 'The game already started' })
      const piece = (raw as { piece?: unknown } | null | undefined)?.piece
      if (typeof piece !== 'string' || !TOKENS.includes(piece)) return ack?.({ ok: false, error: 'Not a valid piece' })
      const idx = room.players.findIndex((e) => e.meta.id === data.playerId)
      const entry = idx >= 0 ? room.players[idx] : undefined
      if (!entry) return ack?.({ ok: false, error: 'Not your seat' })
      if (entry.meta.token === piece) return ack?.({ ok: true }) // already wearing it
      if (room.players.some((e, i) => i !== idx && e.meta.token === piece)) {
        return ack?.({ ok: false, error: `${piece} is already taken — pick another piece` })
      }
      entry.meta.token = piece
      broadcastLobby(io, room)
      ack?.({ ok: true })
    })

    // Swap your colour while still in the lobby — the avatar wears it on
    // the board. One colour per player, unique in the room.
    on('room:setColor', (raw: unknown, ack?: (res: unknown) => void) => {
      const room = data.code ? rooms.get(data.code) : undefined
      if (!room || !isCurrentConnection(room, data, socket.id)) return ack?.({ ok: false, error: 'Not your seat' })
      if (room.state) return ack?.({ ok: false, error: 'The game already started' })
      const color = (raw as { color?: unknown } | null | undefined)?.color
      if (typeof color !== 'string' || !COLORS.includes(color)) return ack?.({ ok: false, error: 'Not a valid colour' })
      const idx = room.players.findIndex((e) => e.meta.id === data.playerId)
      const entry = idx >= 0 ? room.players[idx] : undefined
      if (!entry) return ack?.({ ok: false, error: 'Not your seat' })
      if (entry.meta.color === color) return ack?.({ ok: true }) // already wearing it
      if (room.players.some((e, i) => i !== idx && e.meta.color === color)) {
        return ack?.({ ok: false, error: `${color} is already taken — pick another colour` })
      }
      entry.meta.color = color
      broadcastLobby(io, room)
      ack?.({ ok: true })
    })

    // Rename YOURSELF while still in the lobby. There is no target-id
    // field — self is implied, so renaming someone else is structurally
    // impossible. Name validation is identical to room:join's checks.
    on('room:rename', (raw: unknown, ack?: (res: unknown) => void) => {
      const room = data.code ? rooms.get(data.code) : undefined
      if (!room || !isCurrentConnection(room, data, socket.id)) return ack?.({ ok: false, error: 'Not your seat' })
      if (room.state) return ack?.({ ok: false, error: 'The game already started' })
      const idx = room.players.findIndex((e) => e.meta.id === data.playerId)
      const entry = idx >= 0 ? room.players[idx] : undefined
      if (!entry) return ack?.({ ok: false, error: 'Not your seat' })
      // Names never carry emojis — strip server-side, never trust the client.
      const rawName = (raw as { name?: unknown } | null | undefined)?.name
      const name = stripEmoji(typeof rawName === 'string' ? rawName : '').slice(0, 16)
      if (name.length < 1) return ack?.({ ok: false, error: 'Enter your name (letters and numbers)' })
      if (entry.meta.name === name) return ack?.({ ok: true }) // already called that
      if (room.players.some((e, i) => i !== idx && e.meta.name.toLowerCase() === name.toLowerCase())) {
        return ack?.({ ok: false, error: 'Someone already took that name' })
      }
      entry.meta.name = name
      broadcastLobby(io, room)
      ack?.({ ok: true })
    })

    // The party host can remove someone from the LOBBY (locked once the
    // game starts — a mid-game kick would strand a live seat). The kicked
    // phone loses its seat identity and is told politely.
    on('room:kick', (raw: unknown, ack?: (res: unknown) => void) => {
      const room = data.code ? rooms.get(data.code) : undefined
      if (!room || !isCurrentConnection(room, data, socket.id)) return ack?.({ ok: false, error: 'Not your seat' })
      if (room.state) return ack?.({ ok: false, error: 'The game already started' })
      if (room.hostPlayerId !== data.playerId) return ack?.({ ok: false, error: 'Only the party host can kick' })
      const targetId = (raw as { playerId?: unknown } | null | undefined)?.playerId
      if (typeof targetId !== 'string' || targetId.length > 64 || targetId === data.playerId) {
        return ack?.({ ok: false, error: 'Pick another player' })
      }
      const idx = room.players.findIndex((e) => e.meta.id === targetId)
      if (idx < 0) return ack?.({ ok: false, error: 'Not in this room' })
      const [gone] = room.players.splice(idx, 1)
      playerTokens.delete(gone.token)
      // the kicked phone's identity dies with the seat
      const kicked = gone.socketId != null ? io.sockets.sockets.get(gone.socketId) : undefined
      if (kicked) {
        const td = kicked.data as SocketData
        if (td.code === room.code && td.playerId === targetId) {
          td.code = undefined
          td.role = undefined
          td.playerId = undefined
        }
        kicked.leave(playerRoom(room.code, targetId))
        kicked.emit('kicked')
      }
      broadcastLobby(io, room)
      ack?.({ ok: true })
    })

    // ── Party host powers (migratable player role) ──
    on('game:handOver', (raw: unknown, ack?: (res: unknown) => void) => {
      const room = data.code ? rooms.get(data.code) : undefined
      if (!room || room.state) return ack?.({ ok: false, error: 'Only in the lobby' })
      if (!isCurrentConnection(room, data, socket.id) || data.playerId !== room.hostPlayerId) {
        return ack?.({ ok: false, error: 'Only the host can do that' })
      }
      const to = typeof (raw as { to?: unknown })?.to === 'string' ? (raw as { to?: string }).to : ''
      const target = room.players.find((e) => e.meta.id === to)
      if (!target || target.meta.id === data.playerId) return ack?.({ ok: false, error: 'Pick another player' })
      room.hostPlayerId = target.meta.id
      broadcastLobby(io, room)
      ack?.({ ok: true })
    })

    // ── Lobby reset: dissolve this room and mint a fresh one ──
    // Lobby-only by hard guard — never touches the engine or the estate
    // rules. The initiator (TV socket or crown phone) gets the new room via
    // the ack; other TVs follow via room:moved; every seated phone is
    // evacuated with room:closed carrying the new code so the join form
    // prefills it. Watchers auto-follow on the client.
    on('room:reset', (_raw: unknown, ack?: (res: unknown) => void) => {
      const old = data.code ? rooms.get(data.code) : undefined
      if (!old) return ack?.({ ok: false, error: 'Room not found' })
      if (old.state) return ack?.({ ok: false, error: 'The game already started' })
      const isTvHost = old.hostSockets.has(socket.id)
      const isPartyHost = isCurrentConnection(old, data, socket.id) && data.playerId === old.hostPlayerId
      if (!isTvHost && !isPartyHost) {
        return ack?.({ ok: false, error: data.role === 'player' ? 'Only the party host can do that' : 'Hosts only' })
      }
      if ((data.roomsCreated ?? 0) >= MAX_ROOMS_PER_SOCKET) {
        return ack?.({ ok: false, error: 'This screen has made too many rooms — reload the page' })
      }
      if (rooms.size >= MAX_ROOMS) {
        return ack?.({ ok: false, error: 'Server is full — try again in a few minutes' })
      }

      // the fresh room keeps the screen's timer preference — that's a
      // preference, not part of the mess being reset
      const next = mintRoom(old.turnTimeoutMs)
      rooms.set(next.code, next)
      data.roomsCreated = (data.roomsCreated ?? 0) + 1
      const urls = getJoinUrls(next.code)

      // TVs: migrate every host socket; the initiator learns via the ack,
      // the others via room:moved
      for (const sid of old.hostSockets) {
        const tv = io.sockets.sockets.get(sid)
        if (!tv) continue
        tv.leave(hostRoom(old.code))
        tv.join(hostRoom(next.code))
        next.hostSockets.add(sid) // host powers must follow the screen
        const td = tv.data as SocketData
        td.code = next.code
        td.role = 'host'
        tv.emit('lobby', lobbyInfo(next))
        if (tv !== socket) tv.emit('room:moved', { code: next.code, hostToken: next.hostToken, urls })
      }

      // phones: every seat is dissolved — tokens die, identities clear,
      // sockets hear room:closed with the new code (offline seats included:
      // their tokens must die too)
      for (const entry of old.players) {
        playerTokens.delete(entry.token)
        if (entry.socketId == null) continue
        const phone = io.sockets.sockets.get(entry.socketId)
        if (!phone) continue
        const pd = phone.data as SocketData
        if (pd.code === old.code && pd.playerId === entry.meta.id) {
          pd.code = undefined
          pd.role = undefined
          pd.playerId = undefined
        }
        phone.leave(playerRoom(old.code, entry.meta.id))
        phone.emit('room:closed', { code: next.code })
      }

      // watchers/mirrors: after the TVs migrated, whoever is left in the old
      // host channel is a watcher — tell them where the party went
      for (const sid of io.sockets.adapter.rooms.get(hostRoom(old.code)) ?? []) {
        const ws = io.sockets.sockets.get(sid)
        if (!ws) continue
        const wd = ws.data as SocketData
        if (wd.code === old.code) {
          wd.code = undefined
          if (wd.role === 'watcher') wd.role = undefined
        }
        ws.leave(hostRoom(old.code))
        ws.emit('room:closed', { code: next.code })
      }

      // teardown: the old room is gone; its snapshot must not come back —
      // drop it from the pending-save set BEFORE unlinking, or the 250ms
      // coalescing flush resurrects the file
      rooms.delete(old.code)
      dirtyRooms.delete(old)
      try {
        unlinkSync(path.join(SNAP_DIR, `${old.code}.json`))
      } catch {
        /* already gone */
      }

      ack?.({ ok: true, code: next.code, hostToken: next.hostToken, urls })
    })

    // ── Game flow ──
    on('game:start', (_raw: unknown, ack?: (res: unknown) => void) => {
      const room = data.code ? rooms.get(data.code) : undefined
      if (!room) return ack?.({ ok: false, error: 'Room not found' })
      const isTvHost = room.hostSockets.has(socket.id)
      const isPartyHost = isCurrentConnection(room, data, socket.id) && data.playerId === room.hostPlayerId
      if (!isTvHost && !isPartyHost) return ack?.({ ok: false, error: 'Hosts only' })
      if (room.state) return ack?.({ ok: false, error: 'Already started' })
      if (room.players.length < MIN_PLAYERS) return ack?.({ ok: false, error: 'Need at least 2 players' })
      room.state = createGame(room.players.map((e) => e.meta))
      broadcastGame(io, room)
      ack?.({ ok: true })
    })

    on('game:action', (raw: unknown, ack?: (res: unknown) => void) => {
      // The engine is I/O-free and trusts its inputs; the boundary check
      // here is what makes that safe. Nothing malformed reaches applyAction.
      const action = validAction(raw)
      if (!action) return ack?.({ ok: false, error: 'Malformed action' })
      const room = data.code ? rooms.get(data.code) : undefined
      if (!room?.state) return ack?.({ ok: false, error: 'No game running' })
      if (!isCurrentConnection(room, data, socket.id) || !data.playerId) {
        return ack?.({ ok: false, error: 'Players only' })
      }

      // Clone, apply, and only commit on success — a failed action never
      // leaves half-applied state behind. The gate asks the engine's own
      // allowed list BEFORE any clone (an illegal socket action costs no
      // state copy); the reducer still enforces legality behind it, so the
      // phone sees byte-identical rejections either way.
      room.lastActive = Date.now()
      const res = commit(room, io, data.playerId, action, { gate: true })
      if (!res.ok) return ack?.({ ok: false, error: res.error })

      ack?.({ ok: true })
    })

    // ── Host lobby settings ──
    on(
      'room:settings',
      (raw: unknown, ack?: (res: unknown) => void) => {
        const room = data.code ? rooms.get(data.code) : undefined
        if (!room) return ack?.({ ok: false, error: 'Room not found' })
        const isTvHost = room.hostSockets.has(socket.id)
        const isPartyHost = isCurrentConnection(room, data, socket.id) && data.playerId === room.hostPlayerId
        if (!isTvHost && !isPartyHost) return ack?.({ ok: false, error: 'Hosts only' })
        const rawMs = (raw as { turnTimeoutMs?: unknown } | null | undefined)?.turnTimeoutMs
        // Whole minutes-of-seconds only: no NaN, no strings, no floats.
        const ms =
          typeof rawMs === 'number' && Number.isInteger(rawMs)
            ? Math.max(0, Math.min(3_600_000, rawMs))
            : null
        if (ms === null) return ack?.({ ok: false, error: 'Bad timer value' })
        room.turnTimeoutMs = ms
        // The in-progress decision re-arms with the new duration.
        room.timerKey = null
        if (room.state) {
          godMutate(io, room, `decision timer ${ms === 0 ? 'disabled' : `set to ${Math.round(ms / 1000)}s`}`, () => {})
        } else {
          broadcastLobby(io, room)
          void saveRoom(room)
        }
        ack?.({ ok: true })
      },
    )

    // ── God console (TV hosts only) ──
    on('god:command', (raw: unknown, ack?: (res: unknown) => void) => {
      const room = data.code ? rooms.get(data.code) : undefined
      if (!room || !room.hostSockets.has(socket.id)) {
        return ack?.({ ok: false, error: 'The god console is only available on the TV screen' })
      }
      // God payloads are validated like everything else — a hostile or
      // half-broken TV browser must not write NaN into the state either.
      const payload = validGodCommand(raw)
      if (!payload) return ack?.({ ok: false, error: 'Unknown god command' })
      const s = room.state

      switch (payload.cmd) {
        case 'skipTurn': {
          if (!s) return ack?.({ ok: false, error: 'No game running' })
          const skipped = s.players.find((p) => p.id === s.currentPlayerId)?.name ?? 'the current player'
          godMutate(io, room, `skipped ${skipped}'s turn`, (n) => {
            n.pendingPurchase = null
            n.pendingTax = null
            n.pendingCardDraw = null
            n.pendingCard = null
            n.pendingMove = null
            n.debt = null
            n.debtQueue = []
            n.auction = null
            n.auctionQueue = []
            n.dice = null
            n.doubles = 0
            // advance the turn pointer manually (nextPlayer lives in the engine)
            const k = n.players.findIndex((q) => q.id === n.currentPlayerId)
            for (let step = 1; step <= n.players.length; step++) {
              const cand = n.players[(k + step) % n.players.length]
              if (cand && !cand.bankrupt) {
                n.currentPlayerId = cand.id
                break
              }
            }
            n.turn++
            n.phase = 'ROLL'
          })
          return ack?.({ ok: true })
        }

        case 'replayTurn': {
          if (!s) return ack?.({ ok: false, error: 'No game running' })
          const target = payload.playerId ?? s.currentPlayerId
          const name = s.players.find((p) => p.id === target)?.name ?? '?'
          godMutate(io, room, `handed the turn back to ${name}`, (n) => {
            n.currentPlayerId = target
            n.phase = 'ROLL'
            n.dice = null
            n.doubles = 0
            n.pendingPurchase = null
            n.pendingTax = null
            n.pendingCardDraw = null
            n.pendingMove = null
            n.debt = null
            n.debtQueue = []
            n.auction = null
            n.auctionQueue = []
          })
          return ack?.({ ok: true })
        }

        case 'setCash': {
          if (!s) return ack?.({ ok: false, error: 'No game running' })
          const amount = Math.max(0, Math.floor(Number(payload.amount)))
          const name = s.players.find((p) => p.id === payload.playerId)?.name ?? '?'
          godMutate(io, room, `set ${name}'s cash to $${amount}`, (n) => {
            const p = n.players.find((q) => q.id === payload.playerId)
            if (p) p.cash = amount
          })
          return ack?.({ ok: true })
        }

        case 'setPos': {
          if (!s) return ack?.({ ok: false, error: 'No game running' })
          const pos = Math.max(0, Math.min(39, Math.floor(Number(payload.pos))))
          const name = s.players.find((p) => p.id === payload.playerId)?.name ?? '?'
          godMutate(io, room, `moved ${name} to ${pos === 10 && payload.jail ? 'jail' : `space ${pos}`}`, (n) => {
            const p = n.players.find((q) => q.id === payload.playerId)
            if (p) {
              p.pos = pos
              if (payload.jail !== undefined) {
                p.jail = payload.jail
                if (payload.jail) p.jailRolls = 0
              }
            }
          })
          return ack?.({ ok: true })
        }

        case 'setJail': {
          if (!s) return ack?.({ ok: false, error: 'No game running' })
          const name = s.players.find((p) => p.id === payload.playerId)?.name ?? '?'
          godMutate(io, room, `${payload.jail ? 'jailed' : 'released'} ${name}`, (n) => {
            const p = n.players.find((q) => q.id === payload.playerId)
            if (p) {
              p.jail = payload.jail
              if (payload.jail) {
                p.pos = 10
                p.jailRolls = 0
              }
            }
          })
          return ack?.({ ok: true })
        }

        case 'setJailCards': {
          if (!s) return ack?.({ ok: false, error: 'No game running' })
          const count = Math.max(0, Math.min(5, Math.floor(Number(payload.count))))
          const name = s.players.find((p) => p.id === payload.playerId)?.name ?? '?'
          godMutate(io, room, `set ${name}'s jail cards to ${count}`, (n) => {
            const p = n.players.find((q) => q.id === payload.playerId)
            if (p) p.jailCards = count
          })
          return ack?.({ ok: true })
        }

        case 'setProperty': {
          if (!s) return ack?.({ ok: false, error: 'No game running' })
          const st = s.props[payload.space]
          if (!st) return ack?.({ ok: false, error: 'Not a purchasable space' })
          const ownerName = payload.owner ? (s.players.find((p) => p.id === payload.owner)?.name ?? 'a player') : 'the bank'
          godMutate(io, room, `gave space ${payload.space} to ${ownerName}`, (n) => {
            const t = n.props[payload.space]
            if (t) t.owner = payload.owner
          })
          return ack?.({ ok: true })
        }

        case 'setHouses': {
          if (!s) return ack?.({ ok: false, error: 'No game running' })
          const st = s.props[payload.space]
          if (!st) return ack?.({ ok: false, error: 'Not a street' })
          const count = Math.max(0, Math.min(5, Math.floor(Number(payload.count))))
          godMutate(io, room, `set space ${payload.space} to ${count === 5 ? 'hotel' : `${count} house(s)`}`, (n) => {
            const t = n.props[payload.space]
            if (t) t.houses = count
          })
          return ack?.({ ok: true })
        }

        case 'setMortgaged': {
          if (!s) return ack?.({ ok: false, error: 'No game running' })
          const st = s.props[payload.space]
          if (!st) return ack?.({ ok: false, error: 'Not a purchasable space' })
          godMutate(io, room, `${payload.mortgaged ? 'mortgaged' : 'lifted the mortgage on'} space ${payload.space}`, (n) => {
            const t = n.props[payload.space]
            if (t) t.mortgaged = payload.mortgaged
          })
          return ack?.({ ok: true })
        }

        case 'forceDraw': {
          if (!s) return ack?.({ ok: false, error: 'No game running' })
          // A pending debt or arrest owns the table until it settles —
          // forcing a draw on top of either would leave a reveal nobody is
          // allowed to open.
          if (s.debt) return ack?.({ ok: false, error: 'A debt is pending — it must settle first' })
          if (s.pendingJail) return ack?.({ ok: false, error: 'An arrest is pending — it must resolve first' })
          const name = s.players.find((p) => p.id === s.currentPlayerId)?.name ?? '?'
          godMutate(io, room, `forced a ${payload.deck === 'chest' ? 'Community Chest' : 'Chance'} draw for ${name}`, (n) => {
            n.pendingPurchase = null
            n.pendingTax = null
            const cur = n.players.find((q) => q.id === n.currentPlayerId)
            n.pendingCardDraw = cur
              ? { player: cur.id, deck: payload.deck, space: cur.pos }
              : null
            n.phase = 'ACTION'
          })
          return ack?.({ ok: true })
        }

        case 'setTimer': {
          const raw = Math.floor(Number(payload.ms))
          const ms = Number.isFinite(raw) ? Math.max(0, Math.min(3_600_000, raw)) : room.turnTimeoutMs
          room.turnTimeoutMs = ms
          // The in-progress decision re-arms with the new duration.
          room.timerKey = null
          if (s) {
            godMutate(io, room, `decision timer ${ms === 0 ? 'disabled' : `set to ${Math.round(ms / 1000)}s`}`, () => {})
          } else {
            broadcastLobby(io, room)
            void saveRoom(room)
          }
          return ack?.({ ok: true })
        }

        case 'endGame': {
          if (!s) return ack?.({ ok: false, error: 'No game running' })
          const winner = payload.winner
            ? (s.players.find((p) => p.id === payload.winner)?.name ?? 'nobody')
            : (s.players.find((p) => p.id === s.winner)?.name ?? 'nobody')
          godMutate(io, room, `ended the game — ${winner} wins`, (n) => {
            n.phase = 'GAME_OVER'
            n.winner = payload.winner ?? n.winner
            n.pendingPurchase = null
            n.pendingTax = null
            n.pendingCardDraw = null
            n.debt = null
            n.debtQueue = []
            n.auction = null
            n.auctionQueue = []
          })
          return ack?.({ ok: true })
        }

        case 'kick': {
          if (!s) return ack?.({ ok: false, error: 'No game running' })
          if (s.phase === 'GAME_OVER') return ack?.({ ok: false, error: 'The game is already over' })
          const target = s.players.find((q) => q.id === payload.playerId)
          if (!target) return ack?.({ ok: false, error: 'Not in this game' })
          if (target.bankrupt) return ack?.({ ok: false, error: 'They are already out' })
          // Same estate rule as a voluntary exit: player-debt → the lender
          // inherits via declareBankruptcy; anything else → bank forfeit
          // with the deeds under the hammer. forfeitSeat logs the headline.
          // Commit without broadcast first — the eviction below lands
          // before the one broadcast ships the new state.
          const res = commit(
            room,
            io,
            payload.playerId,
            (n) => forfeitSeat(n, payload.playerId, `The host removed ${target.name} — their properties go under the hammer`),
            { broadcast: false },
          )
          if (!res.ok) return ack?.({ ok: false, error: res.error })
          // Evict the phone exactly like the lobby kick: identity dies
          // with the seat, the rejoin token is destroyed.
          const entry = room.players.find((e) => e.meta.id === payload.playerId)
          if (entry) {
            playerTokens.delete(entry.token)
            const kicked = entry.socketId != null ? io.sockets.sockets.get(entry.socketId) : undefined
            if (kicked) {
              const td = kicked.data as SocketData
              if (td.code === room.code && td.playerId === payload.playerId) {
                td.code = undefined
                td.role = undefined
                td.playerId = undefined
              }
              kicked.leave(playerRoom(room.code, payload.playerId))
              kicked.emit('kicked')
            }
            entry.socketId = null
            entry.disconnectedAt = Date.now()
            if (room.hostPlayerId === payload.playerId) promoteHostOnDisconnect(room)
          }
          broadcastGame(io, room)
          return ack?.({ ok: true })
        }

        case 'export': {
          return ack?.({ ok: true, snapshot: serializeRoom(room) })
        }

        case 'import': {
          // Validate the ENTIRE snapshot first — the room is only touched if
          // every field is known-safe (see validateSnapshot).
          const snap = validateSnapshot(payload.json)
          if (!snap) {
            return ack?.({ ok: false, error: 'That file is not a valid game snapshot' })
          }
          restoreRoomFromSnapshot(room, snap)
          if (room.state) {
            godLog(room.state, 'imported a game snapshot')
            broadcastGame(io, room)
          } else {
            broadcastLobby(io, room)
            void saveRoom(room)
          }
          return ack?.({ ok: true })
        }

        default:
          return ack?.({ ok: false, error: 'Unknown god command' })
      }
    })

    socket.on('disconnect', () => {
      safe('disconnect', undefined, () => {
        const room = data.code ? rooms.get(data.code) : undefined
        if (!room) return
        if (data.role === 'host') room.hostSockets.delete(socket.id)
        if (data.role === 'player') {
          const e = room.players.find((x) => x.meta.id === data.playerId)
          // Only the player's CURRENT connection counts: a stale socket
          // dying long after the phone already reconnected (socket.io
          // notices ~45s later) must not touch the seat or steal the crown.
          const wasCurrent = e != null && e.socketId === socket.id
          if (wasCurrent) {
            e.socketId = null
            e.disconnectedAt = Date.now()
          }
          // The party crown never goes dark: hand it down the queue.
          if (wasCurrent && data.playerId === room.hostPlayerId) promoteHostOnDisconnect(room)
        }
        broadcast(room, io)
      })
    })
  })

  // Idle-room cleanup so a night of partying doesn't leak memory. Empty
  // rooms die fast (10 min) as long as no TV is watching them; real rooms
  // keep the 3-hour TTL measured from the last HUMAN action.
  setInterval(() => {
    safe('idle-room cleanup', undefined, () => {
      const now = Date.now()
      for (const [code, room] of rooms) {
        const emptyJunk = room.hostSockets.size === 0 && room.players.length === 0 && !room.state
        const expired = now - room.lastActive > (emptyJunk ? EMPTY_ROOM_TTL_MS : ROOM_TTL_MS)
        if (expired && room.hostSockets.size === 0) {
          rooms.delete(code)
          for (const [tok, ref] of playerTokens) if (ref.code === code) playerTokens.delete(tok)
          try {
            unlinkSync(path.join(SNAP_DIR, `${code}.json`))
          } catch {
            /* already gone */
          }
        }
      }
    })
  }, 5 * 60 * 1000).unref?.()
}
