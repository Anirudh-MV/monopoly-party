// ── Room manager + socket glue ──
// One process hosts many rooms. Each room has:
//   - a 4-letter code, a TV token, and per-player rejoin tokens
//   - a PLAYER host: first joiner by default, migrates down the join queue
//     when they leave/disconnect, and can hand duties to another player.
// The TV joins channel h:<code>; each phone joins p:<code>:<playerId>.
// Every applied action triggers a full view push (state is tiny — party scale).

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import path from 'node:path'
import type { Server as IOServer, Socket } from 'socket.io'
import { applyAction, createGame, declareBankruptcy, forfeitEstate, MAX_GAME_LOG, type PlayerMeta, type Result } from '../shared/engine.js'
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

interface PlayerEntry {
  meta: PlayerMeta
  token: string // rejoin secret, stored in the phone's localStorage
  socketId: string | null
  disconnectedAt: number | null // when the live socket went away (grace timers)
}

interface Room {
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
  // gets a grace period first. Copy-and-commit, like every other state
  // change: a failed pass never leaves half-applied state behind.
  if (s.phase === 'AUCTION' && s.auction) {
    const due: Array<[string, Action]> = []
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
    if (due.length > 0) {
      const next = structuredClone(s)
      for (const [by, act] of due) applyAction(next, act, by)
      room.state = next
      s = next
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

  io.to(hostRoom(room.code)).emit('view', hostView(s, room.code, room.hostPlayerId, room.turnTimeoutMs))
  for (const e of room.players) {
    io.to(playerRoom(room.code, e.meta.id)).emit('view', playerView(s, room.code, e.meta.id, room.hostPlayerId, room.turnTimeoutMs))
  }
  void saveRoom(room)
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
    const p = s.players.find((q) => q.id === d.playerId)
    const amount = s.debt?.amount ?? 0
    return p && p.cash >= amount
      ? [[d.playerId, { type: 'payDebt' }]]
      : [[d.playerId, { type: 'bankrupt' }]]
  }
  return []
}

// The single source of truth for the decision clock, pure so the remedy
// checks can test it directly: which decision is ticking, whose hands are
// tied, and how long it gets. null = no clock (nothing is blocking play, or
// the host turned the timer off for a decision that isn't on a fixed clock).
//
// Two-tier debt clocks: an AFFORDABLE debt arms a fixed 30 seconds even when
// the host clock is off — the money is sitting in the wallet, one tap away,
// and a stalled phone must not stall the table. An UNAFFORDABLE debt stays
// on the host clock and unarmed when the timer is off — the debtor can always
// sell, mortgage or bankrupt themselves, and the watchdog remains
// "nobody-can-act"-based rather than a debt-specific hammer.
export function decisionFor(s: GameState, turnTimeoutMs: number): { key: string; playerId: string | null; ms: number } | null {
  const decision = currentDecision(s)
  if (!decision) return null
  const key = decision.key
  // Arrests and end-of-turn waits run on a fixed 30-second clock even when
  // the host has disabled the general decision timer — they must never strand.
  if (key.startsWith('jail:') || key.startsWith('end:')) return { ...decision, ms: 30_000 }
  if (key.startsWith('debt:')) {
    const d = s.debt
    if (!d) return null
    const debtor = s.players.find((q) => q.id === d.debtor)
    if (debtor && debtor.cash >= d.amount) return { ...decision, ms: 30_000 }
    if (turnTimeoutMs <= 0) return null
    return { ...decision, ms: turnTimeoutMs }
  }
  if (turnTimeoutMs <= 0) return null
  if (key.startsWith('auc:')) {
    // Auctions: a generous opening window, then a short fuse that every bid
    // resets.
    const auctionIdle = s.auction != null && (s.auction.bidder != null || s.auction.bid > 0)
    return { ...decision, ms: Math.min(turnTimeoutMs, auctionIdle ? AUCTION_IDLE_MS : AUCTION_OPEN_MS) }
  }
  return { ...decision, ms: turnTimeoutMs }
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
        committed = applyServerAction(room, autoActionsFor(room, decision))
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

// Timer-side commit path: same clone-apply-commit rules as player actions,
// but no socket to ack to. Auto-actions are NOT human activity — they must
// never extend the room's idle TTL, or an abandoned auto-playing game
// lives forever.
function applyServerAction(room: Room, autos: Array<[string, Action]>): boolean {
  let committed = false
  for (const [by, action] of autos) {
    const cur = room.state
    if (!cur) break
    const next = structuredClone(cur)
    const res = applyAction(next, action, by)
    if (res.ok) {
      room.state = next
      committed = true
    }
    // A failed auto-action just means the state moved on; the broadcast
    // that follows schedules whatever decision comes next.
  }
  if (committed && ioRef) broadcastGame(ioRef, room)
  return committed
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
        const raw = JSON.parse(readFileSync(path.join(SNAP_DIR, f), 'utf8')) as RoomSnapshot
        if (typeof raw.code !== 'string' || !Array.isArray(raw.players)) continue
        const room: Room = {
          code: raw.code,
          hostToken: String(raw.hostToken ?? ''),
          hostPlayerId: raw.hostPlayerId ?? null,
          turnTimeoutMs: Number.isFinite(Number(raw.turnTimeoutMs))
            ? Math.max(0, Math.min(3_600_000, Math.floor(Number(raw.turnTimeoutMs))))
            : DEFAULT_TURN_TIMEOUT_MS,
          state: raw.state ?? null,
          hostSockets: new Set(),
          players: raw.players.map((e) => ({ meta: e.meta, token: e.token, socketId: null, disconnectedAt: null })),
          lastActive: Date.now(),
          timer: null,
          timerKey: null,
          watchdogBusy: false,
        }
        rooms.set(room.code, room)
        for (const e of room.players) playerTokens.set(e.token, { code: room.code, playerId: e.meta.id })
        console.log(
          `[snapshots] restored room ${room.code} (${room.players.length} players, ${room.state ? `turn ${room.state.turn}` : 'lobby'})`,
        )
      } catch (e) {
        console.error(`[snapshots] failed to restore ${f}:`, e)
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
// or null if anything about the input is off.
function validateSnapshot(raw: unknown): RoomSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  let bytes: number
  try {
    bytes = JSON.stringify(raw).length
  } catch {
    return null
  }
  if (bytes > SNAPSHOT_MAX_BYTES) return null
  const d = raw as Record<string, unknown>

  // ── seats: 2..8, clean metas, unique ids and pieces ──
  if (!Array.isArray(d.players) || d.players.length < MIN_PLAYERS || d.players.length > MAX_PLAYERS) return null
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
  const s = room.state
  if (!s) return false
  const next = structuredClone(s)
  fn(next)
  godLog(next, note)
  room.state = next
  broadcastGame(io, room)
  return true
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
    const on = (ev: string, handler: (raw: unknown, ack?: (res: unknown) => void) => void): void => {
      socket.on(ev, (...args: unknown[]) => {
        const ack = args.find((a): a is (res: unknown) => void => typeof a === 'function')
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
          const name = s.players.find((q) => q.id === data.playerId)?.name ?? entry.meta.name
          const next = structuredClone(s)
          const res = forfeitSeat(next, data.playerId, `${name} left the party — their properties go under the hammer`)
          if (res.ok) room.state = next
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
      // leaves half-applied state behind.
      const next = structuredClone(room.state)
      const res = applyAction(next, action, data.playerId)
      if (!res.ok) return ack?.({ ok: false, error: res.error })

      room.state = next
      room.lastActive = Date.now()
      broadcastGame(io, room)
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
          const next = structuredClone(s)
          const res = forfeitSeat(next, payload.playerId, `The host removed ${target.name} — their properties go under the hammer`)
          if (!res.ok) return ack?.({ ok: false, error: res.error })
          room.state = next
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
