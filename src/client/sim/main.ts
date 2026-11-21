// ── Simulator page ──
// Automated bots play the real engine, right in the browser: no server, no
// sockets — createGame/applyAction are bundled in. Bots (2–8) are locked in
// when a run starts; the tick speed (10ms–5000ms) and pause/resume are live
// controls. Every setting lives in one menu.

import { applyAction, createGame, type PlayerMeta } from '../../shared/engine.js'
import { botAction, botActor } from '../../shared/bot.js'
import { BOARD, GROUP_COLORS, isStreet } from '../../shared/board.js'
import { gridPos, regionOf, cellHTML } from '../../shared/board-grid.js'
import type { GameState, Space } from '../../shared/types.js'

const NAMES = ['Asha', 'Ben', 'Cho', 'Dara', 'Eli', 'Faye', 'Gus', 'Hana']
const COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#f97316', '#06b6d4', '#ec4899']
const TOKENS = ['🎩', '🚗', '🐕', '🚢', '👞', '🐈', '🛴', '🍀']
const DIE = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅']

const MIN_BOTS = 2
const MAX_BOTS = 8
const MIN_TICK = 10
const MAX_TICK = 5000

const $app = document.getElementById('app') as HTMLElement

let state: GameState | null = null
let botCount = 4
let tickMs = 1000 // the default "choose every 1s" from the spec
let running = true
let menuOpen = false
let steps = 0
let cells: (HTMLElement | null)[] = []
let timer: ReturnType<typeof setTimeout> | null = null

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

// slider 0..100 → 10ms..5000ms on a log scale
function sliderToMs(v: number): number {
  const t = v / 100
  return Math.round(MIN_TICK * Math.pow(MAX_TICK / MIN_TICK, t))
}
function msToSlider(ms: number): number {
  return Math.round((Math.log(ms / MIN_TICK) / Math.log(MAX_TICK / MIN_TICK)) * 100)
}

// ── game lifecycle ──

function newGame(): void {
  const metas: PlayerMeta[] = Array.from({ length: botCount }, (_, i) => ({
    id: `b${i}`,
    name: NAMES[i],
    color: COLORS[i],
    token: TOKENS[i],
  }))
  state = createGame(metas)
  steps = 0
  running = true
  render()
}

function tick(): void {
  if (state && running && state.phase !== 'GAME_OVER') {
    const actor = botActor(state)
    if (actor) {
      const action = botAction(state, actor)
      if (action) {
        applyAction(state, action, actor)
        steps++
      }
    }
    render()
  }
  if (timer) clearTimeout(timer)
  timer = setTimeout(tick, tickMs)
}

// ── rendering ──

function buildBoard(): void {
  const board = document.createElement('div')
  board.className = 'board'
  board.id = 'board'
  cells = []
  for (let i = 0; i < BOARD.length; i++) {
    const cell = document.createElement('div')
    const g = gridPos(i)
    cell.className = `cell r-${regionOf(i)} k-${BOARD[i].kind}`
    cell.style.gridArea = `${g.r} / ${g.c}`
    cell.innerHTML = cellHTML(i, BOARD[i])
    board.appendChild(cell)
    cells[i] = cell
  }
  const center = document.createElement('div')
  center.className = 'center'
  center.id = 'center'
  board.appendChild(center)
  document.getElementById('boardhost')!.replaceChildren(board)
}

function turnQueue(s: GameState) {
  const alive = s.players.filter((p) => !p.bankrupt)
  const idx = alive.findIndex((p) => p.id === s.currentPlayerId)
  return idx < 0 ? alive : [...alive.slice(idx), ...alive.slice(0, idx)]
}

function render(): void {
  const s = state
  if (!s) return

  if (!document.getElementById('board')) buildBoard()

  // cells
  const decisionSpace = s.pendingPurchase ?? s.auction?.space ?? null
  const landedSpace = s.lastLanded && s.lastLanded.playerId === s.currentPlayerId ? s.lastLanded.space : null
  for (let i = 0; i < BOARD.length; i++) {
    const cell = cells[i]
    if (!cell) continue
    const st = s.props[i]
    if (st) {
      const owner = st.owner ? s.players.find((p) => p.id === st.owner) : null
      cell.classList.toggle('owned', !!owner)
      cell.style.setProperty('--own', owner?.color ?? 'transparent')
      const marks = cell.querySelector('.marks')
      if (marks) {
        marks.innerHTML =
          (st.houses > 0
            ? st.houses === 5
              ? '<span class="hotel">🏨</span>'
              : `<span class="hs">${'🏠'.repeat(st.houses)}</span>`
            : '') + (st.mortgaged ? '<span class="mtg">💤</span>' : '')
      }
    }
    const here = s.players.filter((p) => p.pos === i && !p.bankrupt)
    const toks = cell.querySelector('.toks')
    if (toks) {
      toks.innerHTML = here
        .map((p) => `<span class="tk${p.id === s.currentPlayerId ? ' cur' : ''}" style="--c:${p.color}">${p.token}</span>`)
        .join('')
    }
    cell.classList.toggle('active', s.currentPlayerId != null && here.some((p) => p.id === s.currentPlayerId))
    cell.classList.toggle('decision', i === decisionSpace)
    cell.classList.toggle('landed', i === landedSpace)
  }

  // queue overlay
  const q = turnQueue(s)
  const [now, ...rest] = q
  document.getElementById('queue')!.innerHTML = `
    <div class="qhead">SIMULATION · TURN ${s.turn}</div>
    ${now ? `<div class="qnow" style="--c:${now.color}"><span class="qt">${now.token}</span><span class="qn">${esc(now.name)}</span><span class="qc">$${now.cash}</span></div>` : ''}
    ${rest.map((p) => `<div class="qitem" style="--c:${p.color}"><span class="qt">${p.token}</span><span class="qn">${esc(p.name)}</span><span class="qc">$${p.cash}</span></div>`).join('')}`

  // ticker
  const last = s.log[s.log.length - 1]
  document.getElementById('ticker')!.innerHTML = last ? `<span class="t ${last.kind}">${esc(last.text)}</span>` : ''

  // center
  const cur = s.players.find((p) => p.id === s.currentPlayerId)
  const dice = s.dice ? `<div class="dice"><span>${DIE[s.dice[0] - 1]}</span><span>${DIE[s.dice[1] - 1]}</span></div>` : ''
  const centerEl = document.getElementById('center')!
  if (s.phase === 'GAME_OVER') {
    const winner = s.players.find((p) => p.id === s.winner)
    centerEl.innerHTML = winner
      ? `<div class="winner">🏆<div class="wname">${esc(winner.name)}</div><div class="wsub">WINS THE SIMULATION</div></div>`
      : `<div class="winner">💀 everyone is bankrupt</div>`
    centerEl.classList.add('gameover')
  } else if (s.phase === 'AUCTION' && s.auction) {
    const bidder = s.players.find((p) => p.id === s.auction?.bidder)
    centerEl.classList.remove('gameover')
    centerEl.innerHTML = `
      <div class="auction">
        <div class="a-title">🔨 AUCTION</div>
        <div class="a-prop">${esc(BOARD[s.auction.space].name)}</div>
        <div class="a-bid">$${s.auction.bid}</div>
        <div class="a-bidder">${s.auction.bidder ? `high bidder: ${bidder?.token} ${esc(bidder?.name ?? '')}` : 'no bids yet'}</div>
      </div>`
  } else {
    centerEl.classList.remove('gameover')
    centerEl.innerHTML = `
      ${cur ? `<div class="turn">${cur.token} <b>${esc(cur.name)}</b>'s turn</div>` : ''}
      ${dice}
      ${s.debt ? `<div class="banner debt">⚠ ${esc(s.players.find((p) => p.id === s.debt?.debtor)?.name ?? '')} owes $${s.debt.amount}</div>` : ''}`
  }

  // top bar
  document.getElementById('stats')!.textContent =
    `${running ? '▶ running' : '⏸ paused'} · ${tickMs}ms/tick · turn ${s.turn} · ${steps} actions · ${s.phase.toLowerCase()}`
  document.getElementById('pauseBtn')!.textContent = running ? '⏸' : '▶'

  // settings sheet values (menu only)
  if (menuOpen) {
    const botsVal = document.getElementById('botsVal') as HTMLElement | null
    if (botsVal) botsVal.textContent = String(botCount)
    const speedVal = document.getElementById('speedVal') as HTMLElement | null
    if (speedVal) speedVal.textContent = `${tickMs}ms`
  }
}

function renderShell(): void {
  $app.innerHTML = `
    <div class="game">
      <div class="boardwrap" id="boardhost"></div>
      <div class="overlay queue" id="queue"></div>
      <div class="overlay ticker" id="ticker"></div>
      <div class="simtop">
        <span class="stat" id="stats"></span>
        <button id="pauseBtn" title="pause/resume">⏸</button>
        <button id="menuBtn" title="simulation settings">⚙</button>
      </div>
      ${menuOpen ? renderMenu() : ''}
    </div>`
}

function renderMenu(): string {
  return `
    <div class="simmenu" id="simmenu">
      <div class="sheet">
        <h2>⚙ Simulation settings</h2>
        <label>Bots — set for this run (changing restarts)</label>
        <div class="row">
          <button id="botsMinus">−</button>
          <span class="val" id="botsVal">${botCount}</span>
          <button id="botsPlus">+</button>
        </div>
        <label>Decision interval — ${tickMs}ms <span id="speedVal"></span></label>
        <input id="speed" type="range" min="0" max="100" step="1" value="${msToSlider(tickMs)}" />
        <div class="row">
          <button class="big" id="closeMenu">Resume view</button>
        </div>
        <div class="row">
          <button class="big" id="restart">↺ Restart simulation</button>
        </div>
        <p class="hint">Bots: ${MIN_BOTS}–${MAX_BOTS}, fixed when the run starts · interval: ${MIN_TICK}ms–${MAX_TICK}ms, applies live · ⏸ pauses without losing the game.</p>
      </div>
    </div>`
}

// ── wiring ──

$app.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest('button') as HTMLElement | null
  if (!el) return
  switch (el.id) {
    case 'menuBtn':
      menuOpen = true
      renderShell()
      render()
      break
    case 'closeMenu':
      menuOpen = false
      renderShell()
      render()
      break
    case 'pauseBtn':
      running = !running
      render()
      break
    case 'restart':
      menuOpen = false
      renderShell()
      newGame()
      break
    case 'botsMinus':
      if (botCount > MIN_BOTS) botCount--
      newGame() // bot count is fixed at run start — restart applies it
      break
    case 'botsPlus':
      if (botCount < MAX_BOTS) botCount++
      newGame()
      break
  }
})

$app.addEventListener('input', (ev) => {
  const el = ev.target as HTMLInputElement
  if (el.id === 'speed') {
    tickMs = sliderToMs(Number(el.value))
    const speedVal = document.getElementById('speedVal') as HTMLElement | null
    if (speedVal) speedVal.textContent = `${tickMs}ms`
    const stat = document.getElementById('stats')
    if (stat) stat.textContent = `${running ? '▶ running' : '⏸ paused'} · ${tickMs}ms/tick · turn ${state?.turn ?? 0} · ${steps} actions · ${state?.phase.toLowerCase() ?? ''}`
  }
})

renderShell()
newGame()
tick()
