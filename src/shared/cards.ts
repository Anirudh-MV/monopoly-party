import type { Card } from './types.js'

// Official 16-card decks. Get Out of Jail Free cards are removed from the deck
// while held by a player, and returned to the bottom when used or on bankruptcy.
export const CHANCE_JAIL_CARD_ID = 'ch8'
export const CHEST_JAIL_CARD_ID = 'cc5'

export const ALL_CARDS: Card[] = [
  // ── Chance ──
  { id: 'ch1', deck: 'chance', text: 'Advance to GO. (Collect $200)', effect: { kind: 'goto', target: 0 } },
  { id: 'ch2', deck: 'chance', text: 'Advance to Illinois Avenue.', effect: { kind: 'goto', target: 24 } },
  { id: 'ch3', deck: 'chance', text: 'Advance to St. Charles Place.', effect: { kind: 'goto', target: 11 } },
  { id: 'ch4', deck: 'chance', text: 'Advance to the nearest Railroad.', effect: { kind: 'nearest', target: 'rail' } },
  { id: 'ch5', deck: 'chance', text: 'Advance to the nearest Railroad.', effect: { kind: 'nearest', target: 'rail' } },
  { id: 'ch6', deck: 'chance', text: 'Advance to the nearest Utility.', effect: { kind: 'nearest', target: 'utility' } },
  { id: 'ch7', deck: 'chance', text: 'Bank pays you dividend of $50.', effect: { kind: 'money', amount: 50 } },
  { id: 'ch8', deck: 'chance', text: 'Get Out of Jail Free.', effect: { kind: 'jailcard' } },
  { id: 'ch9', deck: 'chance', text: 'Go back 3 spaces.', effect: { kind: 'move', steps: -3 } },
  { id: 'ch10', deck: 'chance', text: 'Go directly to Jail.', effect: { kind: 'gotojail' } },
  { id: 'ch11', deck: 'chance', text: 'Make general repairs: pay $25 per house, $100 per hotel.', effect: { kind: 'repairs', perHouse: 25, perHotel: 100 } },
  { id: 'ch12', deck: 'chance', text: 'Speeding fine. Pay $15.', effect: { kind: 'pay', amount: 15 } },
  { id: 'ch13', deck: 'chance', text: 'Take a trip to Reading Railroad.', effect: { kind: 'goto', target: 5 } },
  { id: 'ch14', deck: 'chance', text: 'Take a walk on the Boardwalk.', effect: { kind: 'goto', target: 39 } },
  { id: 'ch15', deck: 'chance', text: 'Elected Chairman of the Board. Pay each player $50.', effect: { kind: 'payEach', amount: 50 } },
  { id: 'ch16', deck: 'chance', text: 'Your building loan matures. Collect $150.', effect: { kind: 'money', amount: 150 } },

  // ── Community Chest ──
  { id: 'cc1', deck: 'chest', text: 'Advance to GO. (Collect $200)', effect: { kind: 'goto', target: 0 } },
  { id: 'cc2', deck: 'chest', text: 'Bank error in your favor. Collect $200.', effect: { kind: 'money', amount: 200 } },
  { id: 'cc3', deck: 'chest', text: "Doctor's fee. Pay $50.", effect: { kind: 'pay', amount: 50 } },
  { id: 'cc4', deck: 'chest', text: 'From sale of stock you get $50.', effect: { kind: 'money', amount: 50 } },
  { id: 'cc5', deck: 'chest', text: 'Get Out of Jail Free.', effect: { kind: 'jailcard' } },
  { id: 'cc6', deck: 'chest', text: 'Go directly to Jail.', effect: { kind: 'gotojail' } },
  { id: 'cc7', deck: 'chest', text: 'Grand Opera Night. Collect $50 from every player.', effect: { kind: 'collectEach', amount: 50 } },
  { id: 'cc8', deck: 'chest', text: 'Holiday fund matures. Receive $100.', effect: { kind: 'money', amount: 100 } },
  { id: 'cc9', deck: 'chest', text: 'Income tax refund. Collect $20.', effect: { kind: 'money', amount: 20 } },
  { id: 'cc10', deck: 'chest', text: "It's your birthday. Collect $10 from every player.", effect: { kind: 'collectEach', amount: 10 } },
  { id: 'cc11', deck: 'chest', text: 'Life insurance matures. Collect $100.', effect: { kind: 'money', amount: 100 } },
  { id: 'cc12', deck: 'chest', text: 'Hospital fees. Pay $100.', effect: { kind: 'pay', amount: 100 } },
  { id: 'cc13', deck: 'chest', text: 'School fees. Pay $50.', effect: { kind: 'pay', amount: 50 } },
  { id: 'cc14', deck: 'chest', text: 'Receive $25 consultancy fee.', effect: { kind: 'money', amount: 25 } },
  { id: 'cc15', deck: 'chest', text: 'Street repairs: pay $40 per house, $115 per hotel.', effect: { kind: 'repairs', perHouse: 40, perHotel: 115 } },
  { id: 'cc16', deck: 'chest', text: 'Second prize in a beauty contest. Collect $10.', effect: { kind: 'money', amount: 10 } },
]

const CARD_MAP = new Map(ALL_CARDS.map((c) => [c.id, c]))

export function cardById(id: string): Card {
  const c = CARD_MAP.get(id)
  if (!c) throw new Error(`Unknown card ${id}`)
  return c
}
