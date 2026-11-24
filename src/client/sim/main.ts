// ── Simulator page ──
// Automated bots play the real engine, right in the browser: no server, no
// sockets — createGame/applyAction are bundled in. Bots (2–8) are locked in
// when a run starts; the tick speed (10ms–5000ms) and pause/resume are live
// controls. Every setting lives in one menu.

import { applyAction, createGame, type PlayerMeta } from '../../shared/engine.js'
import { allowedActions } from '../../shared/rules.js'
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

// ── phone views ──
// One card per bot, mirroring what that player's phone would show: the
// status banner and the exact action buttons the real controller offers
// (same allowedActions gate the server enforces). Display-only — the bots
// play themselves; this is for watching what each player sees.

function phoneCard(s: GameState, pid: string): string {
  const p = s.players.find((q) => q.id === pid)
  if (!p) return ''
  const acts = new Set(allowedActions(s, pid))
  const cur = s.currentPlayerId === pid
  const curName = s.players.find((q) => q.id === s.currentPlayerId)?.name ?? ''

  let banner = ''
  const btns: string[] = []
  const chip = (on: boolean, label: string): string => (on ? `<span class="pbtn on">${label}</span>` : `<span class="pbtn">${label}</span>`)

  if (s.phase === 'GAME_OVER') {
    banner = s.winner === pid ? '🏆 You win!' : p.bankrupt ? '💀 Bankrupt — spectating' : 'Game over'
  } else if (p.bankrupt) {
    banner = '💀 Bankrupt — spectating'
  } else if (s.debt && s.debt.debtor === pid) {
    const cred = s.debt.creditor ? s.players.find((q) => q.id === s.debt?.creditor)?.name : 'the bank'
    banner = `You owe $${s.debt.amount} to ${esc(cred ?? 'the bank')}${s.debt.memo?.startsWith('Rent: ') ? ` — rent for ${esc(s.debt.memo.slice(6))}` : ''}`
    btns.push(chip(acts.has('payDebt'), `Pay $${s.debt.amount}`))
    btns.push(chip(acts.has('bankrupt'), 'Bankrupt'))
  } else if (s.debt) {
    const debtor = s.players.find((q) => q.id === s.debt?.debtor)
    banner = `${esc(debtor?.name ?? '')} is raising funds to pay a debt…`
  } else if (s.phase === 'AUCTION' && s.auction) {
    const highBidder = s.auction.bidder ? s.players.find((q) => q.id === s.auction?.bidder)?.name : null
    banner = `Auction: ${esc(BOARD[s.auction.space].name)} — $${s.auction.bid}${highBidder ? ` (${esc(highBidder)})` : ' — no bids yet'}`
    if (acts.has('bid')) btns.push(chip(true, `Bid $${s.auction.bid + 1}`))
    if (acts.has('passBid')) btns.push(chip(true, 'Pass'))
  } else if (s.pendingJail && s.pendingJail.player === pid) {
    banner = `You're under arrest — ${s.pendingJail.reason === 'space' ? 'you landed on Go To Jail' : s.pendingJail.reason === 'card' ? 'the card says so' : 'three doubles!'}`
    if (acts.has('goToJail')) btns.push(chip(true, 'Go to jail'))
  } else if (s.pendingCardDraw && s.pendingCardDraw.player === pid) {
    const chest = s.pendingCardDraw.deck === 'chest'
    banner = chest ? 'You landed on Community Chest' : 'You landed on Chance'
    if (acts.has('drawCard')) btns.push(chip(true, chest ? 'Open the chest' : 'Spin the wheel'))
  } else if (s.pendingPurchase != null && cur) {
    const sp = BOARD[s.pendingPurchase]
    const price = 'price' in sp ? sp.price : 0
    banner = `You landed on ${esc(sp.name)}${price ? ` — $${price}` : ''}`
    if (acts.has('buy')) btns.push(chip(true, `Buy $${price}`))
    if (acts.has('declineBuy')) btns.push(chip(true, 'Decline'))
  } else if (s.pendingTax && cur) {
    banner = 'Income tax — flat or 10%?'
    if (acts.has('payTax')) {
      btns.push(chip(true, '$200 flat'))
      btns.push(chip(true, '10% of worth'))
    }
  } else if (s.phase === 'ROLL' && cur) {
    banner = `Your turn${p.jail ? ` — in jail, attempt ${p.jailRolls}/3` : ''}`
    if (acts.has('roll')) btns.push(chip(true, 'Roll the dice'))
    if (acts.has('payJail')) btns.push(chip(true, 'Pay $50 fine'))
    if (acts.has('useJailCard')) btns.push(chip(true, 'Use jail card'))
  } else if (s.phase === 'ACTION' && cur) {
    banner = 'You rolled — build or trade before ending'
    if (acts.has('endTurn')) btns.push(chip(true, 'End turn'))
  } else {
    banner = `${esc(curName)}'s turn — you can build, mortgage, and trade`
  }

  const incoming = s.trades.filter((t) => t.to === pid).length
  if (incoming > 0 && !p.bankrupt && s.phase !== 'GAME_OVER') {
    btns.push(chip(acts.has('respondTrade'), `${incoming} offer${incoming > 1 ? 's' : ''} waiting`))
  }

  const status =
    p.bankrupt ? 'dead' : s.phase === 'GAME_OVER' ? 'over' : cur ? 'active' : 'idle'
  return `
    <div class="phone st-${status}" style="--c:${p.color}">
      <div class="ph-top"><span class="ph-tok">${p.token}</span><span class="ph-name">${esc(p.name)}</span><span class="ph-cash">$${p.cash}</span></div>
      ${p.jail && !p.bankrupt && s.phase !== 'GAME_OVER' ? '<div class="ph-note">🚔 in jail</div>' : ''}
      <div class="ph-banner">${banner}</div>
      ${btns.length > 0 ? `<div class="ph-btns">${btns.join('')}</div>` : ''}
    </div>`
}

function renderPhones(s: GameState): void {
  const el = document.getElementById('phones')
  if (el) el.innerHTML = s.players.map((p) => phoneCard(s, p.id)).join('')
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

  // phone views — every player's controller, side by side
  renderPhones(s)

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
      <div class="phones" id="phones"></div>
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
