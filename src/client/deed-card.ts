// ── ONE title-deed component, three variants ──
// deedFull: the whole card (rent ladder with exactly one is-now row,
//           mortgage math, owner + set progress) — pure display, never a
//           button; callers compose action buttons BELOW it.
//           rows:'live' (the TV spotlight/auction surfaces) keeps only the
//           live row; an owned-and-mortgaged deed falls back to the full
//           dimmed ladder (never a hollow card), an unowned one carries a
//           single marked fallback Rent row.
// deedChip: compact swatch + name + group tag + pips + ONE caller-chosen
//           number. A <button> only when the caller passes act (phones);
//           the TV has no click delegation, so it always gets <span>s.
// cardFace: the Chance / Community Chest face with the caller-computed
//           effect line.
// Ladder per the council amendments: Rent / Rent with full set as two
// rows (one marked now), Hotel as the last row (rents[5]) — the HOTEL
// header badge from cade020 is retired. A mortgaged deed earns nothing:
// no now-marker, and the terms rows (Mortgage value / Unmortgage) stay
// fully readable through the hatch+dim.

import { BOARD, GROUP_COLORS, GROUP_LABEL, KIND_COLORS, groupIndices, isStreet } from '../shared/board.js'
import { unmortgageCost } from '../shared/rules.js'
import type { Card, PlayerState, RulesState, Space } from '../shared/types.js'

// PlayerView / HostView satisfy RulesState structurally
type DeedView = RulesState
type Avatar = (p: PlayerState) => string

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const lum = (hex: string): number => {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
// white vs ink (#111827): whichever contrasts more with the band
const INK = '#111827'
export const bandInk = (hex: string): string =>
  (1.05 / (lum(hex) + 0.05) >= (lum(hex) + 0.05) / (lum(INK) + 0.05) ? '#fff' : INK)

// the glyphs already in use on the TV standings (🚂 rail, 💡 utility)
function band(sp: Space): { bg: string; label: string; icon: string } {
  if (isStreet(sp)) return { bg: GROUP_COLORS[sp.group], label: GROUP_LABEL[sp.group], icon: '' }
  if (sp.kind === 'rail') return { bg: KIND_COLORS.rail, label: 'Railroad', icon: '🚂' }
  if (sp.kind === 'utility') return { bg: KIND_COLORS.utility, label: 'Utility', icon: '💡' }
  if (sp.kind === 'chance') return { bg: KIND_COLORS.chance, label: 'Chance', icon: '?' }
  if (sp.kind === 'chest') return { bg: KIND_COLORS.chest, label: 'Community Chest', icon: '' }
  if (sp.kind === 'tax') return { bg: '#64748b', label: 'Tax', icon: '' }
  return { bg: '#64748b', label: '', icon: '' }
}

const style = (bg: string): string => `--g:${bg};--gi:${bandInk(bg)}`

const peers = (sp: Space): number[] =>
  isStreet(sp) ? groupIndices(sp.group) : BOARD.flatMap((s, i) => (s.kind === sp.kind ? [i] : []))

const pips = (h: number): string =>
  h === 0
    ? ''
    : `<span class="deed-pips" role="img" aria-label="${h === 5 ? 'hotel' : `${h} house${h > 1 ? 's' : ''}`}">${h === 5 ? '<i class="hotel"></i>' : '<i></i>'.repeat(h)}</span>`

// ── variant 1: the full deed ──
export function deedFull(v: DeedView, i: number, avatar: Avatar, rows: 'all' | 'live' = 'all'): string {
  const sp = BOARD[i]
  if (!('price' in sp)) return ''
  const st = v.props[i]
  const b = band(sp)
  const owner = st.owner ? v.players.find((p) => p.id === st.owner) : undefined
  const set = peers(sp)
  const have = owner ? set.filter((j) => v.props[j].owner === owner.id).length : 0
  const live = owner && !st.mortgaged // a mortgaged deed earns nothing: no "now" row
  const r = (l: string, val: string, now = false, cls = ''): string =>
    `<div class="deed-row${now ? ' is-now' : ''}${cls ? ` ${cls}` : ''}"${now ? ' aria-current="true"' : ''}><dt>${l}</dt><dd>${val}</dd></div>`

  let ladder: string[] = []
  if (isStreet(sp)) {
    const tier = live ? st.houses : -1
    const full = have === set.length
    ladder = [
      r('Rent', `$${sp.rents[0]}`, tier === 0 && !full),
      r('Rent with full set', `$${sp.rents[0] * 2}`, tier === 0 && full),
      ...[1, 2, 3, 4].map((h) => r(`${h} house${h > 1 ? 's' : ''}`, `$${sp.rents[h]}`, tier === h)),
      r('Hotel', `$${sp.rents[5]}`, tier === 5),
    ]
  } else if (sp.kind === 'rail') {
    ladder = [25, 50, 100, 200].map((x, k) => r(`${k + 1} railroad${k ? 's' : ''} owned`, `$${x}`, !!live && have === k + 1))
  } else {
    ladder = [r('1 utility owned', '4 x dice', !!live && have === 1), r('Both owned', '10 x dice', !!live && have === 2)]
  }

  if (rows === 'live') {
    const nowRows = ladder.filter((x) => x.includes('is-now'))
    if (nowRows.length > 0) ladder = nowRows
    else if (!owner) {
      // unowned: exactly one marked row — the base rent (utilities print
      // the 4 x dice multiplier style, never a dollar figure)
      const val = isStreet(sp) ? `$${sp.rents[0]}` : sp.kind === 'rail' ? '$25' : '4 x dice'
      ladder = [r('Rent', val, true)]
    }
    // owned + mortgaged: no live row — keep the full dimmed/hatched
    // ladder (the MORTGAGED stamp carries the story), never a hollow card
  }

  const terms =
    rows === 'all'
      ? [
          isStreet(sp)
            ? r('House cost', `$${sp.houseCost} each <span class="deed-note">hotel = 4 houses + one more</span>`, false, 'deed-row--terms')
            : '',
          r('Mortgage value', `$${sp.price / 2}`, false, 'deed-row--terms'),
          r('Unmortgage', `$${unmortgageCost(sp.price)}`, false, 'deed-row--terms'),
        ].join('')
      : ''

  const foot = owner
    ? `${avatar(owner)}<b>${esc(owner.name)}</b><span class="deed-set" aria-label="${have} of ${set.length} in set">${'●'.repeat(have)}${'○'.repeat(set.length - have)} ${have}/${set.length}</span>`
    : '<span class="deed-bank">Bank · unowned</span>'

  return `<article class="deed deed--full${st.mortgaged ? ' is-mortgaged' : ''}${owner && have === set.length ? ' is-set' : ''}" style="${style(b.bg)}" aria-label="${esc(`${sp.name}, ${b.label}`)}">
  <header class="deed-band">${b.icon ? `<span class="deed-icon" aria-hidden="true">${b.icon}</span>` : ''}<span class="deed-tag">${b.label}</span><h4 class="deed-name">${esc(sp.name)}</h4>${pips(st.houses)}</header>
  <div class="deed-price">Price <b>$${sp.price}</b></div>
  <dl class="deed-rows">${ladder.join('')}${terms}</dl>
  ${st.mortgaged ? '<div class="deed-stamp">MORTGAGED</div>' : ''}
  <footer class="deed-foot">${foot}</footer>
</article>`
}

// ── variant 2: the compact chip ──
export interface ChipOpts {
  value?: string
  flag?: string
  act?: string
  sel?: boolean
  /** display-name override (the table abbreviates its scan chips) */
  name?: string
}

export function deedChip(v: DeedView, i: number, o: ChipOpts = {}): string {
  const sp = BOARD[i]
  const st = v.props[i]
  const b = band(sp)
  const tag = isStreet(sp) ? b.label : b.icon || b.label
  const el = o.act ? 'button' : 'span'
  return `<${el} class="deed deed--chip${st?.mortgaged ? ' is-mortgaged' : ''}${o.sel ? ' sel' : ''}" style="${style(b.bg)}"${o.act ? ` type="button" data-act="${o.act}" data-args='{"space":${i}}'` : ''}>
  <i class="deed-sw" aria-hidden="true"></i><span class="deed-cn">${esc(o.name ?? sp.name)}</span><span class="deed-ct">${esc(tag)}</span>${st ? pips(st.houses) : ''}${st?.mortgaged ? '<span class="deed-mtg">MORTGAGED</span>' : ''}${o.flag ? `<span class="deed-flag">${esc(o.flag)}</span>` : ''}${o.value ? `<b class="deed-cv">${esc(o.value)}</b>` : ''}
</${el}>`
}

// ── variant 3: the Chance / Community Chest face ──
export function cardFace(card: Card, effectLine?: string): string {
  const chest = card.deck === 'chest'
  const bg = chest ? KIND_COLORS.chest : KIND_COLORS.chance
  return `<article class="deed deed--card" style="${style(bg)}" aria-label="${chest ? 'Community Chest' : 'Chance'} card">
  <header class="deed-band">${chest ? '' : '<span class="deed-icon" aria-hidden="true">?</span>'}<span class="deed-tag">${chest ? 'Community Chest' : 'Chance'}</span><h4 class="deed-name">${chest ? 'COMMUNITY CHEST' : 'CHANCE'}</h4></header>
  <p class="deed-text">${esc(card.text)}</p>
  ${effectLine ? `<p class="deed-effect">${esc(effectLine)}</p>` : ''}
  ${card.effect.kind === 'jailcard' ? '<p class="deed-note deed-cardnote">Keep this card until needed, or trade it.</p>' : ''}
</article>`
}
