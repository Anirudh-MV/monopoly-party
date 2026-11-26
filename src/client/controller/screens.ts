// ── Screens: the lobby / join / game render flow ──
// render() is THE screen switch — full innerHTML rebuilds of $app on every
// server push. The wallet pulse rides along here too (it is driven purely
// by the render bookkeeping of the previous balance). Everything that
// must survive these rebuilds lives in #chrome and is patched by
// sheets.ts's updateChrome, which renderGame calls at the end.

import { BOARD, isStreet } from '../../shared/board.js'
import { TOKENS } from '../../shared/tokens.js'
import { COLORS } from '../../shared/colors.js'
import { AvatarPreview, avatarThumbnail } from '../tokens3d.js'
import { cardFace, deedChip, deedFull } from '../deed-card.js'
import { debtWhy } from '../../shared/card-effect.js'
import {
  debtBlurb,
  netWorth,
  rentFor,
  rentPreview,
  roundOf,
} from '../../shared/rules.js'
import type { LobbyInfo, PlayerView, Space, TradeOffer, TradeSide } from '../../shared/types.js'
import {
  disposeAvatarPreview,
  getDiceStrip,
  getFrozenEffectLine,
  getJoinCode,
  getJoinColor,
  getJoinName,
  getJoinPiece,
  getJoinStage,
  getLobby,
  getLobbyColorSel,
  getLobbySel,
  getLedgerTab,
  getMyPlayerId,
  getRejoinPending,
  getView,
  joinTaken,
  setAvatarPreview,
} from './state.js'
import { $app, avathumb, breaksSetCopy, completesSetCopy, esc, manageButtons, meOf, wouldMakeCopy } from './shared.js'
import { updateChrome } from './sheets.js'

const preCode = (new URLSearchParams(location.search).get('code') ?? '')
  .toUpperCase()
  .replace(/[^A-Z]/g, '')
  .slice(0, 4)

export function render(): void {
  const view = getView()
  if (view || getRejoinPending()) disposeAvatarPreview()
  if (view) {
    renderGame(view)
    return
  }
  // No game view (join screen, lobby, reconnecting): the game-only sheets
  // die with the game view, exactly as they did when they lived in $app.
  updateChrome(null)
  const lobby = getLobby()
  if (lobby) {
    renderLobby(lobby)
    return
  }
  if (getRejoinPending()) {
    $app.innerHTML = `
      <div class="join">
        <div class="card">
          <h2>Reconnecting…</h2>
          <p class="hint">Finding your seat in the game.</p>
        </div>
      </div>`
    return
  }
  renderJoin()
}

export function renderJoin(): void {
  disposeAvatarPreview()
  if (getJoinStage() === 'name') {
    $app.innerHTML = `
      <div class="join">
        <h1>MONOPOLY PARTY</h1>
        <div class="card">
          <label>Room code</label>
          <input id="code" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="ABCD" value="${esc(preCode || getJoinCode())}" />
          <label>Your name <span class="hint-inline">(no emojis)</span></label>
          <input id="name" maxlength="16" autocomplete="off" placeholder="e.g. Maya" value="${esc(getJoinName())}" />
          <button class="big primary" data-act="joinNext">Next — pick your piece</button>
          <p class="hint">Get the code from the TV screen</p>
        </div>
      </div>`
    return
  }
  // model + colour stage: tap a 3D avatar and a colour, previewed live
  $app.innerHTML = `
    <div class="join">
      <h1>MONOPOLY PARTY</h1>
      <div class="card">
        <div class="join-summary">Room <b>${esc(getJoinCode())}</b> · playing as <b>${esc(getJoinName())}</b> <button class="tiny" data-act="joinBack">Change</button></div>
        <label>Choose your piece</label>
        <div class="tokgrid">
          ${TOKENS.map(
            (t) =>
              `<button type="button" class="tok${t === getJoinPiece() ? ' sel' : ''}${joinTaken.has(t) ? ' taken' : ''}" data-piece="${t}" data-act="pickPiece"${joinTaken.has(t) ? ' disabled' : ''}><img src="${avatarThumbnail(TOKENS.indexOf(t))}" alt="${t}" draggable="false" /></button>`,
          ).join('')}
        </div>
        <label>Choose your colour</label>
        <div class="swatchgrid">
          ${COLORS.map(
            (c) => `<button type="button" class="swatch${c === getJoinColor() ? ' sel' : ''}" style="background:${c}" data-color="${c}" data-act="pickColor" aria-label="colour ${c}"></button>`,
          ).join('')}
        </div>
        <div id="avatarStage"></div>
        <button class="big primary" data-act="join">Join as ${esc(getJoinName())}</button>
        <p class="hint">Each piece is its own 3D avatar — it walks the board in your colour.</p>
      </div>
    </div>`
  const stage = document.getElementById('avatarStage')
  if (stage) {
    const preview = new AvatarPreview(stage)
    setAvatarPreview(preview)
    preview.show(TOKENS.indexOf(getJoinPiece()), getJoinColor())
  }
}

export function renderLobby(l: LobbyInfo): void {
  disposeAvatarPreview()
  const myPlayerId = getMyPlayerId()
  const isHost = myPlayerId != null && myPlayerId === l.hostId
  const me = l.players.find((p) => p.id === myPlayerId)
  const players = l.players
    .map((p) => {
      const kick = isHost && p.id !== myPlayerId ? `<button class="tiny kickbtn" data-act="kickPlayer" data-args='{"id":"${p.id}"}' title="Kick from the room">✕</button>` : ''
      // your own row: the only seat whose name you can edit
      const pen = p.id === myPlayerId ? `<button class="tiny renamebtn" data-act="editName" title="Change your name">✎</button>` : ''
      return `<li${p.id === l.hostId ? ' class="crowned"' : ''}><span class="dot" style="background:${p.color}"></span>${avathumb(p)}${esc(p.name)}${p.id === l.hostId ? ' <span class="crown">Host</span>' : ''}${p.connected ? '' : '<em class="off"> (offline)</em>'}${pen}${kick}</li>`
    })
    .join('')
  const others = l.players.filter((p) => p.id !== myPlayerId)
  const myPiece = getLobbySel() ?? me?.token ?? TOKENS[0]
  const myColor = getLobbyColorSel() ?? me?.color ?? COLORS[0]
  // your model + colour are yours to change until the game starts
  const seatEditor = me ? `
      <label>Your piece — tap to change</label>
      <div class="tokgrid">
        ${TOKENS.map(
          (t) =>
            `<button type="button" class="tok${t === myPiece ? ' sel' : ''}${l.players.some((p) => p.id !== myPlayerId && p.token === t) ? ' taken' : ''}" data-piece="${t}" data-act="lobbyPiece"${t === myPiece || l.players.some((p) => p.id !== myPlayerId && p.token === t) ? ' disabled' : ''}><img src="${avatarThumbnail(TOKENS.indexOf(t))}" alt="${t}" draggable="false" /></button>`,
        ).join('')}
      </div>
      <label>Your colour — tap to change</label>
      <div class="swatchgrid">
        ${COLORS.map(
          (c) =>
            `<button type="button" class="swatch${c === myColor ? ' sel' : ''}${l.players.some((p) => p.id !== myPlayerId && p.color === c) ? ' taken' : ''}" style="background:${c}" data-color="${c}" data-act="lobbyColor"${c === myColor || l.players.some((p) => p.id !== myPlayerId && p.color === c) ? ' disabled' : ''} aria-label="colour ${c}"></button>`,
        ).join('')}
      </div>
      <div id="avatarStage"></div>` : ''
  $app.innerHTML = `
    <div class="card">
      <h2>Room ${esc(l.code)}</h2>
      <p class="good">You're in${isHost ? ' — and you\u2019re the party host' : ''}.</p>
      <h3>Players (${l.players.length})</h3>
      <ul class="playerlist">${players}</ul>
      ${seatEditor}
      ${isHost ? `
        <button class="big primary" data-act="startGame" ${l.canStart ? '' : 'disabled'}>Start the game</button>
        ${!l.canStart ? '<p class="hint">Best with 3+ players — waiting…</p>' : ''}
        ${others.length > 0 ? `
          <label>Hand over host duties</label>
          <div class="chips">${others.map((p) => `<button class="chip" data-act="handOver" data-args='{"to":"${p.id}"}'>Host: ${esc(p.name)}</button>`).join('')}</div>` : ''}
        <div class="row"><button class="tiny danger" data-act="resetRoom">New room code</button></div>
      ` : '<p class="hint">Waiting for the host to start the game…<br/>Keep this tab open.</p>'}
      <div class="row"><button class="tiny" data-act="leave">Leave room</button></div>
    </div>`
  // live 3D preview of the piece you're wearing (or about to take), in your colour
  const stage = document.getElementById('avatarStage')
  if (stage && me) {
    const preview = new AvatarPreview(stage)
    setAvatarPreview(preview)
    preview.show(TOKENS.indexOf(myPiece), myColor)
  }
  // pre-warm the exact (model, colour) thumbnails the first game frame
  // will need, while the player is still reading the lobby
  setTimeout(() => {
    for (const p of l.players) {
      if (TOKENS.includes(p.token)) avatarThumbnail(TOKENS.indexOf(p.token), p.color)
    }
  }, 0)
}

// The debt banner's deed chip: the exact amount plus the WHY recomputed
// from live state — houses tier, full-set doubling or the dice product —
// never parsed from the memo. Rent debts get the chip; card debts keep
// the plain debtBlurb text.
function debtChipRow(v: PlayerView, d: { debtor: string; amount: number; creditor: string | null; memo?: string }): string {
  if (!d.memo?.startsWith('Rent: ')) return ''
  const i = BOARD.findIndex((sp) => sp.name === d.memo!.slice(6))
  if (i < 0) return ''
  return `<div class="debt-chiprow">${deedChip(v, i, { value: `$${d.amount}`, flag: debtWhy(v, d) })}</div>`
}

// The spectator countdown tail: someone ELSE'S blocking decision with an
// armed clock gets an honest live tail on the waiting banner (the
// last-30s own-decision chip stays as is — that one is yours). An armed
// clock you can still act on (auction bid/pass) is yours, not a tail.
function spectatorTail(v: PlayerView): string {
  if (v.deadline == null || !v.waitingOn) return ''
  if (v.waitingOn.playerId === v.you) return ''
  if (v.waitingOn.kind === 'auc' && (v.allowed.includes('bid') || v.allowed.includes('passBid'))) return ''
  return `<span class="wt" id="waitTail" data-until="${v.deadline}"></span>`
}

function renderGame(v: PlayerView): void {
  const I = meOf(v)
  if (!I.id) {
    $app.innerHTML = `<div class="card"><h2>Spectating</h2><p class="hint">This room's game is already running.</p></div>`
    updateChrome(v)
    return
  }
  const cur = v.players.find((p) => p.id === v.currentPlayerId)
  const acts = new Set(v.allowed)
  const worth = netWorth(v, I.id)

  // wallet pulse bookkeeping: the previous balance animates to this one
  const prevCash = lastCash
  lastCash = I.cash

  let banner = ''
  let body = ''

  // What the active player drew — a card face, NEVER a blocker: the action
  // cascade below must always render so the game can always advance. The
  // effect line is the frozen one (a repairs bill can't shrink mid-reveal).
  let drawStrip = ''
  if (v.pendingCard && !v.pendingCardDraw) {
    drawStrip = cardFace(v.pendingCard, getFrozenEffectLine() || undefined)
  }

  // What the active player just landed on, as the shared deed chip —
  // visible on every phone so the table shares one mental model of the
  // board. The number is the live rentFor gated on the mortgage (a
  // mortgaged deed collects nothing — never print a rent due for it).
  let landedStrip = ''
  if (v.lastLanded && v.lastLanded.playerId === v.currentPlayerId) {
    const i = v.lastLanded.space
    const sp = BOARD[i]
    const drawer = v.players.find((p) => p.id === v.currentPlayerId)
    const who = I.id === v.currentPlayerId ? 'You' : `${avathumb(drawer)}${esc(drawer?.name ?? '')}`
    const diceSum = v.dice ? v.dice[0] + v.dice[1] : 7
    let rentLine = ''
    let chipVal: string | undefined
    if ('price' in sp) {
      const st = v.props[i]
      const owner = st.owner ? v.players.find((p) => p.id === st.owner) : null
      if (owner && owner.id === v.currentPlayerId) {
        if (st.mortgaged) {
          rentLine = '<span class="ls-rent">Yours — <b>mortgaged, earns nothing</b></span>'
        } else {
          const rent = rentFor(v, i, diceSum)
          chipVal = `$${rent}`
          rentLine = `<span class="ls-rent">Yours — earns <b>$${rent}</b></span>`
        }
      } else if (owner) {
        if (st.mortgaged) {
          rentLine = `<span class="ls-rent"><b>no rent - mortgaged</b> — ${avathumb(owner)}${esc(owner.name)}'s</span>`
        } else {
          const rent = rentFor(v, i, diceSum)
          chipVal = `$${rent}`
          const whose = owner.id === I.id ? '<b>yours to collect</b>' : `${avathumb(owner)}${esc(owner.name)}`
          rentLine = `<span class="ls-rent">Rent due: <b>$${rent}</b> — ${whose}</span>`
        }
      } else {
        chipVal = `$${sp.price}`
        const rp = rentPreview(v, i)
        const baseCopy = sp.kind === 'utility' ? rp.note : `$${rp.current}`
        rentLine = `<span class="ls-rent">Rent: <b>${baseCopy}</b> when owned</span>`
      }
    }
    landedStrip = `<div class="landedstrip">${who} landed on ${deedChip(v, i, { value: chipVal })}${rentLine}</div>`
  }

  // Deadline chip: the 300s decision clock is hidden until its final
  // 30 seconds — then it's impossible to ignore.
  let deadlineChip = ''
  if (v.deadline != null && (v.deadlineFor === I.id || v.deadlineFor === null)) {
    const rem = v.deadline - Date.now()
    if (rem <= 30_000) {
      deadlineChip = `<div class="deadline${rem <= 10_000 ? ' urgent' : ''}" id="deadlineChip" data-until="${v.deadline}"><span>${Math.max(0, Math.ceil(rem / 1000))}s</span> left — make your move!</div>`
    }
  }

  // ── Contextual status (mutually exclusive) ──
  if (v.phase === 'GAME_OVER' || v.winner) {
    // Shared wins (worth ties) read as a tie on the phone; the single-winner
    // copy every existing screen knows stays byte-identical.
    const winners = v.winners ?? (v.winner ? [v.winner] : [])
    if (winners.length > 1) {
      const mine = winners.includes(I.id)
      banner = `<div class="banner ${mine ? 'good' : ''}">It's a tie! — ${v.players.filter((p) => winners.includes(p.id)).map((p) => esc(p.name)).join(' & ')} share the win</div>`
    } else {
      const winner = v.players.find((p) => p.id === v.winner)
      banner = `<div class="banner ${winner?.id === I.id ? 'good' : ''}">${winner ? `${esc(winner.name)} wins!` : 'Game over'}</div>`
    }
  } else if (v.phase === 'DEBT' && v.debt && v.debt.debtor === I.id) {
    const creditor = v.debt.creditor ? v.players.find((p) => p.id === v.debt?.creditor) : null
    const canPay = acts.has('payDebt')
    // Rent debts carry the why-math on a deed chip below the banner;
    // card debts keep the one-phrase debtBlurb text.
    const isRent = !!v.debt.memo?.startsWith('Rent: ')
    banner = `<div class="banner debt">You owe <b>$${v.debt.amount}</b> to ${creditor ? `${avathumb(creditor)}${esc(creditor.name)}` : 'the bank'}${isRent ? '' : ` — ${esc(debtBlurb(v.debt))}`}</div>${debtChipRow(v, v.debt)}`
    if (canPay) {
      // rent they can afford: a deliberate, felt-in-the-hand payment
      body += `
        <div class="card urgent">
          <h3>Time to pay up</h3>
          <p class="hint">The money leaves your wallet when you tap.</p>
          <button class="big good" data-act="payDebt">Pay $${v.debt.amount}</button>
        </div>`
    } else {
      body += `
        <div class="card urgent">
          <h3>Raise the money</h3>
          <p>Sell houses or mortgage properties below, then tap Pay.</p>
          <button class="big danger" data-act="bankrupt">Declare bankruptcy</button>
        </div>`
    }
  } else if (v.phase === 'DEBT' && v.debt) {
    const debtor = v.players.find((p) => p.id === v.debt?.debtor)
    const creditor = v.debt.creditor ? v.players.find((p) => p.id === v.debt?.creditor) : null
    // Rent debts carry the why-math on a deed chip below the banner; card
    // debts keep the one-phrase debtBlurb text.
    const isRent = !!v.debt.memo?.startsWith('Rent: ')
    // A relay card queues several payments through one freeze. If I'M the one
    // getting paid, show how much of the relay is still owed to me.
    const dq = v.debtQueue || []
    let relay = ''
    if (v.debt.creditor === I.id && dq.some((d) => d.creditor === I.id)) {
      const mine = 1 + dq.filter((d) => d.creditor === I.id).length
      relay = ` — <b>${mine} of ${1 + dq.length} still to pay</b>`
    }
    banner = `<div class="banner info">${avathumb(debtor)}${esc(debtor?.name ?? '')} is paying ${creditor ? `${avathumb(creditor)}${esc(creditor.name)}` : 'the bank'} <b>$${v.debt.amount}</b>${isRent ? '' : ` — ${esc(debtBlurb(v.debt))}`}${relay}${spectatorTail(v)}</div>${debtChipRow(v, v.debt)}`
  } else if (v.phase === 'AUCTION' && v.auction) {
    const bidder = v.players.find((p) => p.id === v.auction?.bidder)
    const mine = v.auction.bidder === I.id
    banner = `<div class="banner auction">Auction: ${deedChip(v, v.auction.space, { value: `$${v.auction.bid}` })}${bidder ? ` — high bidder: <b>${esc(bidder.name)}</b>` : ' — no bids yet'}${spectatorTail(v)}</div>`
    if (mine) {
      body += `<div class="card"><h3>You're the high bidder</h3><p class="hint">Waiting for the others…</p></div>`
    } else if (acts.has('bid') || acts.has('passBid')) {
      const au = v.auction
      const min = au.bid + 1
      const highBidder = au.bidder ? v.players.find((p) => p.id === au.bidder) : null
      body += `
        <div class="card">
          ${deedFull(v, au.space, avathumb)}
          <p class="hint">${wouldMakeCopy(v, au.space)}</p>
          <h3>Place your bid${au.bid > 0 ? ` — current bid <b>$${au.bid}</b>${highBidder ? ` (${esc(highBidder.name)})` : ''}` : ' — no bids yet'}</h3>
          <div class="row">
            <button data-act="bid" data-args='{"amount":${min}}'>$${min}</button>
            <button data-act="bid" data-args='{"amount":${au.bid + 10}}'>+$10</button>
            <button data-act="bid" data-args='{"amount":${au.bid + 50}}'>+$50</button>
          </div>
          <div class="row">
            <input id="bidAmount" type="number" inputmode="numeric" placeholder="custom $${min}+" />
            <button data-act="bidCustom">Bid</button>
            <button class="danger" data-act="passBid">Pass</button>
          </div>
        </div>`
    } else {
      body += `<div class="card"><p class="hint">Waiting for bids…</p></div>`
    }
  } else if (v.pendingCardDraw && v.pendingCardDraw.player === I.id) {
    const isChest = v.pendingCardDraw.deck === 'chest'
    banner = `<div class="banner ${isChest ? 'card-chest' : 'card-chance'}">You landed on <b>${isChest ? 'Community Chest' : 'Chance'}</b></div>`
    body += `<div class="card actions">
      <button class="big primary" data-act="drawCard">${isChest ? 'Open the Community Chest' : 'Spin the wheel'}</button>
    </div>`
  } else if (v.pendingCardDraw) {
    banner = `<div class="banner info">${cur ? esc(cur.name) : 'The active player'} landed on ${v.pendingCardDraw.deck === 'chest' ? 'Community Chest' : 'Chance'} — waiting for the reveal…${spectatorTail(v)}</div>`
  } else if (v.pendingJail && v.pendingJail.player === I.id) {
    const reason = v.pendingJail.reason === 'space'
      ? 'you landed on Go To Jail'
      : v.pendingJail.reason === 'card'
        ? 'the card says: Go directly to Jail'
        : 'you rolled three doubles in a row'
    banner = `<div class="banner debt">You're under arrest — ${reason}</div>`
    body += `<div class="card actions">
      <button class="big danger" data-act="goToJail">Go to Jail</button>
      <p class="hint">The sentence starts when you tap — the table is watching.</p>
    </div>`
  } else if (v.pendingJail) {
    const arrested = v.players.find((p) => p.id === v.pendingJail?.player)
    banner = `<div class="banner info">${avathumb(arrested)}${esc(arrested?.name ?? '')} is under arrest — waiting for them to go to jail…${spectatorTail(v)}</div>`
  } else if (v.phase === 'ROLL' && I.id === v.currentPlayerId) {
    banner = `<div class="banner good">Your turn${I.jail ? ` — you're in jail (${I.jailReason ?? 'sentenced earlier'})` : ''}</div>`
    body += `<div class="card actions">
      <button class="big primary" data-act="roll">Roll the dice</button>
      ${I.jail ? `
        <h3 style="margin-top:12px">Jail — attempt ${I.jailRolls}/3</h3>
        <div class="row">
          ${acts.has('payJail') ? `<button data-act="payJail">Pay $50 fine</button>` : ''}
          ${acts.has('useJailCard') ? `<button data-act="useJailCard">Use jail card</button>` : ''}
        </div>` : ''}
    </div>`
  } else if (v.phase === 'ACTION' && I.id === v.currentPlayerId) {
    if (v.pendingPurchase != null) {
      const sp = BOARD[v.pendingPurchase]
      const price = 'price' in sp ? sp.price : 0
      banner = `<div class="banner good">You landed on <b>${esc(sp.name)}</b></div>`
      body += `<div class="card actions">
        ${deedFull(v, v.pendingPurchase, avathumb)}
        <p class="hint">${wouldMakeCopy(v, v.pendingPurchase)}</p>
        <div class="row">
          ${acts.has('buy') ? `<button class="big good" data-act="buy">Buy for $${price}</button>` : `<button class="big disabled" disabled>Can't afford $${price}</button>`}
          ${acts.has('declineBuy') ? `<button class="big" data-act="declineBuy">Send to auction</button>` : ''}
        </div>
      </div>`
    } else if (v.pendingTax && v.pendingTax.player === I.id) {
      const percentCost = Math.ceil(netWorth(v, I.id) / 10)
      banner = `<div class="banner good">Income Tax</div>`
      body += `<div class="card actions">
        <h3>Choose your payment</h3>
        <div class="row">
          ${acts.has('payTax') ? `<button data-act="payTax" data-args='{"choice":"flat"}'>Pay flat $200</button>` : ''}
          ${acts.has('payTax') ? `<button data-act="payTax" data-args='{"choice":"percent"}'>Pay 10% of worth ($${percentCost})</button>` : ''}
        </div>
      </div>`
    } else {
      banner = `<div class="banner info">You rolled — you can still build or trade before ending your turn.</div>`
      body += `<div class="card actions"><button class="big primary" data-act="endTurn">End turn</button></div>`
    }
  } else if (I.bankrupt) {
    // An eliminated seat spectates: allowedActions is empty, so no
    // affordances render — never tell a bankrupt player they can still
    // build or trade. The ledger, table and deeds stay as read-only views.
    banner = `<div class="banner debt">💀 You're bankrupt — enjoy the show</div>`
  } else {
    banner = `<div class="banner info">${cur ? `${avathumb(cur)}<b>${esc(cur.name)}</b>'s turn` : 'Waiting…'}${spectatorTail(v)}</div>`
    body += `<div class="card"><p class="hint">You can still build, mortgage, and trade.</p></div>`
  }

  // ── Trades ──
  const incoming = v.trades.filter((t) => t.to === I.id)
  const outgoing = v.trades.filter((t) => t.from === I.id)
  if (incoming.length > 0) {
    body += `<div class="trades"><h3>INCOMING OFFERS</h3>${incoming.map((t) => tradeCard(v, t, 'incoming')).join('')}</div>`
  }
  if (outgoing.length > 0) {
    body += `<div class="trades"><h3>YOUR OFFERS</h3>${outgoing.map((t) => tradeCard(v, t, 'outgoing')).join('')}</div>`
  }

  // ── My portfolio (a bankrupt seat owns nothing — the table tells the story) ──
  if (!I.bankrupt) body += renderPortfolio(v, I.id)

  // ── New trade button — directly above the transaction history ──
  if (acts.has('proposeTrade')) {
    body += `<button class="big wide" data-act="openTrade">Propose a trade</button>`
  }

  // ── The whole title-deed book: always available, no phase gating ──
  const ownedCount = Object.values(v.props).filter((st) => st.owner === I.id).length
  body += `<button class="big wide" data-act="openDeeds">View properties${ownedCount ? ` · ${ownedCount} owned` : ''}</button>`

  // ── The table at a glance — every player's cash and deeds ──
  body += renderTable(v)

  // ── Transaction history (yours and everyone else's) ──
  body += renderLedger(v, I.id)

  const diceStrip = getDiceStrip()
  $app.innerHTML = `
    <header class="topbar" style="--c:${I.color}">
      <span class="me">${avathumb(I)}${esc(I.name)}</span>
      <span class="money" id="moneyChip">$${I.cash}</span>
      <span class="meta">worth $${worth}${v.roundsCap > 0 ? ` · Round ${roundOf(v.turn, v.players.length)}/${v.roundsCap}` : ''}${I.jailCards > 0 ? ` · jail card ×${I.jailCards}` : ''}${I.jail ? ' · in jail' : ''}</span>
    </header>
    ${banner}
    ${diceStrip && Date.now() < diceStrip.until ? diceStrip.html : ''}
    ${landedStrip}
    ${drawStrip}
    ${deadlineChip}
    <main>${body}</main>`

  // The sheets no longer ride in $app's innerHTML: they live in #chrome
  // and are patched in place, so this wholesale rebuild never destroys an
  // open sheet (the composer's inputs keep focus mid-typing, the deeds
  // grid keeps its scroll).
  updateChrome(v)

  // the wallet counts to its new balance, with a floating delta
  if (prevCash != null && prevCash !== I.cash) animateMoney(prevCash, I.cash)
}

// ── wallet pulse ──
// Every cash change counts to the new balance with a floating delta chip —
// money visibly moves instead of silently renumbering. Driven purely by
// renderGame's balance bookkeeping, so it lives with the render flow.
let lastCash: number | null = null
let moneyRaf = 0

function animateMoney(from: number, to: number): void {
  cancelAnimationFrame(moneyRaf)
  const t0 = performance.now()
  const dur = 700
  const step = (t: number): void => {
    const chip = document.getElementById('moneyChip')
    if (!chip) return // re-rendered away; the fresh paint already shows `to`
    const k = Math.min(1, (t - t0) / dur)
    const eased = 1 - Math.pow(1 - k, 3)
    chip.firstChild!.textContent = `$${Math.round(from + (to - from) * eased)}`
    if (k < 1) moneyRaf = requestAnimationFrame(step)
  }
  moneyRaf = requestAnimationFrame(step)

  const chip = document.getElementById('moneyChip')
  if (chip) {
    const float = document.createElement('span')
    float.className = `money-float ${to >= from ? 'plus' : 'minus'}`
    float.textContent = `${to >= from ? '+' : '−'}$${Math.abs(to - from)}`
    chip.appendChild(float)
    setTimeout(() => float.remove(), 1500)
  }
}

// One trade side as chips: rent now, plus the completes-set (receiving)
// or breaks-set (giving) flag computed for THIS phone's post-trade
// holdings. Trades never carry buildings, so the delta is always base
// rent. Tapping a chip opens the full deed.
function sideSummary(v: PlayerView, side: TradeSide, dir: 'toYou' | 'fromYou'): string {
  const parts: string[] = []
  if (side.cash > 0) parts.push(`$${side.cash}`)
  const diceSum = v.dice ? v.dice[0] + v.dice[1] : 7
  for (const i of side.spaces) {
    const st = v.props[i]
    const value = st.mortgaged ? '$0' : `$${rentFor(v, i, diceSum)}`
    const flag = dir === 'toYou' ? completesSetCopy(v, i) : breaksSetCopy(v, i)
    parts.push(deedChip(v, i, { act: 'propInfo', value, flag }))
  }
  if (side.jailCards > 0) parts.push(`jail card ×${side.jailCards}`)
  return parts.join(' + ') || 'nothing'
}

function tradeCard(v: PlayerView, t: TradeOffer, dir: 'incoming' | 'outgoing'): string {
  const from = v.players.find((p) => p.id === t.from)
  const to = v.players.find((p) => p.id === t.to)
  // incoming: the give side flows TO me, the receive side leaves me.
  // outgoing: the give side leaves me, the receive side flows TO me.
  const giveDir = dir === 'incoming' ? 'toYou' : 'fromYou'
  const recvDir = dir === 'incoming' ? 'fromYou' : 'toYou'
  // Accepting moves money and deeds, so it waits out auction/debt freezes
  // (the engine enforces the same rule). Declining or withdrawing is
  // always live — the engine takes it in any phase.
  const frozen = v.phase === 'AUCTION' || v.phase === 'DEBT'
  return `<div class="card trade">
    <div><b>${avathumb(from)}${esc(from?.name ?? '')}</b> offers <b>${sideSummary(v, t.give, giveDir)}</b><br/>in exchange for <b>${sideSummary(v, t.receive, recvDir)}</b> <span class="hint">(${esc(to?.name ?? '')})</span></div>
    ${dir === 'incoming'
      ? `<div class="row"><button class="good" data-act="acceptTrade" data-args='{"id":"${t.id}"}'${frozen ? ' disabled' : ''}>Accept</button><button class="danger" data-act="declineTrade" data-args='{"id":"${t.id}"}'>Decline</button></div>${frozen ? '<p class="hint">Trades pause until this settles</p>' : ''}`
      : `<div class="row"><button data-act="cancelTrade" data-args='{"id":"${t.id}"}'>Withdraw offer</button></div>`}
  </div>`
}

function renderPortfolio(v: PlayerView, pid: string): string {
  const owned = Object.entries(v.props)
    .filter(([, st]) => st.owner === pid)
    .map(([iStr, st]) => ({ i: Number(iStr), st }))
    .sort((a, b) => a.i - b.i)
  if (owned.length === 0) {
    return `<div class="trades"><h3>YOUR PROPERTIES</h3><p class="hint">None yet — land on something and buy it!</p></div>`
  }
  const diceSum = v.dice ? v.dice[0] + v.dice[1] : 7
  const rows = owned
    .map(({ i, st }) => {
      const sp: Space = BOARD[i]
      // the chip carries name, group, house pips and the rent it earns
      // NOW (a mortgaged deed earns $0 — never blank, the hatched swatch
      // + MORTGAGED marker say why); tapping it opens the full deed
      const chipVal = st.mortgaged ? '$0' : `$${rentFor(v, i, diceSum)}`
      // earning line: what the next build tier earns (the now-number is
      // on the chip)
      const rp = rentPreview(v, i)
      let earn = ''
      if (isStreet(sp)) {
        earn = st.houses === 5
          ? 'hotel tier — the top of the ladder'
          : rp.next != null
            ? `next tier <b>$${rp.next}</b> with ${rp.next === sp.rents[5] ? 'a hotel' : 'a house'}${rp.note ? ` · ${rp.note}` : ''}`
            : rp.note ? rp.note : ''
      } else if (sp.kind === 'rail') {
        earn = rp.next != null ? `next tier <b>$${rp.next}</b> with another railroad` : 'all four railroads'
      } else if (sp.kind === 'utility') {
        earn = rp.next != null ? `<b>${rp.next}× dice</b> with both` : 'both utilities — 10× dice'
      }
      if (st.mortgaged) earn = 'mortgaged — no rent while asleep'
      // The server's allowed list is THE gate: a button renders exactly when
      // the engine would accept it (manageButtons — shared with the deeds
      // grid, so the two can never drift). During freezes (auction/debt) the
      // list omits management actions, so the buttons simply don't appear —
      // the phase banner already explains what the table is waiting on.
      const btns = manageButtons(v, pid, i)
      return `<div class="prop">
        ${deedChip(v, i, { act: 'propInfo', value: chipVal })}
        <div class="pinfo">
          ${earn ? `<div class="pearn">${earn}</div>` : ''}
          ${btns.length > 0 ? `<div class="row">${btns.join('')}</div>` : ''}
        </div>
      </div>`
    })
    .join('')
  return `<div class="trades"><h3>YOUR PROPERTIES (${owned.length})</h3>${rows}</div>`
}

// The whole table in one quiet section: every player's cash and their
// deeds as compact colour chips. Tapping a chip opens that deed's card;
// tapping the row opens the full title-deed screen filtered to that player.
function abbrName(sp: Space): string {
  // fit ~8-10 chars: drop the long suffixes, then hard-truncate
  let n = sp.name
    .replace(' Railroad', ' RR')
    .replace('Electric Company', 'Elec Co')
    .replace(' Avenue', '')
    .replace(' Place', '')
    .replace(' Gardens', '')
  return n.length > 10 ? `${n.slice(0, 9)}.` : n
}

function renderTable(v: PlayerView): string {
  const ownable = Object.keys(v.props).length
  const ownedTotal = Object.values(v.props).filter((st) => st.owner != null).length
  // bankrupt players sink to the bottom, dimmed, chipless (their deeds
  // have already been transferred)
  const rows = [...v.players]
    .sort((a, b) => (a.bankrupt === b.bankrupt ? 0 : a.bankrupt ? 1 : -1))
    .map((p) => {
      if (p.bankrupt) {
        return `<div class="trow dead">
          <div class="t-top"><span class="t-name" style="color:${p.color}">${avathumb(p)}💀 ${esc(p.name)}</span><span class="t-cash">$${p.cash}</span></div>
        </div>`
      }
      const chips = Object.entries(v.props)
        .filter(([, st]) => st.owner === p.id)
        .map(([iStr]) => Number(iStr))
        .sort((a, b) => a - b) // board order = colour runs stay together
        .map((i) => deedChip(v, i, { act: 'propInfo', name: abbrName(BOARD[i]) })) // pips only — one tap opens the deed
        .join('')
      return `<div class="trow" data-act="openDeeds" data-args='{"owner":"${p.id}"}'>
        <div class="t-top"><span class="t-name" style="color:${p.color}">${avathumb(p)}${esc(p.name)}</span><span class="t-cash">$${p.cash}</span><span class="t-go" aria-hidden="true">▸</span></div>
        ${chips ? `<div class="t-deeds">${chips}</div>` : ''}
      </div>`
    })
    .join('')
  return `<div class="trades table-sec"><h3>TABLE${ownable ? ` · ${ownedTotal}/${ownable} deeds owned · tap a player for their deeds` : ''}</h3>${rows}</div>`
}

// The full-information money ledger: "All" merges every player's books.
const ALL = '__all__'

function renderLedger(v: PlayerView, meId: string): string {
  const sel = getLedgerTab() ?? meId
  const all = sel === ALL
  const entries = (all ? v.ledger : v.ledger.filter((e) => e.playerId === sel)).slice(-30).reverse()
  const chips = [
    `<button class="chip ${all ? 'sel' : ''}" data-act="ledgerTab" data-args='{"id":"${ALL}"}'>All</button>`,
    ...v.players.map(
      (p) =>
        `<button class="chip ${p.id === sel ? 'sel' : ''}" style="${p.id === sel ? `border-color:${p.color}` : ''}" data-act="ledgerTab" data-args='{"id":"${p.id}"}' ${p.bankrupt ? 'disabled' : ''}>${avathumb(p)}${esc(p.name)}</button>`,
    ),
  ].join('')
  const rows = entries.length
    ? entries
        .map((e) => {
          const who = v.players.find((p) => p.id === e.playerId)
          const bal = e.balance != null ? `<span class="bal">$${e.balance}</span>` : ''
          return `<li><span class="who" style="color:${who?.color ?? 'inherit'}">${avathumb(who)}</span><span class="amt ${e.delta > 0 ? 'plus' : 'minus'}">${e.delta > 0 ? '+' : '-'}$${Math.abs(e.delta)}</span>${bal}<span class="memo">${esc(e.memo)}</span><span class="lturn">turn ${e.turn}</span></li>`
        })
        .join('')
    : '<li><span class="memo hint">No transactions yet.</span></li>'
  return `<div class="ledger">
    <h3>TRANSACTION HISTORY</h3>
    <div class="chips">${chips}</div>
    <ul class="ledger-list">${rows}</ul>
  </div>`
}
