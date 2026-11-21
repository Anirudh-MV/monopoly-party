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
import { applyAction, createGame, type PlayerMeta } from '../shared/engine.js'
import { hostView, playerView } from '../shared/views.js'
import { allowedActions, alivePlayers, netWorth } from '../shared/rules.js'
import { TOKENS, stripEmoji } from '../shared/tokens.js'
import type { Action, GameState, LobbyInfo, LobbyPlayer } from '../shared/types.js'
import { validAction, validCode, validGodCommand, validToken } from '../shared/validate.js'

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ' // no I/O — they confuse party guests
const MAX_PLAYERS = 8
const MIN_PLAYERS = 2
const ROOM_TTL_MS = 3 * 60 * 60 * 1000
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

const PLAYER_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#f97316', '#06b6d4', '#ec4899']

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

  // Stall watchdog: if a live game reaches a state where NOBODY can act
  // (a rules-combination bug), attempt a targeted rescue instead of hanging
  // the party — and fall through to normal emission either way, so a failed
  // remedy never leaves clients on a stale view.
  if (s.phase !== 'GAME_OVER' && !room.watchdogBusy && alivePlayers(s).length > 1) {
    const stuck = alivePlayers(s).every((q) => allowedActions(s, q.id).length === 0)
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
  if (s.phase === 'DEBT' && s.debt) return { key: `debt:${s.turn}:${s.debt.debtor}`, playerId: s.debt.debtor }
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

function scheduleDeadline(room: Room): void {
  const s = room.state
  if (!s) return
  const decision = currentDecision(s)
  // Arrests run on a fixed 30-second clock even when the host has disabled
  // the general decision timer — the two-step arrest must never strand.
  const jailClock = decision != null && decision.key.startsWith('jail:')
  if (!decision || (room.turnTimeoutMs <= 0 && !jailClock)) {
    // Host disabled the decision clock entirely (and no arrest is pending).
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
  // Auctions: a generous opening window, then a short fuse that every bid
  // resets. Other decisions run on the host-configured clock.
  const auctionIdle = s.auction != null && (s.auction.bidder != null || s.auction.bid > 0)
  const duration = jailClock ? 30_000 : decision.key.startsWith('auc:')
    ? Math.min(room.turnTimeoutMs, auctionIdle ? AUCTION_IDLE_MS : AUCTION_OPEN_MS)
    : room.turnTimeoutMs
  s.deadline = Date.now() + duration
  s.deadlineFor = decision.playerId
  room.timer = setTimeout(() => {
    safe(`deadline ${decision.key}`, undefined, () => {
      room.timer = null
      const key = room.timerKey
      room.timerKey = null
      const st = room.state
      if (!st || key !== decision.key) return // decision already resolved
      if (decision.playerId != null) {
        applyServerAction(room, autoActionsFor(room, decision))
      } else {      // Auction silence: pass everyone who could still bid — the hammer falls.
        const au = st.auction
        if (!au) return
        for (const q of alivePlayers(st)) {
          if (!au.passed.includes(q.id) && q.id !== au.bidder) {
            applyServerAction(room, [[q.id, { type: 'passBid' }]])
            if (!room.state || room.state.phase !== 'AUCTION') break
          }
        }
      }
    })
  }, duration)
}

// Timer-side commit path: same clone-apply-commit rules as player actions,
// but no socket to ack to.
function applyServerAction(room: Room, autos: Array<[string, Action]>): boolean {
  let committed = false
  for (const [by, action] of autos) {
    const cur = room.state
    if (!cur) break
    const next = structuredClone(cur)
    const res = applyAction(next, action, by)
    if (res.ok) {
      room.state = next
      room.lastActive = Date.now()
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

// ── God console ──
// Emergency operator controls for the TV host: rescue turns, edit wallets,
// reassign properties, force reveals, export/import the whole game.

function godLog(next: GameState, note: string): void {
  next.log.push({ text: `GOD: ${note}`, kind: 'info' })
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

function restoreRoomFromSnapshot(room: Room, data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  const st = (d.state ?? null) as GameState | null
  if (st && (!Array.isArray(st.players) || typeof st.phase !== 'string')) return false
  if (!Array.isArray(d.players)) return false
  const prevConnected = new Map(room.players.map((e) => [e.meta.id, e.socketId]))
  // re-key rejoin tokens to the incoming seats
  for (const [tok, ref] of playerTokens) if (ref.code === room.code) playerTokens.delete(tok)
  room.hostPlayerId = (d.hostPlayerId as string | null) ?? null
  const rawTimeout = Number(d.turnTimeoutMs ?? room.turnTimeoutMs)
  room.turnTimeoutMs = Number.isFinite(rawTimeout)
    ? Math.max(0, Math.min(3_600_000, Math.floor(rawTimeout)))
    : room.turnTimeoutMs
  room.players = (d.players as Array<{ meta: PlayerMeta; token: string }>).map((e) => ({
    meta: e.meta,
    token: e.token,
    // same-room imports keep live sockets attached to their seats
    socketId: prevConnected.get(e.meta.id) ?? null,
    disconnectedAt: null,
  }))
  for (const e of room.players) playerTokens.set(e.token, { code: room.code, playerId: e.meta.id })
  room.state = st
  return true
}

export function attach(io: IOServer, getJoinUrls: () => string[], snapshotDir = 'snapshots'): void {
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
      const room: Room = {
        code: newCode(),
        hostToken: randomUUID(),
        hostPlayerId: null,
        turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
        state: null,
        hostSockets: new Set(),
        players: [],
        lastActive: Date.now(),
        timer: null,
        timerKey: null,
        watchdogBusy: false,
      }
      rooms.set(room.code, room)
      // one connection, one room: detach from any previous room first
      leaveCurrentRoom(io, socket, data)
      socket.join(hostRoom(room.code))
      room.hostSockets.add(socket.id)
      data.code = room.code
      data.role = 'host'
      socket.emit('lobby', lobbyInfo(room)) // render the empty lobby immediately
      ack?.({ ok: true, code: room.code, hostToken: room.hostToken, urls: getJoinUrls() })
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
      ack?.({ ok: true, code: room.code, urls: getJoinUrls() })
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
      ack?.({ ok: true, code: room.code, urls: getJoinUrls() })
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

      const seat = room.players.length
      const meta: PlayerMeta = {
        id: randomUUID(),
        name,
        color: PLAYER_COLORS[seat % PLAYER_COLORS.length],
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

      if (room.state) {
        // Mid-game exit: the seat stays at the table — the game plays on and
        // the decision clock covers their turns — but this phone is out for
        // good: its rejoin token is destroyed, so it can never wander back.
        const entry = room.players[idx]
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

    // ── Party host powers (migratable player role) ──
    on('game:handOver', (raw: unknown, ack?: (res: unknown) => void) => {
      const room = data.code ? rooms.get(data.code) : undefined
      if (!room || room.state) return ack?.({ ok: false, error: 'Only in the lobby' })
      if (data.role !== 'player' || !data.playerId || data.playerId !== room.hostPlayerId) {
        return ack?.({ ok: false, error: 'Only the host can do that' })
      }
      const to = typeof (raw as { to?: unknown })?.to === 'string' ? (raw as { to?: string }).to : ''
      const target = room.players.find((e) => e.meta.id === to)
      if (!target || target.meta.id === data.playerId) return ack?.({ ok: false, error: 'Pick another player' })
      room.hostPlayerId = target.meta.id
      broadcastLobby(io, room)
      ack?.({ ok: true })
    })

    // ── Game flow ──
    on('game:start', (_raw: unknown, ack?: (res: unknown) => void) => {
      const room = data.code ? rooms.get(data.code) : undefined
      if (!room) return ack?.({ ok: false, error: 'Room not found' })
      const isTvHost = room.hostSockets.has(socket.id)
      const isPartyHost = data.role === 'player' && data.playerId === room.hostPlayerId
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
      if (data.role !== 'player' || !data.playerId) return ack?.({ ok: false, error: 'Players only' })

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
        const isPartyHost = data.role === 'player' && data.playerId === room.hostPlayerId
        if (!isTvHost && !isPartyHost) return ack?.({ ok: false, error: 'Hosts only' })
        const rawMs = (raw as { turnTimeoutMs?: unknown } | null | undefined)?.turnTimeoutMs
        // Whole minutes-of-seconds only: no NaN, no strings, no floats.
        const ms =
          typeof rawMs === 'number' && Number.isInteger(rawMs)
            ? Math.max(0, Math.min(3_600_000, rawMs))
            : null
        if (ms === null) return ack?.({ ok: false, error: 'Bad timer value' })
        room.turnTimeoutMs = ms
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

        case 'export': {
          return ack?.({ ok: true, snapshot: serializeRoom(room) })
        }

        case 'import': {
          if (!restoreRoomFromSnapshot(room, payload.json)) {
            return ack?.({ ok: false, error: 'That file is not a valid game snapshot' })
          }
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

  // Idle-room cleanup so a night of partying doesn't leak memory.
  setInterval(() => {
    safe('idle-room cleanup', undefined, () => {
      const now = Date.now()
      for (const [code, room] of rooms) {
        if (now - room.lastActive > ROOM_TTL_MS && room.hostSockets.size === 0) {
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
  }, 15 * 60 * 1000).unref?.()
}
