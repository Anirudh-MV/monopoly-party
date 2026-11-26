// ── Controller shared surface ──
// The DOM roots and the pure helpers every controller module uses: esc,
// avathumb, the viewer/partner lookups, the title-deed affordance helpers
// (the shared gate both the portfolio and the deeds sheet render through),
// the countdown ticker, and toasts (used by the net, actions and overlay
// layers alike — a leaf here rather than an overlay, so no module cycles).

import { BOARD, groupIndices, isStreet } from '../../shared/board.js'
import { TOKENS } from '../../shared/tokens.js'
import { avatarThumbnail } from '../tokens3d.js'
import { canBuildOn, canMortgageOn, canSellHouseOn, canUnmortgageOn, unmortgageCost } from '../../shared/rules.js'
import type { PlayerView, Space } from '../../shared/types.js'

export const $app = document.getElementById('app') as HTMLElement
// The patch-managed layer: a SIBLING of $app (renderGame rebuilds all of
// $app via innerHTML on every server push; the sheets that must survive
// those rebuilds mount here and are patched in place).
export const $chrome = document.getElementById('chrome') as HTMLElement

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

// the player's 3D avatar in their chosen colour — replaces the emoji
// beside every name in the game (thumbnails are cached per model+colour)
export function avathumb(p?: { token: string; color: string } | null): string {
  if (!p) return ''
  if (!TOKENS.includes(p.token)) return `${esc(p.token)} `
  return `<img class="avathumb" src="${avatarThumbnail(TOKENS.indexOf(p.token), p.color)}" alt="${esc(p.token)}" draggable="false" /> `
}

export function toast(msg: string): void {
  const t = document.createElement('div')
  t.className = 'toast'
  t.textContent = msg
  document.body.appendChild(t)
  setTimeout(() => t.remove(), 2600)
}

export function meOf(v: PlayerView | null) {
  return v?.players.find((p) => p.id === v.you) ?? { id: '', name: '', color: '', token: '', cash: 0, pos: 0, jail: false, jailRolls: 0, jailCards: 0, jailReason: null, bankrupt: false, connected: false }
}
export function partnerPlayer(v: PlayerView | null, pid: string) {
  return v?.players.find((p) => p.id === pid)
}

// Countdown ticker — updates every countdown surface in place so a
// running timer never re-renders (and never steals focus from inputs).
// Three surfaces share it: the last-30s own-decision chip, the your-move
// bar's tail, and the spectator banner tail.
export function clockFmt(rem: number): string {
  return `${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, '0')}`
}
setInterval(() => {
  const tick = (id: string, fmt: (rem: number) => string): void => {
    const el = document.getElementById(id) as HTMLElement | null
    if (!el) return
    const until = Number(el.dataset.until ?? 0)
    const rem = Math.max(0, Math.ceil((until - Date.now()) / 1000))
    const span = el.querySelector('span') ?? el
    span.textContent = fmt(rem)
    // the last-10s urgency marks the whole control (the bar button, the chip)
    ;(el.closest('button') ?? el).classList.toggle('urgent', rem <= 10)
  }
  tick('deadlineChip', (r) => `${r}s`)
  tick('barCount', (r) => ` — ${r}s`)
  tick('waitTail', (r) => ` — ${clockFmt(r)}`)
}, 250)

// ── the title deed ──
// ONE component now (src/client/deed-card.ts), shared with the TV: the
// full rent ladder with exactly one is-now row, mortgage math, the owner
// and set progress. deedFull is pure display — never a button, never any
// baked-in actions. The deeds grid composes manageButtons BELOW the
// returned card (a .deed-actions row); every other surface is read-only.

// The per-viewer "would make N/M" copy for a purchase decision (buy
// prompt / auction): counted on THIS phone's holdings, and when the
// purchase would complete the viewer's set, said in money.
export function wouldMakeCopy(v: PlayerView, i: number): string {
  const sp = BOARD[i]
  if (!('price' in sp)) return ''
  if (isStreet(sp)) {
    const set = groupIndices(sp.group)
    const have = set.filter((j) => v.props[j].owner === v.you).length // the space itself is unowned here
    if (have + 1 === set.length) return `base $${sp.rents[0]} - doubles to $${sp.rents[0] * 2} for you`
    return `would make ${have + 1}/${set.length} in the set`
  }
  if (sp.kind === 'rail') {
    const n = [5, 15, 25, 35].filter((j) => v.props[j].owner === v.you).length
    return `would make ${n + 1}/4 railroads`
  }
  const n = [12, 28].filter((j) => v.props[j].owner === v.you).length
  return `would make ${n + 1}/2 utilities`
}

// Trade flags: the doubled delta computed for the recipient's post-trade
// holdings, and the symmetric break on the giving side. Trades never carry
// buildings (the engine refuses), so the delta is always base rent.
export function completesSetCopy(v: PlayerView, i: number): string {
  const sp = BOARD[i]
  if (!isStreet(sp)) return ''
  const set = groupIndices(sp.group)
  const have = set.filter((j) => j !== i && v.props[j].owner === v.you).length
  if (have !== set.length - 1) return ''
  return `$${sp.rents[0]} -> $${sp.rents[0] * 2} when this completes your set`
}

export function breaksSetCopy(v: PlayerView, i: number): string {
  const sp = BOARD[i]
  if (!isStreet(sp)) return ''
  const set = groupIndices(sp.group)
  if (!set.every((j) => v.props[j].owner === v.you)) return ''
  return `breaks your set - $${sp.rents[0] * 2} -> $${sp.rents[0]}`
}

// A portfolio's management buttons — THE gate: they render exactly when the
// server's allowed list plus the shared rules checks agree. renderPortfolio
// and the deeds grid both call this, so neither can drift from the engine.
export function manageButtons(v: PlayerView, pid: string, i: number): string[] {
  const sp: Space = BOARD[i]
  const acts = new Set(v.allowed)
  const btns: string[] = []
  if (acts.has('buyHouse') && canBuildOn(v, pid, i)) btns.push(`<button class="tiny" data-act="buyHouse" data-args='{"space":${i}}'>House +$${isStreet(sp) ? sp.houseCost : ''}</button>`)
  if (acts.has('sellHouse') && canSellHouseOn(v, pid, i)) btns.push(`<button class="tiny" data-act="sellHouse" data-args='{"space":${i}}'>Sell house +$${isStreet(sp) ? sp.houseCost / 2 : ''}</button>`)
  if (acts.has('mortgage') && canMortgageOn(v, pid, i)) btns.push(`<button class="tiny" data-act="mortgage" data-args='{"space":${i}}'>Mortgage +$${('price' in sp ? sp.price : 0) / 2}</button>`)
  if (acts.has('unmortgage') && canUnmortgageOn(v, pid, i)) btns.push(`<button class="tiny" data-act="unmortgage" data-args='{"space":${i}}'>Unmortgage −$${unmortgageCost('price' in sp ? sp.price : 0)}</button>`)
  return btns
}
