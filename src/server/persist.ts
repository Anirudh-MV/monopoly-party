// ── Room snapshots ──
// Every state change is persisted to disk, so a dev restart never ends the
// party: on boot the rooms come back and phones rejoin via their tokens.
// The same serialization powers the god console's export/import. Validation
// lives here too — a boot restore and a god import get the same treatment:
// every renderable field is checked and normalized BEFORE anything reaches
// a room, a client, or the disk.

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import path from 'node:path'
import { ALL_CARDS } from '../shared/cards.js'
import { TOKENS, stripEmoji } from '../shared/tokens.js'
import { COLORS } from '../shared/colors.js'
import { MAX_GAME_LOG, type PlayerMeta } from '../shared/engine.js'
import { validCode } from '../shared/validate.js'
import type {
  AuctionState,
  DebtState,
  GameState,
  TradeOffer,
  TradeSide,
} from '../shared/types.js'
import {
  DEFAULT_ROUNDS_CAP,
  DEFAULT_TURN_TIMEOUT_MS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  playerTokens,
  rooms,
  type Room,
} from './core.js'

const MAX_LOG = MAX_GAME_LOG // must equal the engine's cap: a god export of any live game has to survive god import

export interface RoomSnapshot {
  v: number
  code: string
  hostToken: string
  hostPlayerId: string | null
  turnTimeoutMs: number
  roundsCap: number
  players: Array<{ meta: PlayerMeta; token: string }>
  state: GameState | null
}

export function serializeRoom(room: Room): RoomSnapshot {
  return {
    v: 1,
    code: room.code,
    hostToken: room.hostToken,
    hostPlayerId: room.hostPlayerId,
    turnTimeoutMs: room.turnTimeoutMs,
    roundsCap: room.roundsCap,
    players: room.players.map((e) => ({ meta: e.meta, token: e.token })),
    state: room.state,
  }
}

let SNAP_DIR = 'snapshots'

// The boot path sets the directory before loading (attach() wires it).
export function setSnapDir(dir: string): void {
  SNAP_DIR = dir
}

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

export function saveRoom(room: Room): void {
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

// Room dissolution (lobby reset) and idle-room cleanup both unlink the
// snapshot file; the reset additionally drops the room from the pending
// save set BEFORE unlinking, or the 250ms coalescing flush resurrects it.
export function forgetRoom(room: Room): void {
  dirtyRooms.delete(room)
  try {
    unlinkSync(path.join(SNAP_DIR, `${room.code}.json`))
  } catch {
    /* already gone */
  }
}

export function unlinkSnapshot(code: string): void {
  try {
    unlinkSync(path.join(SNAP_DIR, `${code}.json`))
  } catch {
    /* already gone */
  }
}

// The boot restore: rooms come back from disk before the first socket
// arrives. Called by attach() right after the snapshot dir is set.
export function loadSnapshots(): void {
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
          roundsCap: DEFAULT_ROUNDS_CAP,
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
// keeps the full 2-seat quorum. Exported for the scenario + remedy suites,
// which pin the optional-field defaults (roundsCap / winners) directly.
export function validateSnapshot(raw: unknown, opts: { minSeats?: number } = {}): RoomSnapshot | null {
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
  // Pre-cap snapshots lack the field entirely: uncapped, the jailCardDecks
  // optional-field precedent.
  const roundsCap = snapInt(d.roundsCap, 0, 999) ?? 0

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
    // The round-cap pair: state-level roundsCap defaults like the room-level
    // one (0 = uncapped), and winners is a shared-win record of seat ids —
    // unknown or non-string entries are dropped (the jailCardDecks filter
    // precedent), an over-long array is capped at the seat count, and an
    // empty result means "none recorded" (undefined).
    const stateRoundsCap = snapInt(st.roundsCap, 0, 999) ?? 0
    let winners: string[] | undefined
    if (Array.isArray(st.winners)) {
      const ids = st.winners.filter((x): x is string => typeof x === 'string' && metas.has(x))
      winners = ids.length > 0 ? ids.slice(0, players.length) : undefined
    }

    // Rebuild the state as the normalized object: known-safe values only.
    // Transient reveal pendings (card draw, jail sentence, pending card)
    // don't survive an import — the room re-schedules its clock on the next
    // broadcast, so the game simply continues from a stable point.
    state = {
      ...(st as unknown as GameState),
      roundsCap: stateRoundsCap,
      winners,
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
    roundsCap,
    players,
    state,
  }
}

// Consumes a snapshot that validateSnapshot already accepted — every field
// is known-safe. Same-room imports keep live sockets attached to seats that
// survive.
export function restoreRoomFromSnapshot(room: Room, snap: RoomSnapshot): boolean {
  const prevConnected = new Map(room.players.map((e) => [e.meta.id, e.socketId]))
  // re-key rejoin tokens to the incoming seats
  for (const [tok, ref] of playerTokens) if (ref.code === room.code) playerTokens.delete(tok)
  room.hostPlayerId = snap.hostPlayerId
  room.turnTimeoutMs = snap.turnTimeoutMs
  room.roundsCap = snap.roundsCap
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
