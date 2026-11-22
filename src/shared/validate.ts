// ── Boundary validation ──
// The engine is I/O-free by design and trusts the shapes it is handed — so
// this module is the single gate where untrusted client payloads either
// become real `Action`s / `GodCommand`s or get rejected. Every number must
// be a whole number in range; every string is length-capped. Anything else
// is dropped before it can reach the engine or the room state.

import type { Action, GodCommand, TradeSide } from './types.js'

// Cash in this game is dollars; god can mint a lot but not infinity.
const MAX_CASH = 1_000_000_000
// Player and trade ids are uuids (36 chars) minted by the server.
const MAX_ID = 64

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function asStr(x: unknown, max: number): string | null {
  if (typeof x !== 'string' || x.length === 0 || x.length > max) return null
  return x
}

// Whole numbers only — fractional jail cards and 0.5 houses are not a thing.
function asInt(x: unknown, min: number, max: number): number | null {
  if (typeof x !== 'number' || !Number.isInteger(x) || x < min || x > max) return null
  return x
}

function asBool(x: unknown): boolean | null {
  return typeof x === 'boolean' ? x : null
}

function asEnum<T extends string>(x: unknown, values: readonly T[]): T | null {
  return typeof x === 'string' && values.includes(x as T) ? (x as T) : null
}

function asTradeSide(raw: unknown): TradeSide | null {
  if (!isObj(raw)) return null
  const cash = asInt(raw.cash, 0, MAX_CASH)
  const jailCards = asInt(raw.jailCards, 0, 5)
  if (cash === null || jailCards === null) return null
  if (!Array.isArray(raw.spaces) || raw.spaces.length > 40) return null
  const spaces: number[] = []
  for (const sp of raw.spaces) {
    const i = asInt(sp, 0, 39)
    if (i === null) return null
    spaces.push(i)
  }
  return { cash, spaces, jailCards }
}

// An Action the engine can be handed without any further checks.
export function validAction(raw: unknown): Action | null {
  if (!isObj(raw)) return null
  switch (raw.type) {
    case 'roll':
    case 'drawCard':
    case 'goToJail':
    case 'buy':
    case 'declineBuy':
    case 'passBid':
    case 'endTurn':
    case 'payJail':
    case 'useJailCard':
    case 'payDebt':
    case 'bankrupt':
      return { type: raw.type }
    case 'bid': {
      const amount = asInt(raw.amount, 1, MAX_CASH)
      return amount === null ? null : { type: 'bid', amount }
    }
    case 'buyHouse':
    case 'sellHouse':
    case 'mortgage':
    case 'unmortgage': {
      const space = asInt(raw.space, 0, 39)
      return space === null ? null : { type: raw.type, space }
    }
    case 'payTax': {
      const choice = asEnum(raw.choice, ['flat', 'percent'] as const)
      return choice === null ? null : { type: 'payTax', choice }
    }
    case 'proposeTrade': {
      const to = asStr(raw.to, MAX_ID)
      const give = asTradeSide(raw.give)
      const receive = asTradeSide(raw.receive)
      return to && give && receive ? { type: 'proposeTrade', to, give, receive } : null
    }
    case 'respondTrade': {
      const tradeId = asStr(raw.tradeId, MAX_ID)
      const accept = asBool(raw.accept)
      return tradeId === null || accept === null ? null : { type: 'respondTrade', tradeId, accept }
    }
    case 'cancelTrade': {
      const tradeId = asStr(raw.tradeId, MAX_ID)
      return tradeId === null ? null : { type: 'cancelTrade', tradeId }
    }
    default:
      return null
  }
}

// A GodCommand the console handlers can switch on without further checks.
// The god console is TV-only, but the TV is still a browser — validate anyway.
export function validGodCommand(raw: unknown): GodCommand | null {
  if (!isObj(raw)) return null
  switch (raw.cmd) {
    case 'skipTurn':
      return { cmd: 'skipTurn' }
    case 'replayTurn': {
      const playerId = raw.playerId === undefined ? undefined : asStr(raw.playerId, MAX_ID)
      return playerId === null ? null : { cmd: 'replayTurn', playerId }
    }
    case 'setCash': {
      const playerId = asStr(raw.playerId, MAX_ID)
      const amount = asInt(raw.amount, 0, MAX_CASH)
      return playerId && amount !== null ? { cmd: 'setCash', playerId, amount } : null
    }
    case 'setPos': {
      const playerId = asStr(raw.playerId, MAX_ID)
      const pos = asInt(raw.pos, 0, 39)
      const jail = raw.jail === undefined ? undefined : asBool(raw.jail)
      if (playerId === null || pos === null || jail === null) return null
      return { cmd: 'setPos', playerId, pos, jail }
    }
    case 'setJail': {
      const playerId = asStr(raw.playerId, MAX_ID)
      const jail = asBool(raw.jail)
      return playerId === null || jail === null ? null : { cmd: 'setJail', playerId, jail }
    }
    case 'setJailCards': {
      const playerId = asStr(raw.playerId, MAX_ID)
      const count = asInt(raw.count, 0, 5)
      return playerId && count !== null ? { cmd: 'setJailCards', playerId, count } : null
    }
    case 'setProperty': {
      const space = asInt(raw.space, 0, 39)
      if (space === null) return null
      const owner = raw.owner === null ? null : asStr(raw.owner, MAX_ID)
      if (owner === null && raw.owner !== null) return null
      return { cmd: 'setProperty', space, owner }
    }
    case 'setHouses': {
      const space = asInt(raw.space, 0, 39)
      const count = asInt(raw.count, 0, 5)
      return space === null || count === null ? null : { cmd: 'setHouses', space, count }
    }
    case 'setMortgaged': {
      const space = asInt(raw.space, 0, 39)
      const mortgaged = asBool(raw.mortgaged)
      return space === null || mortgaged === null ? null : { cmd: 'setMortgaged', space, mortgaged }
    }
    case 'forceDraw': {
      const deck = asEnum(raw.deck, ['chance', 'chest'] as const)
      return deck === null ? null : { cmd: 'forceDraw', deck }
    }
    case 'setTimer': {
      const ms = asInt(raw.ms, 0, 3_600_000)
      return ms === null ? null : { cmd: 'setTimer', ms }
    }
    case 'endGame': {
      const winner = raw.winner === undefined || raw.winner === null ? null : asStr(raw.winner, MAX_ID)
      if (winner === null && raw.winner !== undefined && raw.winner !== null) return null
      return { cmd: 'endGame', winner }
    }
    case 'kick': {
      const playerId = asStr(raw.playerId, MAX_ID)
      return playerId === null ? null : { cmd: 'kick', playerId }
    }
    case 'export':
      return { cmd: 'export' }
    case 'import':
      return isObj(raw.json) ? { cmd: 'import', json: raw.json } : null
    default:
      return null
  }
}

// Shared inbound-message field checks for the room handlers themselves.
export function validCode(raw: unknown): string | null {
  const c = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
  return /^[A-Z]{4}$/.test(c) ? c : null
}

export function validToken(raw: unknown): string | null {
  return asStr(raw, MAX_ID)
}
