// ── Engine fuzz-test ──
// Plays whole games with the shared bot brain (shared/bot.ts) to prove the
// rules engine never throws, never deadlocks, and always terminates.
// Run: npm run simulate

import { createGame, applyAction, type PlayerMeta } from '../shared/engine.js'
import { alivePlayers, netWorth } from '../shared/rules.js'
import { botAction, botActor } from '../shared/bot.js'
import { createHash } from 'node:crypto'
import type { GameState } from '../shared/types.js'

const METAS: PlayerMeta[] = [
  { id: 'p0', name: 'Asha', color: '#ef4444', token: '🎩' },
  { id: 'p1', name: 'Ben', color: '#3b82f6', token: '🚗' },
  { id: 'p2', name: 'Cho', color: '#22c55e', token: '🐕' },
  { id: 'p3', name: 'Dara', color: '#eab308', token: '🚢' },
  { id: 'p4', name: 'Evan', color: '#a855f7', token: '👞' },
  { id: 'p5', name: 'Fern', color: '#f43f5e', token: '🐈' },
  { id: 'p6', name: 'Gus', color: '#14b8a6', token: '🛴' },
  { id: 'p7', name: 'Hana', color: '#f97316', token: '🦆' },
]

// Deterministic replays: SEED=12345 npm run simulate reproduces a run
// exactly — dice, decks, bots, everything.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SEED = Number(process.env.SEED ?? 0)
const rng: () => number = SEED > 0 ? mulberry32(SEED) : Math.random

function checkInvariants(s: GameState, step: number): void {
  for (const p of s.players) {
    if (!Number.isFinite(p.cash) || !Number.isInteger(p.cash)) {
      throw new Error(`step ${step}: ${p.name} cash is ${p.cash}`)
    }
    if (p.cash < 0) throw new Error(`step ${step}: ${p.name} has negative cash ${p.cash}`)
    if (p.pos < 0 || p.pos > 39) throw new Error(`step ${step}: ${p.name} position ${p.pos}`)
  }
  for (const st of Object.values(s.props)) {
    if (st.houses < 0 || st.houses > 5) throw new Error(`step ${step}: houses ${st.houses}`)
  }
}

// ── Play games ──
const GAMES = Number(process.env.GAMES ?? 25)
const MAX_TURNS = 600

// ── Environment knobs (the panel sweep) ──
// PLAYERS: seat count 2..8 (default 4). TRADES=0 drops trade proposals
// entirely (the no-trade cell). ROUNDS_CAP bakes a worth-victory cap into
// every game (0 = uncapped, the standing regression).
const PLAYERS = Math.max(2, Math.min(8, Math.floor(Number(process.env.PLAYERS ?? 4)) || 4))
const TRADES = (process.env.TRADES ?? '1') !== '0'
const ROUNDS_CAP = Math.max(0, Math.min(999, Math.floor(Number(process.env.ROUNDS_CAP ?? 0)) || 0))

let completed = 0
let timeouts = 0
let totalSteps = 0
const turnCounts: number[] = []
// A running digest of every applied action — with the rng fully threaded,
// two runs on the same SEED must print the same hash (deck rebuilds and
// bankruptcy resumes included). This is the determinism contract.
let transcript = ''

for (let g = 0; g < GAMES; g++) {
  const s = createGame(METAS.slice(0, PLAYERS), rng, ROUNDS_CAP)
  let steps = 0
  while (s.phase !== 'GAME_OVER' && s.turn < MAX_TURNS && steps < 200_000) {
    steps++
    const actor = botActor(s, rng)
    if (actor == null) {
      console.error(`DEADLOCK at turn ${s.turn}, phase ${s.phase}`)
      console.dir(s, { depth: 3 })
      process.exit(1)
    }
    const action = botAction(s, actor, rng)
    if (action) {
      // TRADES=0: the no-trade cell — proposals never reach the table
      if (!TRADES && action.type === 'proposeTrade') continue
      const res = applyAction(s, action, actor, rng)
      transcript += `${g}:${actor}|${JSON.stringify(action)}|${res.ok ? 1 : 0};`
      // Bot payloads can be invalid (that's fine — a party guest clicking
      // nonsense is normal life). What must never happen: an exception.
      if (!res.ok && action.type !== 'proposeTrade' && action.type !== 'respondTrade') {
        console.error(`UNEXPECTED REJECTION at step ${steps}: ${actor} → ${JSON.stringify(action)}: ${res.error}`)
        console.dir(s, { depth: 2 })
        process.exit(1)
      }
      checkInvariants(s, steps)
    }
  }
  totalSteps += steps
  turnCounts.push(s.turn)
  if (s.phase === 'GAME_OVER') completed++
  else timeouts++

  const winners = s.winners ?? (s.winner ? [s.winner] : [])
  const winnerNames = winners.map((id) => s.players.find((p) => p.id === id)?.name ?? '?')
  const kind = s.phase === 'GAME_OVER' ? 'finished' : 'timeout'
  const byCap = s.phase === 'GAME_OVER' && s.roundsCap > 0 && winners.length > 0 && s.turn >= s.roundsCap * s.players.length
  console.log(
    `game ${g + 1}: ${kind} after ${s.turn} turns / ${steps} steps — ` +
      (winnerNames.length > 0 ? `winner ${winnerNames.join(' & ')}` : 'no winner') +
      (byCap ? ' (cap boundary)' : '') +
      ` | standings: ${s.players.map((p) => `${p.name}${p.bankrupt ? '💀' : ''}:$${netWorth(s, p.id)}`).join('  ')}`,
  )
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0
  const a = [...xs].sort((x, y) => x - y)
  const mid = Math.floor(a.length / 2)
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2)
}

console.log('')
console.log(`✔ ${GAMES} games: ${completed} finished, ${timeouts} hit the ${MAX_TURNS}-turn cap, ${totalSteps} total actions, ~${Math.round(totalSteps / GAMES)} actions/game`)
console.log(`cells: PLAYERS=${PLAYERS} · TRADES=${TRADES ? 'on' : 'off'} · ROUNDS_CAP=${ROUNDS_CAP === 0 ? 'uncapped' : ROUNDS_CAP}`)
console.log(`end-rate: ${Math.round((completed / GAMES) * 100)}% · median turns: ${median(turnCounts)}`)
console.log(SEED > 0 ? `seed: ${SEED} (replay with SEED=${SEED})` : 'seed: random (set SEED=n for reproducible runs)')
console.log(`transcript: ${createHash('sha256').update(transcript).digest('hex').slice(0, 16)}`)
console.log('Engine survived: no exceptions, no deadlocks, invariants held.')
