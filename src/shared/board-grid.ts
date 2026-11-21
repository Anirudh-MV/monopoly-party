// ── 2D board grid helpers ──
// Shared by the simulator page (and any future 2D view). The TV is fully
// 3D (board3d.ts) and doesn't use these.

import { BOARD, GROUP_COLORS, isStreet } from './board.js'
import type { Space } from './types.js'

export function gridPos(i: number): { r: number; c: number } {
  if (i === 0) return { r: 11, c: 11 }
  if (i < 10) return { r: 11, c: 11 - i }
  if (i === 10) return { r: 11, c: 1 }
  if (i < 20) return { r: 11 - (i - 10), c: 1 }
  if (i === 20) return { r: 1, c: 1 }
  if (i < 30) return { r: 1, c: 1 + (i - 20) }
  if (i === 30) return { r: 1, c: 11 }
  return { r: 1 + (i - 30), c: 11 }
}

export function regionOf(i: number): string {
  if (i <= 10) return 'bottom'
  if (i <= 20) return 'left'
  if (i <= 30) return 'top'
  return 'right'
}

export function cellHTML(i: number, sp: Space): string {
  if (isStreet(sp)) {
    return `<div class="bar" style="background:${GROUP_COLORS[sp.group]}"></div>
      <div class="nm">${sp.name}</div><div class="pr">$${sp.price}</div>
      <div class="marks"></div><div class="toks"></div>`
  }
  switch (sp.kind) {
    case 'rail':
      return `<div class="bar rail"></div><div class="nm">Railroad: ${sp.name}</div><div class="pr">$${sp.price}</div><div class="marks"></div><div class="toks"></div>`
    case 'utility':
      return `<div class="bar util"></div><div class="nm">${sp.name.includes('Electric') ? 'Electric' : 'Water'}: ${sp.name}</div><div class="pr">$${sp.price}</div><div class="marks"></div><div class="toks"></div>`
    case 'go':
      return `<div class="corner">GO<div class="sub">collect $200</div></div><div class="toks"></div>`
    case 'jail':
      return `<div class="corner">Jail<div class="sub">just visiting</div></div><div class="toks"></div>`
    case 'parking':
      return `<div class="corner">P<div class="sub">free parking</div></div><div class="toks"></div>`
    case 'gotojail':
      return `<div class="corner">Go To Jail<div class="sub">straight ahead</div></div><div class="toks"></div>`
    case 'chance':
      return `<div class="nm">Chance</div><div class="marks"></div><div class="toks"></div>`
    case 'chest':
      return `<div class="nm">Community Chest</div><div class="marks"></div><div class="toks"></div>`
    case 'tax':
      return `<div class="nm">${sp.name}</div><div class="pr">${sp.percent ? 'flat or 10%' : `$${sp.flat}`}</div><div class="marks"></div><div class="toks"></div>`
    default:
      return ''
  }
}
