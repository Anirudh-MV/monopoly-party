// ── TV / host screen ──
// A WebGL board (board3d.ts) fills the screen; slim HTML overlays carry the
// turn queue, activity ticker, and the center spotlight. The camera stays
// zoomed on the active piece and tracks its hops; in the lobby it does a
// slow cinematic orbit behind the QR card.
// Read-only by design — the game's authoritative state lives on the server.

import { io } from 'socket.io-client'
import QRCode from 'qrcode'
import { BOARD, GROUP_COLORS, isStreet } from '../../shared/board.js'
import type { HostView, LobbyInfo, PlayerState, Space } from '../../shared/types.js'
import { Board3D } from './board3d.js'

interface HostAck {
  ok: boolean
  code?: string
  hostToken?: string
  urls?: string[]
  error?: string
}

const DIE = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅']

const socket = io()
const $app = document.getElementById('app') as HTMLElement
const board3d = new Board3D(document.body)

let view: HostView | null = null
let lobby: LobbyInfo | null = null
let urls: string[] = []
let gameBuilt = false

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
        `<li${p.id === l.hostId ? ' class="crowned"' : ''}><span class="dot" style="background:${p.color}"></span><span class="ptoken">${p.token}</span> ${esc(p.name)}${p.id === l.hostId ? ' <span class="crown">👑 host</span>' : ''}${p.connected ? '' : '<em class="off">offline</em>'}</li>`,
    )
    .join('')
  $app.innerHTML = `
    <div class="lobby">
      <h1>🎲 MONOPOLY PARTY</h1>
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
        <button class="big ${l.canStart ? '' : 'disabled'}" data-act="start">▶ Start the game</button>
        ${l.canStart ? '' : '<p class="hint">Best with 3+ players — waiting…</p>'}
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
        <div class="overlay ticker" id="ticker"></div>
        <div class="center3d" id="center"></div>
      </div>`
    gameBuilt = true
  }
  board3d.sync(v)
  updateQueue(v)
  updateTicker(v)
  updateCenter(v)
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
  const crown = (p: PlayerState): string => (p.id === v.hostId ? ' <span class="crown">👑</span>' : '')
  el.innerHTML = `
    <div class="qhead">ROOM ${esc(v.code)} · TURN ${v.turn}</div>
    <div class="qnow" style="--c:${now.color}">
      <span class="qt">${now.token}</span>
      <span class="qn">${esc(now.name)}${crown(now)}</span>
      <span class="qc">$${now.cash}</span>
    </div>
    ${rest
      .map(
        (p) => `
    <div class="qitem" style="--c:${p.color}">
      <span class="qt">${p.token}</span>
      <span class="qn">${esc(p.name)}${crown(p)}${!p.connected ? '<em class="off">off</em>' : ''}</span>
      <span class="qc">$${p.cash}</span>
    </div>`,
      )
      .join('')}`
}

function updateTicker(v: HostView): void {
  const el = document.getElementById('ticker')
  if (!el) return
  const last = v.log[v.log.length - 1]
  el.innerHTML = last ? `<span class="t ${last.kind}">${esc(last.text)}</span>` : ''
}

function stripColor(sp: Space): string {
  if (isStreet(sp)) return GROUP_COLORS[sp.group]
  if (sp.kind === 'rail') return '#333'
  if (sp.kind === 'utility') return '#99a'
  if (sp.kind === 'chance') return '#c2410c'
  if (sp.kind === 'chest') return '#0e7490'
  return '#2c3a63'
}

// Spotlight: whatever the active piece just landed on, front and center,
// so everyone in the room sees what got selected.
function landedCard(v: HostView): string {
  if (!v.lastLanded || v.lastLanded.playerId !== v.currentPlayerId) return ''
  const i = v.lastLanded.space
  const sp = BOARD[i]
  const st = v.props[i]
  const mover = v.players.find((p) => p.id === v.lastLanded?.playerId)
  let info = ''
  if ('price' in sp && st) {
    const owner = st.owner ? v.players.find((p) => p.id === st.owner) : null
    const badges =
      (st.mortgaged ? ' · mortgaged 💤' : '') +
      (st.houses > 0 ? ` · ${st.houses === 5 ? '🏨 hotel' : `🏠×${st.houses}`}` : '')
    info = owner
      ? `<div class="l-owner" style="--c:${owner.color}">${owner.token} ${esc(owner.name)}${badges}</div>`
      : `<div class="l-owner unown">${v.pendingPurchase === i ? 'UNOWNED — buy or auction?' : 'unowned'}</div>`
  } else if (sp.kind === 'chance' || sp.kind === 'chest') {
    info = `<div class="l-owner unown">drawing a card…</div>`
  } else if (sp.kind === 'tax') {
    info = `<div class="l-owner unown">tax time 💸</div>`
  }
  return `
    <div class="landed">
      <div class="l-strip" style="background:${stripColor(sp)}"></div>
      <div class="l-name">${mover ? `${mover.token} ` : ''}${esc(sp.name)}${'price' in sp ? ` <span class="l-price">$${sp.price}</span>` : ''}</div>
      ${info}
    </div>`
}

function updateCenter(v: HostView): void {
  const el = document.getElementById('center')
  if (!el) return
  const cur = v.players.find((p) => p.id === v.currentPlayerId)

  if (v.phase === 'GAME_OVER' || v.winner) {
    const winner = v.players.find((p) => p.id === v.winner)
    el.innerHTML = winner
      ? `<div class="winner">🏆<div class="wname">${esc(winner.name)}</div><div class="wsub">WINS MONOPOLY PARTY</div></div>`
      : `<div class="winner">💀 everyone is bankrupt</div>`
    el.classList.add('gameover')
    return
  }
  el.classList.remove('gameover')

  const dice = v.dice ? `<div class="dice"><span>${DIE[v.dice[0] - 1]}</span><span>${DIE[v.dice[1] - 1]}</span></div>` : ''

  if (v.phase === 'AUCTION' && v.auction) {
    const sp = BOARD[v.auction.space]
    const bidder = v.players.find((p) => p.id === v.auction?.bidder)
    const passing = v.auction.passed.length
    const total = v.players.filter((p) => !p.bankrupt).length
    el.innerHTML = `
      <div class="auction">
        <div class="a-title">🔨 AUCTION</div>
        <div class="a-prop">${esc(sp.name)}</div>
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
      <div class="banner debt">⚠ ${esc(debtor?.name ?? '')} owes $${v.debt.amount} to ${creditor ? esc(creditor.name) : 'the bank'}</div>
      <div class="sub">${esc(debtor?.name ?? '')} is raising funds — selling houses, mortgaging…</div>`
    return
  }

  if (v.pendingCard) {
    el.innerHTML = `
      ${landedCard(v)}
      <div class="card ${v.pendingCard.deck}">
        <div class="c-deck">${v.pendingCard.deck === 'chance' ? '❓ CHANCE' : '🎁 COMMUNITY CHEST'}</div>
        <div class="c-text">${esc(v.pendingCard.text)}</div>
      </div>
      ${dice}`
    return
  }

  const captions: string[] = []
  if (v.pendingPurchase != null) captions.push(`Buy or auction ${BOARD[v.pendingPurchase].name}?`)
  if (v.pendingTax) captions.push('Choosing how to pay Income Tax…')
  if (v.trades.length > 0) captions.push(`🤝 ${v.trades.length} trade offer${v.trades.length > 1 ? 's' : ''} on the table`)
  if (v.phase === 'ROLL') captions.push('Roll the dice!')

  el.innerHTML = `
    ${cur ? `<div class="turn">${cur.token} <b>${esc(cur.name)}</b>'s turn</div>` : ''}
    ${landedCard(v)}
    ${dice}
    ${captions.map((c) => `<div class="sub">${c}</div>`).join('')}`
}

render()
