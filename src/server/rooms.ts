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
import type { Action, GameState, GodCommand, LobbyInfo, LobbyPlayer } from '../shared/types.js'

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ' // no I/O — they confuse party guests
const MAX_PLAYERS = 8
const MIN_PLAYERS = 2
const ROOM_TTL_MS = 3 * 60 * 60 * 1000
// Every decision point gets 5 minutes by default (host-configurable in the
// lobby, or live from the god console). Phones only show the countdown in
// the final 30 seconds; on expiry the server plays a sensible default so a
// stalled phone can never stall the table.
const DEFAULT_TURN_TIMEOUT_MS = 300_000

const PLAYER_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#f97316', '#06b6d4', '#ec4899']
const PLAYER_TOKENS = ['🎩', '🚗', '🐕', '🚢', '👞', '🐈', '🛴', '🍀']

interface PlayerEntry {
  meta: PlayerMeta
  token: string // rejoin secret, stored in the phone's localStorage
  socketId: string | null
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
  role?: 'host' | 'player'
  playerId?: string
}

const rooms = new Map<string, Room>()
const playerTokens = new Map<string, { code: string; playerId: string }>()
let ioRef: IOServer | null = null

function newCode(): string {
  let c = ''
  do {
    c = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('')
  } while (rooms.has(c))
  return c
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
  room.hostPlayerId = nextHostInQueue(room, idx)
}

function broadcastLobby(io: IOServer, room: Room): void {
  const info = lobbyInfo(room)
  io.to(hostRoom(room.code)).emit('lobby', info)
  for (const e of room.players) io.to(playerRoom(room.code, e.meta.id)).emit('lobby', info)
  void saveRoom(room)
}

function broadcastGame(io: IOServer, room: Room): void {
  const s = room.state
  if (!s) return

  // Safety: if a phone is disconnected mid-auction, auto-pass on its behalf
  // so a missing device can never stall the whole table.
  if (s.phase === 'AUCTION' && s.auction) {
    for (const e of room.players) {
      const p = s.players.find((q) => q.id === e.meta.id)
      if (
        p &&
        !p.bankrupt &&
        e.socketId == null &&
        !s.auction.passed.includes(p.id) &&
        s.auction.bidder !== p.id
      ) {
        applyAction(s, { type: 'passBid' }, p.id)
      }
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
    if (s.pendingCardDraw) return { key: `draw:${s.turn}:${s.pendingCardDraw.deck}:${s.pendingCardDraw.space}`, playerId: s.currentPlayerId }
    if (s.pendingPurchase != null) return { key: `buy:${s.turn}:${s.pendingPurchase}`, playerId: s.currentPlayerId }
    if (s.pendingTax) return { key: `tax:${s.turn}`, playerId: s.currentPlayerId }
    return { key: `end:${s.turn}:${s.currentPlayerId}`, playerId: s.currentPlayerId }
  }
  if (s.phase === 'DEBT' && s.debt) return { key: `debt:${s.turn}:${s.debt.debtor}`, playerId: s.debt.debtor }
  if (s.phase === 'AUCTION' && s.auction) return { key: `auc:${s.turn}:${s.auction.space}`, playerId: null }
  return null
}

// The sensible default each deadline plays on expiry.
function autoActionsFor(room: Room, d: Decision): Array<[string, Action]> {
  const s = room.state
  if (!s || !d.playerId) return []
  if (d.key.startsWith('roll:')) return [[d.playerId, { type: 'roll' }]]
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
  if (room.turnTimeoutMs <= 0) {
    // Host disabled the decision clock entirely.
    if (room.timer) clearTimeout(room.timer)
    room.timer = null
    room.timerKey = null
    s.deadline = null
    s.deadlineFor = null
    return
  }
  const decision = currentDecision(s)
  if (!decision) {
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
  s.deadline = Date.now() + room.turnTimeoutMs
  s.deadlineFor = decision.playerId
  room.timer = setTimeout(() => {
    room.timer = null
    const key = room.timerKey
    room.timerKey = null
    const st = room.state
    if (!st || key !== decision.key) return // decision already resolved
    if (decision.playerId != null) {
      applyServerAction(room, autoActionsFor(room, decision))
    } else {
      // Auction silence: pass everyone who could still bid — the hammer falls.
      const au = st.auction
      if (!au) return
      for (const q of alivePlayers(st)) {
        if (!au.passed.includes(q.id) && q.id !== au.bidder) {
          applyServerAction(room, [[q.id, { type: 'passBid' }]])
          if (!room.state || room.state.phase !== 'AUCTION') break
        }
      }
    }
  }, room.turnTimeoutMs)
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

async function saveRoom(room: Room): Promise<void> {
  try {
    await fsp.mkdir(SNAP_DIR, { recursive: true })
    await fsp.writeFile(path.join(SNAP_DIR, `${room.code}.json`), JSON.stringify(serializeRoom(room)))
  } catch (e) {
    console.error(`[snapshots] failed to save ${room.code}:`, e)
  }
}

function loadSnapshots(): void {
  try {
    mkdirSync(SNAP_DIR, { recursive: true })
    for (const f of readdirSync(SNAP_DIR).filter((x) => x.endsWith('.json'))) {
      try {
        const raw = JSON.parse(readFileSync(path.join(SNAP_DIR, f), 'utf8')) as RoomSnapshot
        if (typeof raw.code !== 'string' || !Array.isArray(raw.players)) continue
        const room: Room = {
          code: raw.code,
          hostToken: String(raw.hostToken ?? ''),
          hostPlayerId: raw.hostPlayerId ?? null,
          turnTimeoutMs: Number(raw.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS),
          state: raw.state ?? null,
          hostSockets: new Set(),
          players: raw.players.map((e) => ({ meta: e.meta, token: e.token, socketId: null })),
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
  room.turnTimeoutMs = Number(d.turnTimeoutMs ?? room.turnTimeoutMs)
  room.players = (d.players as Array<{ meta: PlayerMeta; token: string }>).map((e) => ({
    meta: e.meta,
    token: e.token,
    // same-room imports keep live sockets attached to their seats
    socketId: prevConnected.get(e.meta.id) ?? null,
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

    // ── TV ──
    socket.on('room:create', (ack?: (res: unknown) => void) => {
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
      socket.join(hostRoom(room.code))
      room.hostSockets.add(socket.id)
      data.code = room.code
      data.role = 'host'
      socket.emit('lobby', lobbyInfo(room)) // render the empty lobby immediately
      ack?.({ ok: true, code: room.code, hostToken: room.hostToken, urls: getJoinUrls() })
    })

    socket.on('room:hostJoin', (payload: { code?: string; hostToken?: string }, ack?: (res: unknown) => void) => {
      const room = rooms.get(String(payload?.code ?? '').toUpperCase())
      if (!room || room.hostToken !== payload?.hostToken) {
        ack?.({ ok: false, error: 'Room not found' })
        return
      }
      socket.join(hostRoom(room.code))
      room.hostSockets.add(socket.id)
      data.code = room.code
      data.role = 'host'
      if (room.state) socket.emit('view', hostView(room.state, room.code, room.hostPlayerId, room.turnTimeoutMs))
      else socket.emit('lobby', lobbyInfo(room))
      ack?.({ ok: true, code: room.code, urls: getJoinUrls() })
    })

    // ── Phones ──
    socket.on(
      'room:join',
      (payload: { code?: string; name?: string }, ack?: (res: unknown) => void) => {
        const room = rooms.get(String(payload?.code ?? '').toUpperCase())
        if (!room) return ack?.({ ok: false, error: 'No room with that code' })
        if (room.state) return ack?.({ ok: false, error: 'That game already started' })
        if (room.players.length >= MAX_PLAYERS) return ack?.({ ok: false, error: 'Room is full (8 players)' })

        const name = String(payload?.name ?? '').trim().slice(0, 16)
        if (name.length < 1) return ack?.({ ok: false, error: 'Enter your name' })
        if (room.players.some((e) => e.meta.name.toLowerCase() === name.toLowerCase())) {
          return ack?.({ ok: false, error: 'Someone already took that name' })
        }

        const seat = room.players.length
        const meta: PlayerMeta = {
          id: randomUUID(),
          name,
          color: PLAYER_COLORS[seat % PLAYER_COLORS.length],
          token: PLAYER_TOKENS[seat % PLAYER_TOKENS.length],
        }
        const entry: PlayerEntry = { meta, token: randomUUID(), socketId: socket.id }
        room.players.push(entry)
        playerTokens.set(entry.token, { code: room.code, playerId: meta.id })

        // First joiner is the party host by default.
        if (!room.hostPlayerId) room.hostPlayerId = meta.id

        socket.join(playerRoom(room.code, meta.id))
        data.code = room.code
        data.role = 'player'
        data.playerId = meta.id
        broadcastLobby(io, room)
        ack?.({ ok: true, code: room.code, playerId: meta.id, token: entry.token })
      },
    )

    socket.on('room:rejoin', (payload: { token?: string }, ack?: (res: unknown) => void) => {
      const t = playerTokens.get(String(payload?.token ?? ''))
      if (!t) return ack?.({ ok: false, error: 'Session expired — rejoin with the room code' })
      const room = rooms.get(t.code)
      const entry = room?.players.find((e) => e.meta.id === t.playerId)
      if (!room || !entry) return ack?.({ ok: false, error: 'Session expired — rejoin with the room code' })

      socket.join(playerRoom(room.code, entry.meta.id))
      entry.socketId = socket.id
      data.code = room.code
      data.role = 'player'
      data.playerId = entry.meta.id
      broadcast(room, io)
      ack?.({ ok: true, code: room.code, playerId: entry.meta.id })
    })

    socket.on('room:leave', (_payload: unknown, ack?: (res: unknown) => void) => {
      const room = data.code ? rooms.get(data.code) : undefined
      if (!room || data.role !== 'player' || room.state) return ack?.({ ok: false })
      const idx = room.players.findIndex((e) => e.meta.id === data.playerId)
      if (idx >= 0) {
        const [gone] = room.players.splice(idx, 1)
        playerTokens.delete(gone.token)
        promoteHostOnLeave(room, gone.meta.id, idx)
        broadcastLobby(io, room)
      }
      ack?.({ ok: true })
    })

    // ── Party host powers (migratable player role) ──
    socket.on(
      'game:handOver',
      (payload: { to?: string }, ack?: (res: unknown) => void) => {
        const room = data.code ? rooms.get(data.code) : undefined
        if (!room || room.state) return ack?.({ ok: false, error: 'Only in the lobby' })
        if (data.role !== 'player' || !data.playerId || data.playerId !== room.hostPlayerId) {
          return ack?.({ ok: false, error: 'Only the host can do that' })
        }
        const target = room.players.find((e) => e.meta.id === payload?.to)
        if (!target || target.meta.id === data.playerId) return ack?.({ ok: false, error: 'Pick another player' })
        room.hostPlayerId = target.meta.id
        broadcastLobby(io, room)
        ack?.({ ok: true })
      },
    )

    // ── Game flow ──
    socket.on('game:start', (_payload: unknown, ack?: (res: unknown) => void) => {
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

    socket.on('game:action', (action: Action, ack?: (res: unknown) => void) => {
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
    socket.on(
      'room:settings',
      (payload: { turnTimeoutMs?: number }, ack?: (res: unknown) => void) => {
        const room = data.code ? rooms.get(data.code) : undefined
        if (!room) return ack?.({ ok: false, error: 'Room not found' })
        const isTvHost = room.hostSockets.has(socket.id)
        const isPartyHost = data.role === 'player' && data.playerId === room.hostPlayerId
        if (!isTvHost && !isPartyHost) return ack?.({ ok: false, error: 'Hosts only' })
        const raw = Number(payload?.turnTimeoutMs)
        const ms = Number.isFinite(raw) ? Math.max(0, Math.min(3_600_000, Math.floor(raw))) : room.turnTimeoutMs
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
    socket.on('god:command', (payload: GodCommand, ack?: (res: unknown) => void) => {
      const room = data.code ? rooms.get(data.code) : undefined
      if (!room || !room.hostSockets.has(socket.id)) {
        return ack?.({ ok: false, error: 'The god console is only available on the TV screen' })
      }
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
      const room = data.code ? rooms.get(data.code) : undefined
      if (!room) return
      if (data.role === 'host') room.hostSockets.delete(socket.id)
      if (data.role === 'player') {
        const e = room.players.find((x) => x.meta.id === data.playerId)
        if (e && e.socketId === socket.id) e.socketId = null
        // The party crown never goes dark: hand it down the queue.
        if (data.playerId === room.hostPlayerId) promoteHostOnDisconnect(room)
      }
      broadcast(room, io)
    })
  })

  // Idle-room cleanup so a night of partying doesn't leak memory.
  setInterval(() => {
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
  }, 15 * 60 * 1000).unref?.()
}
