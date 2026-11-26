// ── Lobby lifecycle ──
// The handler bodies for everything before and around the game: create,
// host join, mirror-watch, join, rejoin, leave, pieces, colours, renames,
// lobby kicks, host hand-over, the lobby reset, game start and the host
// settings dials. sockets.ts registers each one on its event; every body
// here is the verbatim pre-split logic (guards, acks and broadcast paths
// unchanged).

import { randomUUID } from 'node:crypto'
import type { Server as IOServer, Socket } from 'socket.io'
import { createGame, type PlayerMeta } from '../shared/engine.js'
import { hostView } from '../shared/views.js'
import { TOKENS, stripEmoji } from '../shared/tokens.js'
import { COLORS } from '../shared/colors.js'
import { validCode, validRoundsCap, validToken } from '../shared/validate.js'
import {
  hostRoom,
  isCurrentConnection,
  lobbyInfo,
  MAX_PLAYERS,
  MAX_ROOMS,
  MAX_ROOMS_PER_SOCKET,
  MIN_PLAYERS,
  mintRoom,
  playerRoom,
  playerTokens,
  PlayerEntry,
  promoteHostOnDisconnect,
  promoteHostOnLeave,
  rooms,
  type Room,
  type SocketData,
} from './core.js'
import { broadcast, broadcastGame, broadcastLobby, commit, forfeitSeat } from './clock.js'
import { forgetRoom, saveRoom } from './persist.js'
import { godMutate } from './god.js'

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

type Ack = (res: unknown) => void

// ── TV ──

export function createRoom(
  io: IOServer,
  socket: Socket,
  data: SocketData,
  ack: Ack | undefined,
  getJoinUrls: (code: string) => string[],
): void {
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
}

export function hostJoin(
  io: IOServer,
  socket: Socket,
  data: SocketData,
  raw: unknown,
  ack: Ack | undefined,
  getJoinUrls: (code: string) => string[],
): void {
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
}

// Extra TVs: mirror the room on any other screen. The watcher joins the
// host broadcast room but NEVER hostSockets — god, start and settings
// check that set, so mirrored screens are view-only by construction.
export function watchRoom(
  io: IOServer,
  socket: Socket,
  data: SocketData,
  raw: unknown,
  ack: Ack | undefined,
  getJoinUrls: (code: string) => string[],
): void {
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
}

// ── Phones ──

export function joinRoom(io: IOServer, socket: Socket, data: SocketData, raw: unknown, ack: Ack | undefined): void {
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
}

export function rejoinRoom(io: IOServer, socket: Socket, data: SocketData, raw: unknown, ack: Ack | undefined): void {
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
}

export function leaveRoom(io: IOServer, socket: Socket, data: SocketData, ack: Ack | undefined): void {
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
}

// Swap your piece while still in the lobby — identities lock once the
// game starts (each piece is a distinct 3D avatar; mid-game swaps would
// confuse the table).
export function setPiece(io: IOServer, socket: Socket, data: SocketData, raw: unknown, ack: Ack | undefined): void {
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
}

// Swap your colour while still in the lobby — the avatar wears it on
// the board. One colour per player, unique in the room.
export function setColor(io: IOServer, socket: Socket, data: SocketData, raw: unknown, ack: Ack | undefined): void {
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
}

// Rename YOURSELF while still in the lobby. There is no target-id
// field — self is implied, so renaming someone else is structurally
// impossible. Name validation is identical to room:join's checks.
export function renameSelf(io: IOServer, socket: Socket, data: SocketData, raw: unknown, ack: Ack | undefined): void {
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
}

// The party host can remove someone from the LOBBY (locked once the
// game starts — a mid-game kick would strand a live seat). The kicked
// phone loses its seat identity and is told politely.
export function kickFromLobby(io: IOServer, socket: Socket, data: SocketData, raw: unknown, ack: Ack | undefined): void {
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
}

// ── Party host powers (migratable player role) ──

export function handOver(io: IOServer, socket: Socket, data: SocketData, raw: unknown, ack: Ack | undefined): void {
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
}

// ── Lobby reset: dissolve this room and mint a fresh one ──
// Lobby-only by hard guard — never touches the engine or the estate
// rules. The initiator (TV socket or crown phone) gets the new room via
// the ack; other TVs follow via room:moved; every seated phone is
// evacuated with room:closed carrying the new code so the join form
// prefills it. Watchers auto-follow on the client.
export function resetRoom(
  io: IOServer,
  socket: Socket,
  data: SocketData,
  ack: Ack | undefined,
  getJoinUrls: (code: string) => string[],
): void {
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

  // the fresh room keeps the screen's timer and cap preferences — those
  // are preferences, not part of the mess being reset
  const next = mintRoom(old.turnTimeoutMs, old.roundsCap)
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
  forgetRoom(old)

  ack?.({ ok: true, code: next.code, hostToken: next.hostToken, urls })
}

// ── Game flow ──

export function startGame(io: IOServer, socket: Socket, data: SocketData, ack: Ack | undefined): void {
  const room = data.code ? rooms.get(data.code) : undefined
  if (!room) return ack?.({ ok: false, error: 'Room not found' })
  const isTvHost = room.hostSockets.has(socket.id)
  const isPartyHost = isCurrentConnection(room, data, socket.id) && data.playerId === room.hostPlayerId
  if (!isTvHost && !isPartyHost) return ack?.({ ok: false, error: 'Hosts only' })
  if (room.state) return ack?.({ ok: false, error: 'Already started' })
  if (room.players.length < MIN_PLAYERS) return ack?.({ ok: false, error: 'Need at least 2 players' })
  room.state = createGame(room.players.map((e) => e.meta), Math.random, room.roundsCap)
  broadcastGame(io, room)
  ack?.({ ok: true })
}

// ── Host lobby settings ──
// One channel, two host-owned dials: the decision timer (turnTimeoutMs)
// and the round cap (roundsCap — the worth-victory presets). Each field
// is optional in the payload (a dial that wasn't touched isn't sent),
// but at least one must arrive, well-formed.
export function applySettings(
  io: IOServer,
  socket: Socket,
  data: SocketData,
  raw: unknown,
  ack: Ack | undefined,
): void {
  const room = data.code ? rooms.get(data.code) : undefined
  if (!room) return ack?.({ ok: false, error: 'Room not found' })
  const isTvHost = room.hostSockets.has(socket.id)
  const isPartyHost = isCurrentConnection(room, data, socket.id) && data.playerId === room.hostPlayerId
  if (!isTvHost && !isPartyHost) return ack?.({ ok: false, error: 'Hosts only' })
  const payload = (raw ?? {}) as { turnTimeoutMs?: unknown; roundsCap?: unknown }
  const hasTimer = payload.turnTimeoutMs !== undefined
  const hasCap = payload.roundsCap !== undefined
  if (!hasTimer && !hasCap) return ack?.({ ok: false, error: 'Bad timer value' })
  // Whole minutes-of-seconds only: no NaN, no strings, no floats.
  const ms =
    typeof payload.turnTimeoutMs === 'number' && Number.isInteger(payload.turnTimeoutMs)
      ? Math.max(0, Math.min(3_600_000, payload.turnTimeoutMs))
      : null
  if (hasTimer && ms === null) return ack?.({ ok: false, error: 'Bad timer value' })
  // The cap shares the boundary pin with the presets: asInt(0..999),
  // same error copy family as the timer.
  const cap = hasCap ? validRoundsCap(payload.roundsCap) : null
  if (hasCap && cap === null) return ack?.({ ok: false, error: 'Bad rounds value' })
  // The cap is baked into the game at createGame — mid-game it is not
  // a preference anymore, it is a promise the badge keeps.
  if (hasCap && room.state) return ack?.({ ok: false, error: 'The game already started' })
  if (ms !== null) room.turnTimeoutMs = ms
  if (cap !== null) room.roundsCap = cap
  // The in-progress decision re-arms with the new duration.
  room.timerKey = null
  if (room.state) {
    if (ms !== null) {
      godMutate(io, room, `decision timer ${ms === 0 ? 'disabled' : `set to ${Math.round(ms / 1000)}s`}`, () => {})
    } else {
      broadcastGame(io, room)
    }
  } else {
    broadcastLobby(io, room)
    void saveRoom(room)
  }
  ack?.({ ok: true })
}
