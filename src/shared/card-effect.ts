// ── Card effect copy + debt why-math ──
// ONE source for the Chance/Chest result line and the rent-debt "why",
// shared by the phone controller and the TV host so the two can never
// drift — and asserted byte-exact by the scenario suite, so the copy
// itself is the contract.
//
// The goto lines are deliberately STATIC ("collect $200 if you pass GO"):
// by the time a card is revealed the goto has already executed, so the
// computed GO+$200 example is uncomputable at reveal time. ch3's card
// text omits the GO clause; this copy always carries it. ch13 (the trip
// to the railroad) is a GOTO, not a nearest: it charges NORMAL railroad
// rent, so its copy never mentions doubling.
//
// Dynamic lines (repairs totals, pay-each player counts) are computed
// from the view at draw time; both clients freeze the result once per
// cardDrawSeq so a repairs bill can never shrink mid-reveal while a
// 90s raise-funds window mutates the estate.

import { BOARD, isStreet } from './board.js'
import { alivePlayers, countOwned, debtBlurb, ownedSpaces, ownsGroup } from './rules.js'
import type { Card, RulesState } from './types.js'

export interface DebtLike {
  debtor: string
  amount: number
  creditor: string | null
  memo?: string
}

// The Chance/Chest result line. Returns undefined for Get Out of Jail
// Free — the card face's keep-or-trade note covers it (no effect line).
export function cardEffectLine(card: Card, v: RulesState, drawerId: string): string | undefined {
  const e = card.effect
  switch (e.kind) {
    case 'money':
      return `+$${e.amount} from the bank`
    case 'pay':
      return `-$${e.amount} to the bank`
    case 'payEach': {
      const n = alivePlayers(v).filter((p) => p.id !== drawerId).length
      return `-$${e.amount} x ${n} player${n > 1 ? 's' : ''} = -$${e.amount * n}`
    }
    case 'collectEach': {
      const n = alivePlayers(v).filter((p) => p.id !== drawerId).length
      return `+$${e.amount} x ${n} player${n > 1 ? 's' : ''} = +$${e.amount * n}`
    }
    case 'repairs': {
      let total = 0
      for (const i of ownedSpaces(v, drawerId)) {
        const sp = BOARD[i]
        if (!isStreet(sp)) continue
        const h = v.props[i].houses
        total += h === 5 ? e.perHotel : h * e.perHouse
      }
      return `Bill: $${total} ($${e.perHouse} per house, $${e.perHotel} per hotel)`
    }
    case 'goto':
      return e.target === 0 ? '-> GO - collect $200' : `-> ${BOARD[e.target].name} - collect $200 if you pass GO`
    case 'move':
      return e.steps < 0
        ? `-> ${Math.abs(e.steps)} space${Math.abs(e.steps) > 1 ? 's' : ''} back`
        : `-> ${e.steps} space${e.steps > 1 ? 's' : ''} forward`
    case 'nearest':
      // The nearest-rail doubling is real (the engine charges 2x) but the
      // card text never says so. The nearest-utility read is ALWAYS 10x:
      // utilMult bypasses the ownership count, so never "if both owned".
      return e.target === 'rail'
        ? '-> nearest railroad - pay double rent if owned'
        : '-> nearest utility - 10x a fresh dice roll if owned'
    case 'gotojail':
      return '-> straight to Jail - no $200 for passing GO'
    case 'jailcard':
      return undefined
  }
}

// WHY a debt exists — recomputed from live state, never parsed from the
// memo. Why-math appears only on Rent: memos; card debts keep the
// debtBlurb text. The Chance nearest-utility charge reads 10x regardless
// of the ownership count (utilMult bypasses it): distinguishable from
// state exactly because amount != diceSum * (count === 2 ? 10 : 4).
export function debtWhy(v: RulesState, d: DebtLike): string {
  if (!d.memo?.startsWith('Rent: ')) return debtBlurb(d)
  const name = d.memo.slice(6)
  const i = BOARD.findIndex((sp) => sp.name === name)
  if (i < 0) return debtBlurb(d)
  const sp = BOARD[i]
  const st = v.props[i]
  if (!st?.owner || !('price' in sp)) return debtBlurb(d)
  if (isStreet(sp)) {
    if (st.houses === 5) return 'hotel'
    if (st.houses > 0) return `${st.houses} house${st.houses > 1 ? 's' : ''}`
    return ownsGroup(v, st.owner, sp.group) ? 'full set' : 'base rent'
  }
  if (sp.kind === 'rail') {
    const n = countOwned(v, st.owner, 'rail')
    return `${n} railroad${n > 1 ? 's' : ''} owned`
  }
  if (sp.kind === 'utility') {
    const diceSum = v.dice ? v.dice[0] + v.dice[1] : 0
    if (diceSum <= 0) return debtBlurb(d)
    const n = countOwned(v, st.owner, 'utility')
    const stateMult = n === 2 ? 10 : 4
    const mult = d.amount === diceSum * stateMult ? stateMult : 10
    return `${mult}x your ${diceSum} = $${d.amount}`
  }
  return debtBlurb(d)
}
