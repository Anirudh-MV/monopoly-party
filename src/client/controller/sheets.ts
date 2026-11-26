// ── Sheets: the chrome patcher, the dock, the your-move bar ──
// renderGame rebuilds ALL of $app via innerHTML on every server push, so
// everything that must survive those rebuilds lives in the #chrome
// sibling: the dock, the your-move bar and THE sheet (one at a time).
// Each mounts once per open and is then patched, never rebuilt with the
// main flow — a push mid-typing never touches the composer's inputs
// (focus and contents survive), and the deeds grid is left byte-identical
// (scroll intact) unless the board actually changed. No code path here
// writes to an <input> — that is the no-input-writes guarantee, verbatim
// from the pre-split patcher.

import { BOARD, GROUP_COLORS, GROUP_LABEL, KIND_COLORS, groupIndices, isStreet } from '../../shared/board.js'
import { deedChip, deedFull } from '../deed-card.js'
import { rentFor } from '../../shared/rules.js'
import type { ColorGroup, PlayerView, WaitingKind } from '../../shared/types.js'
import {
  getComposer,
  getDeedFilters,
  getDingOn,
  getPhoneBoard,
  getPopGuard,
  getSheet,
  getTheme,
  getView,
  setPopGuard,
  setSheet,
  type SheetKind,
} from './state.js'
import { $chrome, avathumb, breaksSetCopy, completesSetCopy, esc, manageButtons, meOf, partnerPlayer } from './shared.js'

const SHEET_KINDS: readonly SheetKind[] = ['deeds', 'more', 'composer']
export const SHEET_IDS: Record<SheetKind, string> = { deeds: 'chromeDeeds', more: 'chromeMore', composer: 'chromeComposer' }
const SHEET_CLASSES: Record<SheetKind, string> = { deeds: 'deeds-sheet', more: 'more-sheet', composer: '' }
const SHEET_CLOSE_ACTS: Record<SheetKind, string> = { deeds: 'closeDeeds', more: 'closeMore', composer: 'closeTrade' }
const SHEET_LABELS: Record<SheetKind, string> = {
  deeds: 'Title deeds',
  more: 'More tools',
  composer: 'Propose a trade',
}
// who had focus before the sheet opened (restored on close)
let sheetFocusSaved: HTMLElement | null = null

// ── the sheet system's one open / one close path ──

// Open a sheet. Opening one closes another: the pushed history entry is
// REPLACED on a switch (still exactly one entry to pop on close) and
// PUSHED on a fresh open — always the same URL, so the update pill and
// the ?code= prefill are untouched. Mounting (inside updateChrome) does
// the open-time side effects: focus capture, scroll lock, first control.
export function openSheet(kind: SheetKind): void {
  if (getSheet() === kind) return
  const switching = getSheet() != null
  setSheet(kind)
  if (switching) history.replaceState({ mpSheet: kind }, '', location.href)
  else history.pushState({ mpSheet: kind }, '', location.href)
  updateChrome(getView())
}

// THE one close path. The composer's draft survives (hide, never lose).
// The pushed history entry is consumed exactly once: a UI close pops it
// via history.back() (the popstate handler recognises its own pop), a
// real Android back has already popped it — history.state no longer
// carries mpSheet, so no second back fires.
export function closeSheet(): void {
  const kind = getSheet()
  if (!kind) return
  const el = document.getElementById(SHEET_IDS[kind])
  setSheet(null)
  delete document.body.dataset.sheet
  const saved = sheetFocusSaved
  sheetFocusSaved = null
  el?.remove()
  composerSigLast = ''
  deedsSigLast = ''
  if (saved && saved.isConnected) saved.focus()
  const st = history.state as { mpSheet?: string } | null
  if (st?.mpSheet && !getPopGuard()) {
    setPopGuard(true)
    history.back()
  }
  updateDock(getView())
  updateMoveBar(getView())
}

// Backdrop tap closes (data-act on .modal — every close act funnels into
// closeSheet); the sheet swallows taps with an empty data-act — the
// composer's shield, unchanged. Mount = the one open moment: dialog
// semantics, focus capture, scroll lock and first-control focus happen
// here and nowhere else.
function mountSheet(id: string, sheetClass: string, sheetHTML: string, backdropAct: string, ariaLabel: string): HTMLElement {
  const modal = document.createElement('div')
  modal.className = 'modal'
  modal.id = id
  modal.dataset.act = backdropAct
  modal.innerHTML = `<div class="sheet ${sheetClass}" role="dialog" aria-modal="true" aria-label="${ariaLabel}" data-act="">${sheetHTML}</div>`
  $chrome.appendChild(modal)
  sheetFocusSaved = document.activeElement instanceof HTMLElement ? document.activeElement : null
  document.body.dataset.sheet = getSheet() ?? ''
  const first = modal.querySelector<HTMLElement>('button:not([disabled]), input, select, textarea, [href]')
  first?.focus()
  return modal
}

function sheetHTMLFor(kind: SheetKind, v: PlayerView): string {
  if (kind === 'deeds') return deedsSheetHTML(v)
  if (kind === 'more') return moreSheetHTML()
  return getComposer() != null ? composerSheetHTML(v) : ''
}

// ── the trade composer sheet (chrome-mounted) ──
// Region builders shared by mount and patch, so the two can never drift.
// The cash INPUTS appear only in composerSheetHTML — the patcher has no
// write path to them at all (focus and typed text survive every push).
function composerPartnersRowHTML(v: PlayerView): string {
  const C = getComposer()
  if (!C) return ''
  return v.players
    .filter((p) => !p.bankrupt && p.id !== v.you)
    .map((p) => `<button class="chip ${C.partner === p.id ? 'sel' : ''}" data-act="composerPartner" data-args='{"partner":"${p.id}"}'>${avathumb(p)}${esc(p.name)}</button>`)
    .join('')
}

function composerChipsHTML(v: PlayerView, forPid: string, selected: number[], which: 'give' | 'recv'): string {
  const spaces = Object.entries(v.props).filter(([, st]) => st.owner === forPid)
  const diceSum = v.dice ? v.dice[0] + v.dice[1] : 7
  const chip = (i: number, sel: boolean): string => {
    const st = v.props[i]
    const value = st.mortgaged ? '$0' : `$${rentFor(v, i, diceSum)}`
    // give side: what leaves me — "breaks your set"; recv side: what
    // arrives — "completes your set". Both are computed for MY post-trade
    // holdings, and both are always base rent (trades never carry buildings).
    const flag = which === 'give' ? breaksSetCopy(v, i) : completesSetCopy(v, i)
    return deedChip(v, i, { act: which === 'give' ? 'toggleGiveSpace' : 'toggleRecvSpace', sel, value, flag })
  }
  const html = spaces.map(([iStr]) => chip(Number(iStr), selected.includes(Number(iStr)))).join('')
  // the recv side keeps its empty-state hint; the give side never had one
  return which === 'recv' ? html || '<span class="hint">they own nothing</span>' : html
}

function composerJailHTML(side: 'give' | 'recv', sel: boolean): string {
  return `<button class="chip ${sel ? 'sel' : ''}" data-act="composerJail" data-args='{"side":"${side}"}'>Jail card</button>`
}

function composerRecvLabelHTML(v: PlayerView): string {
  const composer = getComposer()
  const partner = composer ? partnerPlayer(v, composer.partner) : null
  return partner ? `${avathumb(partner)}${esc(partner.name)} gives` : 'They give'
}

// The send row renders exactly what allowedActions says: proposing is
// the only thing a freeze takes away, so during one the button is
// disabled with the freeze reason — the draft itself is never lost.
function composerSendRowHTML(v: PlayerView): string {
  if (v.allowed.includes('proposeTrade')) return `<button class="big primary" data-act="sendTrade">Send offer</button>`
  return `<button class="big" disabled>Trades pause until this settles</button>`
}

function composerSheetHTML(v: PlayerView): string {
  const C = getComposer()
  if (!C) return ''
  const I = meOf(v)
  const partner = partnerPlayer(v, C.partner)
  return `
      <h3>Propose a trade</h3>
      <label>Trade with</label>
      <div class="row" data-cp="partners">${composerPartnersRowHTML(v)}</div>
      <label>You give</label>
      <div class="chips" data-cp="giveChips">${composerChipsHTML(v, I.id, C.giveSpaces, 'give')}</div>
      <div class="row" data-cp="giveRow">
        <input data-k="giveCash" type="number" inputmode="numeric" min="0" value="${C.giveCash}" placeholder="cash up to $${I.cash}" />
        ${I.jailCards > 0 ? composerJailHTML('give', C.giveJail > 0) : ''}
      </div>
      <label data-cp="recvLabel">${composerRecvLabelHTML(v)}</label>
      <div class="chips" data-cp="recvChips">${composerChipsHTML(v, C.partner, C.recvSpaces, 'recv')}</div>
      <div class="row" data-cp="recvRow">
        <input data-k="recvCash" type="number" inputmode="numeric" min="0" value="${C.recvCash}" placeholder="cash up to $${partner?.cash ?? 0}" />
        ${(partner?.jailCards ?? 0) > 0 ? composerJailHTML('recv', C.recvJail > 0) : ''}
      </div>
      <div class="row" data-cp="sendRow">${composerSendRowHTML(v)}<button class="big" data-act="closeTrade">Cancel</button></div>`
}

// ── the More sheet (chrome-mounted) ──
// The dock's ⋯: the three phone utilities. Theme and the sound ding
// toggle imperatively (a label patch in place, no render needed); Leave
// is the one destructive row, styled var(--bad) — which passes AA; the
// old #e15b5b is retired. Sheet content only — mountSheet wraps it.
function moreSheetHTML(): string {
  return `
        <button class="menu-item" data-act="theme">
          <span class="mi-label" data-mi="theme">${getTheme() === 'light' ? '🌙 Dark theme' : '☀️ Light theme'}</span>
          <span class="mi-hint">Switch the look of this phone</span>
        </button>
        <button class="menu-item" data-act="dingToggle">
          <span class="mi-label" data-mi="ding">${getDingOn() ? '🔔 Sound ding on' : '🔇 Sound ding off'}</span>
          <span class="mi-hint">The chime when the game waits on you</span>
        </button>
        <div class="menu-sep"></div>
        <button class="menu-item danger" data-act="leave">
          <span class="mi-label">Leave the game</span>
          <span class="mi-hint">Two confirmations — your estate goes under the hammer</span>
        </button>`
}

// Fully static except the two toggle labels — patch exactly those.
function patchMore(el: HTMLElement): void {
  const themeLabel = el.querySelector('[data-mi="theme"]') as HTMLElement | null
  if (themeLabel) {
    const want = getTheme() === 'light' ? '🌙 Dark theme' : '☀️ Light theme'
    if (themeLabel.textContent !== want) themeLabel.textContent = want
  }
  const dingLabel = el.querySelector('[data-mi="ding"]') as HTMLElement | null
  if (dingLabel) {
    const want = getDingOn() ? '🔔 Sound ding on' : '🔇 Sound ding off'
    if (dingLabel.textContent !== want) dingLabel.textContent = want
  }
}

// ── the View-properties sheet (chrome-mounted) ──
// Every title deed in the game as one grid of full cards, filtered by owner
// and by kind (two chip rows, single-select each, AND-combined; re-tapping
// the selected chip clears it). Unfiltered it groups by board order under
// colour-run headings; filtered it's one flat grid. Cards show everything
// inline — only your own deeds carry the (server-gated) action buttons.
// Sheet content only — mountSheet wraps it; the chrome patcher re-emits
// it solely when the deedsSig board signature actually changes.
const GROUP_ORDER: ColorGroup[] = ['brown', 'lightblue', 'pink', 'orange', 'red', 'yellow', 'green', 'blue']

function deedsSheetHTML(v: PlayerView): string {
  const deedFilters = getDeedFilters()
  const ownable = Object.keys(v.props).length
  const ownedTotal = Object.values(v.props).filter((st) => st.owner != null).length
  const alive = v.players.filter((p) => !p.bankrupt)

  const ownerChips = [
    `<button class="chip ${deedFilters.owner === 'ALL' ? 'sel' : ''}" data-act="deedOwner" data-args='{"owner":"ALL"}'>All</button>`,
    ...alive.map(
      (p) =>
        `<button class="chip ${deedFilters.owner === p.id ? 'sel' : ''}" ${deedFilters.owner === p.id ? `style="border-color:${p.color}"` : ''} data-act="deedOwner" data-args='{"owner":"${p.id}"}'>${avathumb(p)}${esc(p.name)}</button>`,
    ),
    `<button class="chip ${deedFilters.owner === 'UNOWNED' ? 'sel' : ''}" data-act="deedOwner" data-args='{"owner":"UNOWNED"}'>Unowned</button>`,
  ].join('')
  const kindChips = [
    ...GROUP_ORDER.map(
      (g) =>
        `<button class="chip ${deedFilters.kind === g ? 'sel' : ''}" style="--g:${GROUP_COLORS[g]}" data-act="deedKind" data-args='{"kind":"${g}"}"><span class="dstrip"></span>${GROUP_LABEL[g]}</button>`,
    ),
    `<button class="chip ${deedFilters.kind === 'rail' ? 'sel' : ''}" style="--g:${KIND_COLORS.rail}" data-act="deedKind" data-args='{"kind":"rail"}"><span class="dstrip"></span>Railroads</button>`,
    `<button class="chip ${deedFilters.kind === 'utility' ? 'sel' : ''}" style="--g:${KIND_COLORS.utility}" data-act="deedKind" data-args='{"kind":"utility"}"><span class="dstrip"></span>Utilities</button>`,
  ].join('')

  const matches = Object.keys(v.props)
    .map(Number)
    .sort((a, b) => a - b) // board order — colour runs stay together
    .filter((i) => {
      const sp = BOARD[i]
      const st = v.props[i]
      const kindOk =
        deedFilters.kind === 'ALL' || (isStreet(sp) ? sp.group === deedFilters.kind : sp.kind === deedFilters.kind)
      const ownerOk =
        deedFilters.owner === 'ALL' ||
        (deedFilters.owner === 'UNOWNED' ? st.owner == null : st.owner === deedFilters.owner)
      return kindOk && ownerOk
    })

  // one grid cell: the pure-display deed card, with the (server-gated)
  // manage buttons composed BELOW it — never baked into the component
  const cell = (i: number): string => {
    const btns = manageButtons(v, v.you, i)
    return `${deedFull(v, i, avathumb)}${btns.length > 0 ? `<div class="deed-actions row">${btns.join('')}</div>` : ''}`
  }

  let grid = ''
  if (matches.length === 0) {
    const emptyMsg =
      deedFilters.owner === 'UNOWNED' && deedFilters.kind === 'ALL'
        ? 'Every property has an owner.'
        : 'Nothing matches.'
    grid = `<p class="hint deeds-empty">${emptyMsg}</p><div class="row"><button class="wide" data-act="deedClearFilters">Clear filters</button></div>`
  } else if (deedFilters.owner === 'ALL' && deedFilters.kind === 'ALL') {
    // unfiltered: group by board order with a heading per colour run
    const buckets: Array<{ key: string; heading: string; items: number[] }> = []
    for (const i of matches) {
      const sp = BOARD[i]
      const key = isStreet(sp) ? sp.group : sp.kind
      const heading = isStreet(sp)
        ? `${GROUP_LABEL[sp.group]} · ${groupIndices(sp.group).length}`
        : sp.kind === 'rail'
          ? 'Railroads'
          : 'Utilities'
      const last = buckets[buckets.length - 1]
      if (last && last.key === key) last.items.push(i)
      else buckets.push({ key, heading, items: [i] })
    }
    grid = buckets
      .map(
        (b) =>
          `<div class="deed-h">${esc(b.heading)}</div><div class="deedgrid">${b.items.map((i) => cell(i)).join('')}</div>`,
      )
      .join('')
  } else {
    grid = `<div class="deedgrid">${matches.map((i) => cell(i)).join('')}</div>`
  }

  return `
      <div class="deeds-head">
        <h3>PROPERTIES · ${ownedTotal}/${ownable}</h3>
        <button class="deeds-x" data-act="closeDeeds" aria-label="Close">✕</button>
      </div>
      <div class="chips">${ownerChips}</div>
      <div class="chips kind-chips">${kindChips}</div>
      ${grid}`
}

// Signatures of the last-applied patch, so unchanged pushes cost zero
// DOM writes (and the deeds grid's scrollTop survives them untouched).
let composerSigLast = ''
let deedsSigLast = ''

// ── composer: what its chip regions depend on ──
// The cash INPUTS are deliberately absent from this signature — typing
// changes composer.giveCash/recvCash only, so a push mid-typing finds the
// signature unchanged and performs ZERO DOM writes on the sheet. The chip
// markup (pips, MORTGAGED markers, rent-now values, set flags) reads
// houses + mortgage state too, so those ride along per space.
function composerSig(v: PlayerView): string {
  const C = getComposer()
  if (!C) return ''
  const partner = partnerPlayer(v, C.partner)
  const spacesOf = (pid: string): string[] =>
    Object.entries(v.props)
      .filter(([, st]) => st.owner === pid)
      .map(([i, st]) => `${i}:${st.houses}:${st.mortgaged ? 1 : 0}`)
      .sort()
  return JSON.stringify({
    partners: v.players.filter((p) => !p.bankrupt && p.id !== v.you).map((p) => `${p.id}:${p.jailCards}`),
    partner: C.partner,
    my: spacesOf(v.you),
    their: spacesOf(C.partner),
    give: C.giveSpaces,
    recv: C.recvSpaces,
    myJail: meOf(v).jailCards,
    theirJail: partner?.jailCards ?? 0,
    giveJail: C.giveJail,
    recvJail: C.recvJail,
    // dice ride the signature: a utility chip's rent-now is the dice
    // product, so a roll landing while the composer is open must re-patch
    // it (final council re-review of the deed component)
    dice: v.dice ? v.dice.join(',') : '',
    // the send row follows allowedActions (freeze gray-out)
    canTrade: v.allowed.includes('proposeTrade'),
  })
}

// A jail-card chip sits BESIDE an input inside its row: toggle the class
// in place when only the selection changed, insert/remove when presence
// changed — the input node next to it is never recreated.
function patchJailButton(row: HTMLElement | null, side: 'give' | 'recv', present: boolean, sel: boolean): void {
  if (!row) return
  const btn = row.querySelector('[data-act="composerJail"]') as HTMLElement | null
  if (btn && present) {
    btn.classList.toggle('sel', sel)
    return
  }
  if (btn && !present) {
    btn.remove()
    return
  }
  const input = row.querySelector('input[data-k]') as HTMLElement | null
  if (!btn && present && input) input.insertAdjacentHTML('afterend', composerJailHTML(side, sel))
}

// Patch every mutable region EXCEPT the inputs: chip rows and the recv
// label get innerHTML swaps, the jail buttons are re-pointed around the
// untouched input nodes. No code path here writes to an <input> — that
// is the acceptance headline, structurally.
function patchComposer(el: HTMLElement, v: PlayerView): void {
  const C = getComposer()
  if (!C) return
  const region = (name: string): HTMLElement | null => el.querySelector(`[data-cp="${name}"]`)
  const partners = region('partners')
  if (partners) partners.innerHTML = composerPartnersRowHTML(v)
  const giveChips = region('giveChips')
  if (giveChips) giveChips.innerHTML = composerChipsHTML(v, v.you, C.giveSpaces, 'give')
  const recvChips = region('recvChips')
  if (recvChips) recvChips.innerHTML = composerChipsHTML(v, C.partner, C.recvSpaces, 'recv')
  const recvLabel = region('recvLabel')
  if (recvLabel) recvLabel.innerHTML = composerRecvLabelHTML(v)
  patchJailButton(region('giveRow'), 'give', meOf(v).jailCards > 0, C.giveJail > 0)
  patchJailButton(region('recvRow'), 'recv', (partnerPlayer(v, C.partner)?.jailCards ?? 0) > 0, C.recvJail > 0)
  const sendRow = region('sendRow')
  if (sendRow) sendRow.innerHTML = `${composerSendRowHTML(v)}<button class="big" data-act="closeTrade">Cancel</button>`
}

// ── deeds: what the grid depends on ──
// The board (owner+houses+mortgaged per space), the viewer's affordances
// (the per-card manage buttons are server-gated via allowed), the alive
// seats (owner chips), and the active filters. Anything else — a roll, a
// bid, a cash move — leaves the sheet completely untouched: scroll and
// any in-flight tap survive as-is.
function deedsSig(v: PlayerView): string {
  const props = Object.keys(v.props)
    .map(Number)
    .sort((a, b) => a - b)
    .map((i) => {
      const st = v.props[i]
      return `${i}:${st.owner ?? '-'}:${st.houses}:${st.mortgaged ? 1 : 0}`
    })
    .join(',')
  const deedFilters = getDeedFilters()
  return `${props}|${v.allowed.join(',')}|${v.players.map((p) => (p.bankrupt ? '1' : '0')).join('')}|${deedFilters.owner}~${deedFilters.kind}`
}

// ── the dock (chrome-mounted, game-only) ──
// The hamburger's replacement: four permanent tools fixed to the bottom.
// It sits ABOVE sheets (z30 over z20) so Board/Deeds stay tappable
// mid-sheet — that is how you price a bid inside the 15-second window —
// and under the opaque board overlay. Everything it shows about
// affordances comes straight from allowedActions.
function updateDock(v: PlayerView | null): void {
  let el = document.getElementById('dock')
  if (!v) {
    el?.remove()
    return
  }
  if (!el) {
    const nav = document.createElement('nav')
    nav.id = 'dock'
    nav.setAttribute('aria-label', 'Game tools')
    nav.innerHTML = `
      <button class="dockbtn" data-act="showBoard" aria-label="Board">
        <span class="db-ic">🎲</span><span class="db-t">Board</span>
      </button>
      <button class="dockbtn" data-dockbtn="deeds" data-act="openDeeds" aria-label="Deeds">
        <span class="db-ic">🏠</span><span class="db-t">Deeds</span>
        <span class="dock-badge" data-dock="deedBadge"></span>
      </button>
      <button class="dockbtn" data-dockbtn="trade" data-act="openTrade" aria-label="Trade">
        <span class="db-ic">🔁</span><span class="db-t" data-dock="tradeLabel">Trade</span>
        <span class="dock-badge" data-dock="tradeBadge"></span>
      </button>
      <button class="dockbtn" data-dockbtn="more" data-act="openMore" aria-label="More">
        <span class="db-ic">⋯</span><span class="db-t">More</span>
      </button>`
    $chrome.appendChild(nav)
    el = nav
  }
  const I = meOf(v)
  const acts = new Set(v.allowed)

  // Deeds badge = your owned count
  const owned = Object.values(v.props).filter((st) => st.owner === I.id).length
  const deedBadge = el.querySelector('[data-dock="deedBadge"]') as HTMLElement | null
  if (deedBadge) {
    deedBadge.textContent = owned > 0 ? String(owned) : ''
    deedBadge.classList.toggle('zero', owned === 0)
  }

  // Trade badge = incoming offers to you
  const incoming = v.trades.filter((t) => t.to === I.id).length
  const tradeBadge = el.querySelector('[data-dock="tradeBadge"]') as HTMLElement | null
  if (tradeBadge) {
    tradeBadge.textContent = incoming > 0 ? String(incoming) : ''
    tradeBadge.classList.toggle('zero', incoming === 0)
  }

  // The Trade affordance is exactly what allowedActions says: proposing
  // is the only thing a freeze takes away, and decline/withdraw
  // deliberately survive freezes — so the button grays (with the freeze
  // reason) only while ALL THREE are off. A bankrupt seat never trades
  // again; its caption says so honestly.
  const frozenOut = !acts.has('proposeTrade') && !acts.has('respondTrade') && !acts.has('cancelTrade')
  const tradeBtn = el.querySelector('[data-dockbtn="trade"]') as HTMLButtonElement | null
  const tradeLabel = el.querySelector('[data-dock="tradeLabel"]') as HTMLElement | null
  if (tradeBtn && tradeLabel) {
    tradeBtn.disabled = frozenOut
    tradeBtn.classList.toggle('frozen', frozenOut)
    const want = frozenOut
      ? I.bankrupt || v.phase === 'GAME_OVER'
        ? 'Spectating'
        : 'Trades pause until this settles'
      : 'Trade'
    if (tradeLabel.textContent !== want) tradeLabel.textContent = want
  }

  // the active sheet's button
  const mark = (sel: string, on: boolean): void => {
    const b = el!.querySelector(sel) as HTMLElement | null
    b?.classList.toggle('on', on)
  }
  mark('[data-dockbtn="deeds"]', getSheet() === 'deeds')
  mark('[data-dockbtn="trade"]', getSheet() === 'composer')
  mark('[data-dockbtn="more"]', getSheet() === 'more')
}

// ── the your-move bar (chrome-mounted) ──
// The escape hatch, never a second messenger: while a sheet or the pocket
// board covers the action card AND the game waits on THIS phone, a gold
// bar says exactly what the main flow would. Tap = close the cover,
// scroll the action card into view, pulse it. The server reports exactly
// one blocking decision, so the bar never arbitrates between waits; an
// incoming trade is NOT a bar case — it rides the Trade badge.
const BAR_COPY: Record<WaitingKind, string> = {
  roll: 'YOUR MOVE — Roll the dice',
  draw: 'Draw your card',
  buy: 'Buy or send to auction',
  tax: 'Choose your tax',
  end: 'End your turn',
  jail: 'Go to jail',
  debt: 'Pay or raise the money',
  auc: 'Bid or pass',
}

function barCase(v: PlayerView): string | null {
  const w = v.waitingOn
  if (!w) return null
  const I = meOf(v)
  if (I.bankrupt) return null
  if (w.playerId === v.you) return BAR_COPY[w.kind]
  // auctions wait on the whole table: the bar shows only while THIS phone
  // can still bid or pass
  if (w.kind === 'auc' && w.playerId === null && (v.allowed.includes('bid') || v.allowed.includes('passBid'))) {
    return BAR_COPY.auc
  }
  return null
}

function updateMoveBar(v: PlayerView | null): void {
  const copy = v ? barCase(v) : null
  let el = document.getElementById('movebar') as HTMLButtonElement | null
  if (!v || !copy || (getSheet() == null && getPhoneBoard() == null)) {
    el?.remove()
    return
  }
  if (!el) {
    const bar = document.createElement('button')
    bar.id = 'movebar'
    bar.dataset.act = 'barJump'
    bar.innerHTML = `<span id="barCopy">${copy}</span>${v.deadline != null ? `<span id="barCount" data-until="${v.deadline}"></span>` : ''}`
    $chrome.appendChild(bar)
    return
  }
  // patch in place — a tap in flight on the bar must land
  const copyEl = document.getElementById('barCopy') as HTMLElement | null
  if (copyEl && copyEl.textContent !== copy) copyEl.textContent = copy
  let tailEl = document.getElementById('barCount') as HTMLElement | null
  if (v.deadline != null) {
    if (!tailEl) copyEl?.insertAdjacentHTML('afterend', `<span id="barCount" data-until="${v.deadline}"></span>`)
    else if (Number(tailEl.dataset.until ?? 0) !== v.deadline) tailEl.dataset.until = String(v.deadline)
  } else if (tailEl) {
    tailEl.remove()
  }
}

// THE entry point renderGame calls after rebuilding $app. v == null (no
// game view) tears the dock, the bar and every sheet down — the game-only
// chrome dies with the game view.
export function updateChrome(v: PlayerView | null): void {
  // a dying game view must never leave a locked body or a stale sheet
  if (v == null && getSheet()) {
    setSheet(null)
    sheetFocusSaved = null
    delete document.body.dataset.sheet
  }
  // defensive: a composer sheet without draft data is nothing at all
  if (v != null && getSheet() === 'composer' && getComposer() == null) setSheet(null)
  updateDock(v)

  for (const kind of SHEET_KINDS) {
    const el = document.getElementById(SHEET_IDS[kind])
    const wanted = v != null && getSheet() === kind && (kind !== 'composer' || getComposer() != null)
    if (!wanted) {
      if (el) {
        el.remove()
        if (kind === 'composer') composerSigLast = ''
        if (kind === 'deeds') deedsSigLast = ''
      }
      continue
    }
    const vv = v as PlayerView
    if (!el) {
      mountSheet(SHEET_IDS[kind], SHEET_CLASSES[kind], sheetHTMLFor(kind, vv), SHEET_CLOSE_ACTS[kind], SHEET_LABELS[kind])
      if (kind === 'composer') composerSigLast = composerSig(vv)
      if (kind === 'deeds') deedsSigLast = deedsSig(vv)
    } else if (kind === 'deeds') {
      const sig = deedsSig(vv)
      if (sig !== deedsSigLast) {
        // the board, the affordances or the filters actually changed: one
        // re-emit of the sheet content (badges, owner labels and the head
        // count are all derived from that same signature)
        const sh = el.querySelector('.sheet') as HTMLElement
        sh.innerHTML = deedsSheetHTML(vv)
        deedsSigLast = sig
      }
      // sig unchanged → the grid (and its scroll) is left completely alone
    } else if (kind === 'composer') {
      const sig = composerSig(vv)
      if (sig !== composerSigLast) {
        patchComposer(el, vv)
        composerSigLast = sig
      }
      // sig unchanged → zero DOM writes: focus, caret and text untouched
    } else {
      patchMore(el)
    }
  }

  updateMoveBar(v)
}
