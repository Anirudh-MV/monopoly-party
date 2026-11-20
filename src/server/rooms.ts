// ── Room manager + socket glue ──
// One process hosts many rooms. Each room has:
//   - a 4-letter code, a TV token, and per-player rejoin tokens
//   - a PLAYER host: first joiner by default, migrates down the join queue
//     when they leave/disconnect, and can hand duties to another player.
// The TV joins channel h:<code>; each phone joins p:<code>:<playerId>.
// Every applied action triggers a full view push (state is tiny — party scale).

import { randomUUID } from 'node:crypto'
import type { Server as IOServer, Socket } from 'socket.io'
import { applyAction, createGame, type PlayerMeta } from '../shared/engine.js'
import { hostView, playerView } from '../shared/views.js'
import { alivePlayers, netWorth } from '../shared/rules.js'
import type { Action, GameState, LobbyInfo, LobbyPlayer } from '../shared/types.js'

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ' // no I/O — they confuse party guests
const MAX_PLAYERS = 8
const MIN_PLAYERS = 2
const ROOM_TTL_MS = 3 * 60 * 60 * 1000
// Every decision point gets 5 minutes. Phones only show the countdown in
// the final 30 seconds; when it expires the server plays a sensible default
// so a stalled phone can never stall the table.
const TURN_TIMEOUT_MS = 300_000

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
  state: GameState | null
  hostSockets: Set<string>
  players: PlayerEntry[]
  lastActive: number
  timer: ReturnType<typeof setTimeout> | null
  timerKey: string | null
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

  // The deadline lives on the state so every view carries it.
  scheduleDeadline(room)

  io.to(hostRoom(room.code)).emit('view', hostView(s, room.code, room.hostPlayerId))
  for (const e of room.players) {
    io.to(playerRoom(room.code, e.meta.id)).emit('view', playerView(s, room.code, e.meta.id, room.hostPlayerId))
  }
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
  s.deadline = Date.now() + TURN_TIMEOUT_MS
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
  }, TURN_TIMEOUT_MS)
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

export function attach(io: IOServer, getJoinUrls: () => string[]): void {
  ioRef = io
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
        state: null,
        hostSockets: new Set(),
        players: [],
        lastActive: Date.now(),
        timer: null,
        timerKey: null,
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
      if (room.state) socket.emit('view', hostView(room.state, room.code, room.hostPlayerId))
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
      }
    }
  }, 15 * 60 * 1000).unref?.()
}
