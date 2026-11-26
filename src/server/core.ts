// ── Room substrate ──
// The shared foundation every other server module builds on: the Room
// type and its registry, room identity minting, socket identity checks,
// host migration, and the never-crash guard. Deliberately tiny and free
// of imports from the other server modules, so everything else layers on
// top of it (clock → persist → lobby/god → sockets).

import { randomUUID } from 'node:crypto'
import type { Server as IOServer, Socket } from 'socket.io'
import type { PlayerMeta } from '../shared/engine.js'
import type { GameState, LobbyInfo, LobbyPlayer } from '../shared/types.js'

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ' // no I/O — they confuse party guests
export const MAX_PLAYERS = 8
export const MIN_PLAYERS = 2
export const ROOM_TTL_MS = 3 * 60 * 60 * 1000
// An empty, unstarted room with no TV attached is junk (create-spam, or a
// TV that closed before anyone joined) — it doesn't need the full TTL.
export const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000
// Room-minting caps: one screen needs one room. A create storm must not be
// able to fill the ~330k code space, eat memory and litter the disk.
export const MAX_ROOMS_PER_SOCKET = 5
export const MAX_ROOMS = 200
// Every decision point gets 5 minutes by default (host-configurable in the
// lobby, or live from the god console). Phones only show the countdown in
// the final 30 seconds; on expiry the server plays a sensible default so a
// stalled phone can never stall the table.
export const DEFAULT_TURN_TIMEOUT_MS = 300_000

// The out-of-box game must terminate (panel evidence: 88% of 6-player
// no-trade games never ended). Standard 35 rounds is the default cap; the
// host can pick Quick 20 or Classic 0 (uncapped) in the lobby, beside the
// decision timer — same ownership domain, same room:settings channel.
export const DEFAULT_ROUNDS_CAP = 35

// Auction pacing: the opening window is more generous than the restarts —
// every bid resets a short fuse, so the hammer only falls after real silence,
// never mid-bidding-war.
export const AUCTION_OPEN_MS = 30_000
export const AUCTION_IDLE_MS = 15_000
// How long a missing phone may hold up an auction before the server passes
// on its behalf — long enough to survive a screen-lock blip, short enough
// that one lost device can't stall the table.
export const AUCTION_DISCONNECT_GRACE_MS = 15_000

// ── Per-socket rate limit ──
// A token bucket per connection applied to every inbound event: a hostile
// or runaway client must not eat the event loop or trigger clone storms.
// Capacity 30 with 10 tokens/second refill comfortably clears fast human
// play (and the test suites); only SUSTAINED exhaustion — the bucket
// continuously empty for 10 seconds — disconnects the socket, which is
// auto-rejoinable: disconnects are never punished, the seat waits.
export const RATE_CAPACITY = 30
export const RATE_REFILL_PER_SEC = 10
export const RATE_EXHAUSTION_MS = 10_000

export interface PlayerEntry {
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
  roundsCap: number // worth-victory round cap; 0 = uncapped (Classic)
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

export interface SocketData {
  code?: string
  role?: 'host' | 'player' | 'watcher'
  playerId?: string
  roomsCreated?: number
}

// The room registry and the socket-server reference are the module-level
// state that predated the split, relocated here verbatim — the one shared
// context every other module flows through (set once by attach()).
export const rooms = new Map<string, Room>()
export const playerTokens = new Map<string, { code: string; playerId: string }>()
let ioRef: IOServer | null = null
export function setIoRef(io: IOServer): void {
  ioRef = io
}
export function getIoRef(): IOServer | null {
  return ioRef
}

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

export function hostRoom(code: string): string {
  return `h:${code}`
}
export function playerRoom(code: string, playerId: string): string {
  return `p:${code}:${playerId}`
}

// One room-minting path for create and reset, so the guards and defaults
// can never drift apart.
export function mintRoom(
  turnTimeoutMs: number = DEFAULT_TURN_TIMEOUT_MS,
  roundsCap: number = DEFAULT_ROUNDS_CAP,
): Room {
  return {
    code: newCode(),
    hostToken: randomUUID(),
    hostPlayerId: null,
    turnTimeoutMs,
    roundsCap,
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
export function isCurrentConnection(room: Room, data: SocketData, socketId: string): boolean {
  if (data.role !== 'player' || !data.playerId) return false
  const e = room.players.find((x) => x.meta.id === data.playerId)
  return e != null && e.socketId === socketId
}

export function lobbyInfo(room: Room): LobbyInfo {
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
    roundsCap: room.roundsCap,
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
export function promoteHostOnLeave(room: Room, leaverId: string, seatIndex: number): void {
  if (room.hostPlayerId !== leaverId) return
  room.hostPlayerId = room.players.length > 0 ? room.players[seatIndex % room.players.length].meta.id : null
}

export function promoteHostOnDisconnect(room: Room): void {
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
export function safe(label: string, ack: unknown, fn: () => void): void {
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
