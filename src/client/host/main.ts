// ── TV / host screen ──
// A WebGL board (board3d.ts) fills the screen; slim HTML overlays carry the
// turn queue, ticker, 3D dice, and the center spotlight. Cards are a two-step
// affair: the TV prompts ("open it on the phone"), then plays the chest/wheel
// reveal when the drawer acts. Light theme by default, dark via the toggle.
// Read-only by design — the game's authoritative state lives on the server.

import { io } from 'socket.io-client'
import QRCode from 'qrcode'
import { BOARD, GROUP_COLORS, isStreet } from '../../shared/board.js'
import { rentFor } from '../../shared/rules.js'
import type { HostView, LobbyInfo, PlayerState, Space } from '../../shared/types.js'
import { Board3D } from './board3d.js'

interface HostAck {
  ok: boolean
  code?: string
  hostToken?: string
  urls?: string[]
  error?: string
}

const $app = document.getElementById('app') as HTMLElement

// ── theme ──
type Theme = 'light' | 'dark'
let theme: Theme = (localStorage.getItem('mp-theme') as Theme | null) ?? 'light'
function applyTheme(t: Theme): void {
  theme = t
  localStorage.setItem('mp-theme', t)
  document.documentElement.dataset.theme = t
  board3d.setTheme(t)
}
document.documentElement.dataset.theme = theme

const board3d = new Board3D(document.body)
board3d.setTheme(theme)

// persistent theme toggle, outside #app so re-renders never destroy it
const themeBtn = document.createElement('button')
themeBtn.className = 'themetoggle'
themeBtn.style.position = 'fixed'
themeBtn.textContent = theme === 'light' ? 'Dark' : 'Light'
themeBtn.addEventListener('click', () => {
  applyTheme(theme === 'light' ? 'dark' : 'light')
  themeBtn.textContent = theme === 'light' ? 'Dark' : 'Light'
})
document.body.appendChild(themeBtn)

// god console toggle — the operator's emergency exit for mid-game trouble
const godBtn = document.createElement('button')
godBtn.className = 'themetoggle godtoggle'
godBtn.style.position = 'fixed'
godBtn.style.top = '9vh'
godBtn.textContent = 'God'
godBtn.addEventListener('click', () => {
  godOpen = !godOpen
  render()
})
document.body.appendChild(godBtn)

function sendGod(payload: Record<string, unknown>, onResult?: (res: Record<string, unknown>) => void): void {
  socket.emit('god:command', payload, (res: { ok: boolean; error?: string; snapshot?: unknown }) => {
    if (!res.ok) {
      godStatus = res.error ?? 'Command failed'
      render()
    }
    onResult?.(res as Record<string, unknown>)
  })
}

const socket = io()
let view: HostView | null = null
let lobby: LobbyInfo | null = null
let urls: string[] = []
let gameBuilt = false

// animation bookkeeping
let lastDiceKey = ''
let lastCardSeq = 0
let revealUntil = 0

// god console
let godOpen = false
let godPropSpace: number | null = null
let godStatus = ''

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

// Reconnect the TV whenever the socket (re)connects — survives refreshes,
// laptop sleeps, and Wi-Fi blips without losing the room.
socket.on('connect', () => {
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith('mp-host-')) continue
    const code = k.slice('mp-host-'.length)
    const hostToken = localStorage.getItem(k) ?? ''
    socket.emit('room:hostJoin', { code, hostToken }, (res: HostAck) => {
      if (!res.ok) localStorage.removeItem(k)
      else urls = res.urls ?? urls
      render()
    })
  }
})

socket.on('lobby', (l: LobbyInfo) => {
  lobby = l
  view = null
  gameBuilt = false
  render()
})

socket.on('view', (v: HostView) => {
  view = v
  lobby = null
  render()
})

$app.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null
  if (!el) return
  if (el.dataset.act === 'create') {
    socket.emit('room:create', (res: HostAck) => {
      if (!res.ok || !res.code || !res.hostToken) return
      localStorage.setItem(`mp-host-${res.code}`, res.hostToken)
      urls = res.urls ?? []
    })
  } else if (el.dataset.act === 'start') {
    socket.emit('game:start', {}, (res: { ok: boolean; error?: string }) => {
      if (!res.ok) console.warn('start failed:', res.error)
    })
  } else if (el.dataset.act === 'setTimer') {
    const ms = Number(JSON.parse(el.dataset.args ?? '{}').ms ?? 300000)
    socket.emit('room:settings', { turnTimeoutMs: ms }, (res: { ok: boolean; error?: string }) => {
      if (!res.ok) console.warn('timer change failed:', res.error)
    })
  }
})

// ── Render dispatch ──

function render(): void {
  if (view) {
    renderGame(view)
    return
  }
  board3d.setIdle()
  if (lobby) {
    renderLobby(lobby)
    return
  }
  $app.innerHTML = `
    <div class="landing">
      <div class="logo">🎲</div>
      <h1>MONOPOLY PARTY</h1>
      <p class="tag">The couch co-op edition — your phone is your wallet.</p>
      <button class="big" data-act="create">Create a game</button>
      <p class="hint">Open this screen on the TV. Keep it running — it's the shared board.</p>
    </div>`
}

// ── Lobby ──

function renderLobby(l: LobbyInfo): void {
  const players = l.players
    .map(
      (p) =>
        `<li${p.id === l.hostId ? ' class="crowned"' : ''}><span class="dot" style="background:${p.color}"></span><span class="ptoken">${p.token}</span> ${esc(p.name)}${p.id === l.hostId ? ' <span class="crown">Host</span>' : ''}${p.connected ? '' : '<em class="off">offline</em>'}</li>`,
    )
    .join('')
  $app.innerHTML = `
    <div class="lobby">
      <h1>MONOPOLY PARTY</h1>
      <div class="roomcard">
        <div class="code-label">ROOM CODE</div>
        <div class="code">${l.code}</div>
        <canvas id="qr" width="260" height="260"></canvas>
        <div class="url">${esc(urls[0] ?? 'http://(this computer\u2019s LAN IP):3000/join')}</div>
        <p class="hint">Scan the QR — or type the URL and code on any phone</p>
      </div>
      <div class="joined">
        <h2>PLAYERS · ${l.players.length}</h2>
        <ul class="playerlist">${players}</ul>
        <button class="big ${l.canStart ? '' : 'disabled'}" data-act="start">Start the game</button>
        ${l.canStart ? '' : '<p class="hint">Best with 3+ players — waiting…</p>'}
        <label style="margin-top:2vh">Decision timer</label>
        <div class="chips">${TIMERS.map(
          ([label, ms]) => `<button class="chip ${l.turnTimeoutMs === ms ? 'sel' : ''}" data-act="setTimer" data-args='{"ms":${ms}}'>${label}</button>`,
        ).join('')}</div>
      </div>
    </div>`
  const canvas = document.getElementById('qr') as HTMLCanvasElement | null
  if (canvas && urls[0]) {
    QRCode.toCanvas(canvas, urls[0], { width: 260, margin: 1 }).catch(() => {})
  }
}

// ── Game ──

function turnQueue(v: HostView): PlayerState[] {
  const alive = v.players.filter((p) => !p.bankrupt)
  const idx = alive.findIndex((p) => p.id === v.currentPlayerId)
  if (idx < 0) return alive
  return [...alive.slice(idx), ...alive.slice(0, idx)]
}

function renderGame(v: HostView): void {
  if (!gameBuilt) {
    $app.innerHTML = `
      <div class="game">
        <div class="overlay queue" id="queue"></div>
        <div class="overlay topbar" id="topbar"></div>
        <div class="overlay ticker" id="ticker"></div>
        <div class="dicebox" id="dicebox"></div>
        <div class="center3d" id="center"></div>
        ${godOpen ? '<div class="godpanel" id="godpanel"></div>' : ''}
      </div>`
    gameBuilt = true
  } else {
    const panel = document.getElementById('godpanel')
    if (godOpen && !panel) {
      $app.querySelector('.game')?.insertAdjacentHTML('beforeend', '<div class="godpanel" id="godpanel"></div>')
    } else if (!godOpen && panel) {
      panel.remove()
    }
  }

  // fresh card draw? play the reveal for the next few seconds — the wheel
  // finishes, the card is read, THEN the prompt clears and the piece moves
  const freshCard = v.pendingCard
  const freshReveal = v.cardDrawSeq > lastCardSeq && !!freshCard
  if (freshReveal) {
    const isChest = freshCard.deck === 'chest'
    const hold = isChest ? 2700 : 3300
    revealUntil = Date.now() + hold
    // the reveal branch only yields if something re-renders after the window
    // — and between player actions nothing else will, so schedule it
    setTimeout(() => render(), hold + 100)
  }
  lastCardSeq = v.cardDrawSeq

  // the piece waits for the full reveal before doing its thing:
  // spin (2.1s) → card readable (~2.4s) → prompt clears → stroll begins
  if (freshReveal) board3d.delayHops(freshCard.deck === 'chest' ? 3000 : 3600)
  else if (v.dice && `${v.turn}:${v.dice.join()}` !== lastDiceKey) board3d.delayHops(1150)

  board3d.sync(v)
  updateDice(v)
  updateQueue(v)
  updateTopbar(v)
  updateTicker(v)
  updateCenter(v)
  if (godOpen) updateGodPanel(v)
}

// The dice live in their OWN container, untouched by the center overlay's
// frequent innerHTML rebuilds — so the tumble never restarts mid-animation.
function updateDice(v: HostView): void {
  const el = document.getElementById('dicebox')
  if (!el) return
  if (!v.dice) {
    if (el.innerHTML !== '') {
      el.innerHTML = ''
      lastDiceKey = ''
    }
    return
  }
  const key = `${v.turn}:${v.dice.join()}`
  if (key === lastDiceKey) return // never touch mid-animation
  lastDiceKey = key
  el.innerHTML = `
    <div class="diceroll" aria-hidden="true">${dieHTML(v.dice[0], 0)}${dieHTML(v.dice[1], 0)}</div>
    <div class="roll-label">${v.dice[0]} + ${v.dice[1]} = ${v.dice[0] + v.dice[1]}</div>`
  kickDiceAnimation()
}

// Compact turn strip, top-center — out of the 3D action's way.
function updateTopbar(v: HostView): void {
  const el = document.getElementById('topbar')
  if (!el) return
  const cur = v.players.find((p) => p.id === v.currentPlayerId)
  if (v.phase === 'GAME_OVER') {
    el.innerHTML = ''
    return
  }
  const captions: string[] = []
  if (v.pendingJail) captions.push(`${v.players.find((p) => p.id === v.pendingJail?.player)?.name ?? ''} is being arrested`)
  if (v.pendingPurchase != null) captions.push(`Buy or auction ${BOARD[v.pendingPurchase].name}?`)
  if (v.pendingTax) captions.push('Choosing how to pay Income Tax…')
  if (v.trades.length > 0) captions.push(`${v.trades.length} trade offer${v.trades.length > 1 ? 's' : ''} on the table`)
  if (v.phase === 'ROLL') captions.push(cur && cur.jail ? 'Roll from jail on your phone' : 'Roll on your phone')
  el.innerHTML = `
    ${cur ? `<div class="tb-turn">${cur.token} <b>${esc(cur.name)}</b>'s turn${cur.jail ? ' · in jail' : ''}</div>` : ''}
    <div class="tb-caps">${captions.map((c) => `<span class="tb-cap">${c}</span>`).join('')}</div>`
}

// Compact landed spotlight — lives in the queue column so the screen center
// belongs to the 3D action.
function landedCompact(v: HostView): string {
  if (!v.lastLanded || v.lastLanded.playerId !== v.currentPlayerId) return ''
  const i = v.lastLanded.space
  const sp = BOARD[i]
  const st = v.props[i]
  let info = ''
  if ('price' in sp && st) {
    const owner = st.owner ? v.players.find((p) => p.id === st.owner) : null
    if (owner) {
      const badges =
        (st.mortgaged ? ' · mortgaged' : '') +
        (st.houses > 0 ? ` · ${st.houses === 5 ? 'hotel' : `${st.houses} house${st.houses > 1 ? 's' : ''}`}` : '')
      info = `${owner.token} ${esc(owner.name)}${badges}`
      if (owner.id !== v.currentPlayerId) {
        const diceSum = v.dice ? v.dice[0] + v.dice[1] : 7
        info += ` — rent $${rentFor(v, i, diceSum)}`
      }
    } else {
      info = v.pendingPurchase === i ? 'unowned — buy or auction' : 'unowned'
    }
  } else if (sp.kind === 'chance' || sp.kind === 'chest') {
    info = 'card space'
  } else if (sp.kind === 'tax') {
    info = sp.percent ? 'pay $200 or 10% of worth' : `pay $${sp.flat}`
  } else if (sp.kind === 'go') {
    info = 'collect $200'
  } else if (sp.kind === 'jail') {
    info = 'just visiting'
  }
  return `<div class="qlanded">
    <div class="ql-head">LANDED</div>
    <div class="ql-name" style="border-left: 4px solid ${stripColor(sp)}; padding-left: 6px;">${esc(sp.name)}${'price' in sp ? ` · $${sp.price}` : ''}</div>
    <div class="ql-info">${info}</div>
  </div>`
}

function updateQueue(v: HostView): void {
  const el = document.getElementById('queue')
  if (!el) return
  const q = turnQueue(v)
  const [now, ...rest] = q
  if (!now) {
    el.innerHTML = ''
    return
  }
  const crown = (p: PlayerState): string => (p.id === v.hostId ? ' <span class="crown">Host</span>' : '')
  const jailBadge = (p: PlayerState): string => (p.jail ? ' <span class="jailbadge">in jail</span>' : '')
  el.innerHTML = `
    <div class="qhead">ROOM ${esc(v.code)} · TURN ${v.turn}</div>
    <div class="qnow" style="--c:${now.color}">
      <span class="qt">${now.token}</span>
      <span class="qn">${esc(now.name)}${crown(now)}${jailBadge(now)}</span>
      <span class="qc">$${now.cash}</span>
    </div>
    ${rest
      .map(
        (p) => `
    <div class="qitem" style="--c:${p.color}">
      <span class="qt">${p.token}</span>
      <span class="qn">${esc(p.name)}${crown(p)}${jailBadge(p)}${!p.connected ? '<em class="off">off</em>' : ''}</span>
      <span class="qc">$${p.cash}</span>
    </div>`,
      )
      .join('')}
    ${landedCompact(v)}`
}

function updateTicker(v: HostView): void {
  const el = document.getElementById('ticker')
  if (!el) return
  // While a drawn card is in play, the bottom bar carries the whole story:
  // "Chance said: …" plus the landed property, price, and its group colour.
  if (v.pendingCard) {
    const isChest = v.pendingCard.deck === 'chest'
    let propHTML = ''
    if (v.lastLanded && v.lastLanded.playerId === v.currentPlayerId) {
      const sp = BOARD[v.lastLanded.space]
      const col = stripColor(sp)
      propHTML = `<span class="tk-prop" style="--c:${col}"><i class="tk-swatch"></i>${esc(sp.name)}${'price' in sp ? ` · $${sp.price}` : ''}</span>`
    }
    el.innerHTML = `<span class="t">${isChest ? 'Community Chest' : 'Chance'} said: ${esc(v.pendingCard.text)}</span>${propHTML}`
    return
  }
  const last = v.log[v.log.length - 1]
  el.innerHTML = last ? `<span class="t ${last.kind}">${esc(last.text)}</span>` : ''
}

function stripColor(sp: Space): string {
  if (isStreet(sp)) return GROUP_COLORS[sp.group]
  if (sp.kind === 'rail') return '#4b5563'
  if (sp.kind === 'utility') return '#6b7280'
  if (sp.kind === 'chance') return '#c2410c'
  if (sp.kind === 'chest') return '#0e7490'
  return '#64748b'
}

// Spotlight: what the active piece just landed on, with price and rent.
function landedCard(v: HostView): string {
  if (!v.lastLanded || v.lastLanded.playerId !== v.currentPlayerId) return ''
  const i = v.lastLanded.space
  const sp = BOARD[i]
  const st = v.props[i]
  const mover = v.players.find((p) => p.id === v.lastLanded?.playerId)
  let info = ''
  let rentLine = ''
  if ('price' in sp && st) {
    const owner = st.owner ? v.players.find((p) => p.id === st.owner) : null
    const badges =
      (st.mortgaged ? ' · mortgaged' : '') +
      (st.houses > 0 ? ` · ${st.houses === 5 ? 'hotel' : `${st.houses} house${st.houses > 1 ? 's' : ''}`}` : '')
    if (owner) {
      info = `<div class="l-owner" style="--c:${owner.color}">${owner.token} ${esc(owner.name)}${badges}</div>`
      if (owner.id !== v.currentPlayerId) {
        const diceSum = v.dice ? v.dice[0] + v.dice[1] : 7
        rentLine = `<div class="l-rent">Rent due: $${rentFor(v, i, diceSum)}</div>`
      } else {
        rentLine = `<div class="l-rent">Your property — no rent</div>`
      }
    } else {
      info = `<div class="l-owner unown">${v.pendingPurchase === i ? 'Unowned — buy or auction?' : 'unowned'}</div>`
      rentLine = `<div class="l-rent">Price: $${'price' in sp ? sp.price : ''}</div>`
    }
  } else if (sp.kind === 'chance') {
    info = `<div class="l-owner unown">card space</div>`
  } else if (sp.kind === 'chest') {
    info = `<div class="l-owner unown">card space</div>`
  } else if (sp.kind === 'tax') {
    info = `<div class="l-owner unown">${sp.percent ? 'pay $200 or 10% of worth' : `pay $${sp.flat}`}</div>`
  }
  return `
    <div class="landed">
      <div class="l-strip" style="background:${stripColor(sp)}"></div>
      <div class="l-name">${mover ? `${mover.token} ` : ''}${esc(sp.name)}${'price' in sp ? ` <span class="l-price">$${sp.price}</span>` : ''}</div>
      ${rentLine}
      ${info}
    </div>`
}

// ── 3D dice cubes ──

const FACE_END: Record<number, [number, number]> = {
  // value → final rotateX/rotateY (full turns + the face's orientation)
  1: [720, 1080],
  2: [720, 990],
  3: [630, 1080],
  4: [810, 1080],
  5: [720, 1170],
  6: [720, 1260],
}

function dieHTML(value: number, tilt: number): string {
  let faces = ''
  for (let f = 1; f <= 6; f++) {
    const pips: Record<number, string> = {
      1: 'c',
      2: 'n s',
      3: 'n c s',
      4: 'n e w s',
      5: 'n e c w s',
      6: 'n m w e x s',
    }
    const pipSpans = pips[f]
      .split(' ')
      .map((cls) => `<span class="pip ${cls}"></span>`)
      .join('')
    faces += `<div class="f f${f} pips-${f}">${pipSpans}</div>`
  }
  const [rx, ry] = FACE_END[value] ?? FACE_END[1]
  return `<div class="die" data-final="rotateX(${rx}deg) rotateY(${ry}deg)" style="transform:rotateX(0deg) rotateY(0deg) translateX(${tilt}vh)">${faces}</div>`
}

function kickDiceAnimation(): void {
  document.querySelectorAll('.die').forEach((d) => {
    const final = (d as HTMLElement).dataset.final
    if (!final) return
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        ;(d as HTMLElement).style.transform = final
      }),
    )
  })
}

// ── center overlay ──

function updateCenter(v: HostView): void {
  const el = document.getElementById('center')
  if (!el) return

  if (v.phase === 'GAME_OVER' || v.winner) {
    const winner = v.players.find((p) => p.id === v.winner)
    el.innerHTML = winner
      ? `<div class="winner"><div class="wname">${esc(winner.name)} wins!</div><div class="wsub">MONOPOLY PARTY</div></div>`
      : `<div class="winner"><div class="wname">everyone is bankrupt</div></div>`
    el.classList.add('gameover')
    return
  }
  el.classList.remove('gameover')

  // someone landed on a card space — the TV prompts while their phone reveals
  if (v.pendingCardDraw) {
    const isChest = v.pendingCardDraw.deck === 'chest'
    const drawer = v.players.find((p) => p.id === v.pendingCardDraw?.player)
    el.innerHTML = `
      <div class="cardprompt">
        <div class="cp-icon">${isChest
          ? '<div class="chestwrap closed"><div class="chestlid"></div><div class="chestlock"></div><div class="chestbase"></div></div>'
          : '<div class="wheelwrap waiting"><div class="wheeldisc"></div><div class="wheelhub"></div><div class="wheelpointer"></div></div>'}</div>
        <div class="cp-title">${esc(drawer?.name ?? '')} landed on ${isChest ? 'Community Chest' : 'Chance'}</div>
        <div class="cp-sub">${isChest ? 'Open the chest' : 'Spin the wheel'} on ${esc(drawer?.name ?? '')}'s phone</div>
      </div>`
    return
  }

  // an arrest has been announced — the whole table sees who and why while
  // the arrested player's phone shows the Go to Jail button (30s clock).
  // (If the jail came from a card, the wheel reveal finishes first.)
  if (v.pendingJail && !(v.pendingCard && Date.now() < revealUntil)) {
    const arrested = v.players.find((p) => p.id === v.pendingJail?.player)
    const reason = v.pendingJail.reason === 'space'
      ? 'landed on Go To Jail'
      : v.pendingJail.reason === 'card'
        ? 'the card says: Go directly to Jail'
        : 'rolled three doubles in a row'
    el.innerHTML = `
      <div class="cardprompt jailprompt">
        <div class="cp-title">${arrested?.token ?? ''} ${esc(arrested?.name ?? '')} is under arrest</div>
        <div class="cp-sub">${esc(arrested?.name ?? '')} ${reason}</div>
        <div class="cp-sub">Tap "Go to Jail" on ${esc(arrested?.name ?? '')}'s phone</div>
      </div>`
    return
  }

  if (v.phase === 'AUCTION' && v.auction) {
    const sp = BOARD[v.auction.space]
    const bidder = v.players.find((p) => p.id === v.auction?.bidder)
    const passing = v.auction.passed.length
    const total = v.players.filter((p) => !p.bankrupt).length
    el.innerHTML = `
      <div class="auction">
        <div class="a-title">AUCTION</div>
        <div class="a-prop">${esc(sp.name)}${'price' in sp ? ` · $${sp.price}` : ''}</div>
        <div class="a-bid">$${v.auction.bid}</div>
        <div class="a-bidder">${v.auction.bidder ? `high bidder: ${bidder?.token} ${esc(bidder?.name ?? '')}` : 'no bids yet'}</div>
        <div class="a-count">${passing}/${total - 1} players passed</div>
      </div>`
    return
  }

  if (v.debt) {
    const debtor = v.players.find((p) => p.id === v.debt?.debtor)
    const creditor = v.debt.creditor ? v.players.find((p) => p.id === v.debt?.creditor) : null
    el.innerHTML = `
      <div class="banner debt">${esc(debtor?.name ?? '')} owes $${v.debt.amount} to ${creditor ? esc(creditor.name) : 'the bank'}</div>
      <div class="sub">${esc(debtor?.name ?? '')} is raising funds — selling houses, mortgaging…</div>`
    return
  }

  if (v.pendingCard) {
    // The reveal (chest opening / wheel spinning) owns the center only for
    // its animation window — then the live turn display takes over so the
    // stroll to the destination and the landed spotlight are visible.
    if (Date.now() < revealUntil) {
      const isChest = v.pendingCard.deck === 'chest'
      const anim = isChest ? 'revealcard' : 'wheelcard'
      el.innerHTML = `
        <div class="cardbox3d">
          ${isChest
            ? '<div class="chestwrap"><div class="chestlid"></div><div class="chestlock"></div><div class="chestbase"></div></div>'
            : '<div class="wheelwrap"><div class="wheeldisc"></div><div class="wheelhub"></div><div class="wheelpointer"></div></div>'}
          <div class="cardface ${v.pendingCard.deck} ${anim}">
            <div class="c-deck">${isChest ? 'COMMUNITY CHEST' : 'CHANCE'}</div>
            <div class="c-text">${esc(v.pendingCard.text)}</div>
          </div>
        </div>
        ${landedCard(v)}`
      return
    }
    // reveal finished: fall through to the turn display below
  }

  // Default state: the center of the screen belongs to the 3D scene —
  // the piece strolling, the camera riding along. Turn info lives in the
  // top strip; landed info in the queue column; dice in the side box.
  el.innerHTML = ''
}

// ── god console ──

const TIMERS: Array<[string, number]> = [
  ['Off', 0],
  ['1 min', 60_000],
  ['2 min', 120_000],
  ['5 min', 300_000],
  ['10 min', 600_000],
]

function updateGodPanel(v: HostView): void {
  const el = document.getElementById('godpanel')
  if (!el) return
  const cur = v.players.find((p) => p.id === v.currentPlayerId)
  const timerChips = TIMERS.map(
    ([label, ms]) => `<button class="chip ${v.turnTimeoutMs === ms ? 'sel' : ''}" data-god='{"cmd":"setTimer","ms":${ms}}'>${label}</button>`,
  ).join('')
  const playerRows = v.players
    .map(
      (p) => `
    <div class="gp-player" style="--c:${p.color}">
      <div class="gp-pname">${p.token} ${esc(p.name)} — $${p.cash}${p.bankrupt ? ' (bankrupt)' : ''}${p.jail ? ' · in jail' : ''}</div>
      <div class="gp-chips">
        <button class="tiny" data-god='{"cmd":"setCash","playerId":"${p.id}","amount":${Math.max(0, p.cash - 100)}}'>-$100</button>
        <button class="tiny" data-god='{"cmd":"setCash","playerId":"${p.id}","amount":${p.cash + 100}}'>+$100</button>
        <button class="tiny" data-god='{"cmd":"setCash","playerId":"${p.id}","amount":${p.cash + 500}}'>+$500</button>
        <button class="tiny" data-god='{"cmd":"promptCash","playerId":"${p.id}"}'>Set...</button>
      </div>
      <div class="gp-chips">
        <button class="tiny" data-god='{"cmd":"setPos","playerId":"${p.id}","pos":${(p.pos + 39) % 40}}'>&#9664;</button>
        <span class="gp-pos">space ${p.pos}</span>
        <button class="tiny" data-god='{"cmd":"setPos","playerId":"${p.id}","pos":${(p.pos + 1) % 40}}'>&#9654;</button>
        <button class="tiny" data-god='{"cmd":"setPos","playerId":"${p.id}","pos":${p.pos},"jail":${!p.jail}}'>${p.jail ? 'Release' : 'Jail'}</button>
        <button class="tiny" data-god='{"cmd":"promptPos","playerId":"${p.id}"}'>Move...</button>
      </div>
    </div>`,
    )
    .join('')

  const propRows = Object.entries(v.props)
    .map(([iStr, st]) => ({ i: Number(iStr), st }))
    .sort((a, b) => a.i - b.i)
    .map(({ i, st }) => {
      const sp = BOARD[i]
      const owner = st.owner ? v.players.find((p) => p.id === st.owner) : null
      const open = godPropSpace === i
      const isStreetSpace = 'price' in sp && sp.kind === 'street'
      return `<div class="gp-prop">
      <button class="gp-propname" data-god='{"cmd":"propToggle","space":${i}}'>${esc(sp.name)} <span style="color:${owner?.color ?? 'var(--dim)'}">· ${owner ? esc(owner.name) : 'Bank'}</span>${st.houses > 0 ? ` · ${st.houses === 5 ? 'hotel' : `${st.houses}h`}` : ''}${st.mortgaged ? ' · mtg' : ''}</button>
      ${open ? `
        <div class="gp-chips">
          <button class="tiny" data-god='{"cmd":"setProperty","space":${i},"owner":null}'>Bank</button>
          ${v.players.map((p) => `<button class="tiny" data-god='{"cmd":"setProperty","space":${i},"owner":"${p.id}"}'>${p.token} ${esc(p.name)}</button>`).join('')}
        </div>
        ${isStreetSpace ? `
        <div class="gp-chips">
          <button class="tiny" data-god='{"cmd":"setHouses","space":${i},"count":${Math.max(0, st.houses - 1)}}'>-house</button>
          <span class="gp-pos">${st.houses === 5 ? 'hotel' : `${st.houses} house(s)`}</span>
          <button class="tiny" data-god='{"cmd":"setHouses","space":${i},"count":${Math.min(5, st.houses + 1)}}'>+house</button>
        </div>` : ''}
        <div class="gp-chips">
          <button class="tiny" data-god='{"cmd":"setMortgaged","space":${i},"mortgaged":${!st.mortgaged}}'>${st.mortgaged ? 'Lift mortgage' : 'Mortgage'}</button>
        </div>` : ''}
    </div>`
    })
    .join('')

  el.innerHTML = `
    <div class="gp-head">GOD CONSOLE <span class="gp-status">${esc(godStatus)}</span></div>
    ${v.phase !== 'GAME_OVER' ? `
    <div class="gp-sec">TURN — ${cur ? esc(cur.name) : '—'}</div>
    <div class="gp-chips">
      <button data-god='{"cmd":"skipTurn"}'>Skip turn</button>
      <button data-god='{"cmd":"replayTurn"}'>Replay current</button>
    </div>
    <div class="gp-chips">${v.players
      .filter((p) => !p.bankrupt)
      .map((p) => `<button class="chip" data-god='{"cmd":"replayTurn","playerId":"${p.id}"}'>Turn &#8594; ${p.token} ${esc(p.name)}</button>`)
      .join('')}</div>
    <div class="gp-sec">FORCE REVEAL</div>
    <div class="gp-chips">
      <button data-god='{"cmd":"forceDraw","deck":"chest"}'>Community Chest</button>
      <button data-god='{"cmd":"forceDraw","deck":"chance"}'>Chance</button>
    </div>` : ''}
    <div class="gp-sec">DECISION TIMER</div>
    <div class="gp-chips">${timerChips}</div>
    <div class="gp-sec">PLAYERS</div>
    ${playerRows}
    <div class="gp-sec">PROPERTIES</div>
    <div class="gp-proplist">${propRows}</div>
    <div class="gp-sec">SNAPSHOT</div>
    <div class="gp-chips">
      <button data-god='{"cmd":"export"}'>Export JSON</button>
      <button id="godImportBtn">Import JSON</button>
      <button data-god='{"cmd":"endGame"}'>End game</button>
    </div>`
}

function downloadSnapshot(snap: unknown): void {
  const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `monopoly-${view?.code ?? 'room'}-turn${view?.turn ?? 0}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

function doImport(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json,application/json'
  input.onchange = () => {
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const json: unknown = JSON.parse(String(reader.result))
        sendGod({ cmd: 'import', json })
      } catch {
        godStatus = 'That file is not valid JSON'
        render()
      }
    }
    reader.readAsText(file)
  }
  input.click()
}

$app.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest('[data-god], #godImportBtn') as HTMLElement | null
  if (!el) return
  if (el.id === 'godImportBtn') {
    doImport()
    return
  }
  const args = JSON.parse(el.dataset.god ?? '{}') as Record<string, unknown>
  if (args.cmd === 'promptCash') {
    const n = Number(window.prompt('Set cash to...', '0') ?? Number.NaN)
    if (Number.isFinite(n)) {
      sendGod({ cmd: 'setCash', playerId: args.playerId, amount: Math.max(0, Math.floor(n)) })
    }
    return
  }
  if (args.cmd === 'promptPos') {
    const n = Number(window.prompt('Move to space (0-39)...', '0') ?? Number.NaN)
    if (Number.isFinite(n)) {
      sendGod({ cmd: 'setPos', playerId: args.playerId, pos: Math.max(0, Math.min(39, Math.floor(n))) })
    }
    return
  }
  if (args.cmd === 'export') {
    sendGod({ cmd: 'export' }, (res) => {
      if (res.ok && res.snapshot) downloadSnapshot(res.snapshot)
      else {
        godStatus = String(res.error ?? 'Export failed')
        render()
      }
    })
    return
  }
  if (args.cmd === 'propToggle') {
    godPropSpace = godPropSpace === Number(args.space) ? null : Number(args.space)
    render()
    return
  }
  sendGod(args)
})

render()
