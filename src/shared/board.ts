import type { ColorGroup, Space } from './types.js'

// Classic US-edition board. Official prices and rent tables.
// Index 0 = GO, moving "forward" = increasing index (wrap 39 → 0).
export const BOARD: Space[] = [
  { kind: 'go', name: 'GO' },
  { kind: 'street', name: 'Mediterranean Ave', price: 60, group: 'brown', rents: [2, 10, 30, 90, 160, 250], houseCost: 50 },
  { kind: 'chest', name: 'Community Chest' },
  { kind: 'street', name: 'Baltic Ave', price: 60, group: 'brown', rents: [4, 20, 60, 180, 320, 450], houseCost: 50 },
  { kind: 'tax', name: 'Income Tax', flat: 200, percent: true },
  { kind: 'rail', name: 'Reading Railroad', price: 200 },
  { kind: 'street', name: 'Oriental Ave', price: 100, group: 'lightblue', rents: [6, 30, 90, 270, 400, 550], houseCost: 50 },
  { kind: 'chance', name: 'Chance' },
  { kind: 'street', name: 'Vermont Ave', price: 100, group: 'lightblue', rents: [6, 30, 90, 270, 400, 550], houseCost: 50 },
  { kind: 'street', name: 'Connecticut Ave', price: 120, group: 'lightblue', rents: [8, 40, 100, 300, 450, 600], houseCost: 50 },
  { kind: 'jail', name: 'Jail / Just Visiting' },
  { kind: 'street', name: 'St. Charles Place', price: 150, group: 'pink', rents: [10, 50, 150, 450, 625, 750], houseCost: 100 },
  { kind: 'utility', name: 'Electric Company', price: 150 },
  { kind: 'street', name: 'States Ave', price: 150, group: 'pink', rents: [10, 50, 150, 450, 625, 750], houseCost: 100 },
  { kind: 'street', name: 'Virginia Ave', price: 160, group: 'pink', rents: [12, 60, 180, 500, 700, 900], houseCost: 100 },
  { kind: 'rail', name: 'Pennsylvania Railroad', price: 200 },
  { kind: 'street', name: 'St. James Place', price: 180, group: 'orange', rents: [14, 70, 200, 550, 750, 950], houseCost: 100 },
  { kind: 'chest', name: 'Community Chest' },
  { kind: 'street', name: 'Tennessee Ave', price: 180, group: 'orange', rents: [14, 70, 200, 550, 750, 950], houseCost: 100 },
  { kind: 'street', name: 'New York Ave', price: 200, group: 'orange', rents: [16, 80, 220, 600, 800, 1000], houseCost: 100 },
  { kind: 'parking', name: 'Free Parking' },
  { kind: 'street', name: 'Kentucky Ave', price: 220, group: 'red', rents: [18, 90, 250, 700, 875, 1050], houseCost: 150 },
  { kind: 'chance', name: 'Chance' },
  { kind: 'street', name: 'Indiana Ave', price: 220, group: 'red', rents: [18, 90, 250, 700, 875, 1050], houseCost: 150 },
  { kind: 'street', name: 'Illinois Ave', price: 240, group: 'red', rents: [20, 100, 300, 750, 925, 1100], houseCost: 150 },
  { kind: 'rail', name: 'B&O Railroad', price: 200 },
  { kind: 'street', name: 'Atlantic Ave', price: 260, group: 'yellow', rents: [22, 110, 330, 800, 975, 1150], houseCost: 150 },
  { kind: 'street', name: 'Ventnor Ave', price: 260, group: 'yellow', rents: [22, 110, 330, 800, 975, 1150], houseCost: 150 },
  { kind: 'utility', name: 'Water Works', price: 150 },
  { kind: 'street', name: 'Marvin Gardens', price: 280, group: 'yellow', rents: [24, 120, 360, 850, 1025, 1200], houseCost: 150 },
  { kind: 'gotojail', name: 'Go To Jail' },
  { kind: 'street', name: 'Pacific Ave', price: 300, group: 'green', rents: [26, 130, 390, 900, 1100, 1275], houseCost: 200 },
  { kind: 'street', name: 'North Carolina Ave', price: 300, group: 'green', rents: [26, 130, 390, 900, 1100, 1275], houseCost: 200 },
  { kind: 'chest', name: 'Community Chest' },
  { kind: 'street', name: 'Pennsylvania Ave', price: 320, group: 'green', rents: [28, 150, 450, 1000, 1200, 1400], houseCost: 200 },
  { kind: 'rail', name: 'Short Line Railroad', price: 200 },
  { kind: 'chance', name: 'Chance' },
  { kind: 'street', name: 'Park Place', price: 350, group: 'blue', rents: [35, 175, 500, 1100, 1300, 1500], houseCost: 200 },
  { kind: 'tax', name: 'Luxury Tax', flat: 75 },
  { kind: 'street', name: 'Boardwalk', price: 400, group: 'blue', rents: [50, 200, 600, 1400, 1700, 2000], houseCost: 200 },
]

export const BOARD_SIZE = 40
export const JAIL_POS = 10
export const GO_REWARD = 200
export const JAIL_FINE = 50
export const START_CASH = 1500
export const MAX_JAIL_ATTEMPTS = 3
export const BANKRUPT_AUCTION = true

export const GROUP_COLORS: Record<ColorGroup, string> = {
  brown: '#8b5a2b',
  lightblue: '#7fd3f5',
  pink: '#d6449e',
  orange: '#f7941d',
  red: '#ea3323',
  yellow: '#fde84d',
  green: '#199e4e',
  blue: '#2c6fbf',
}

const GROUP_INDEX_MAP: Record<ColorGroup, number[]> = {
  brown: [1, 3],
  lightblue: [6, 8, 9],
  pink: [11, 13, 14],
  orange: [16, 18, 19],
  red: [21, 23, 24],
  yellow: [26, 27, 29],
  green: [31, 32, 34],
  blue: [37, 39],
}

export function groupIndices(group: ColorGroup): number[] {
  return GROUP_INDEX_MAP[group]
}

export const RAIL_INDICES = [5, 15, 25, 35]
export const UTILITY_INDICES = [12, 28]

export function nearestOf(kind: 'rail' | 'utility', from: number): number {
  const targets = kind === 'rail' ? RAIL_INDICES : UTILITY_INDICES
  for (const t of targets) if (t > from) return t
  return targets[0]
}

export function isStreet(sp: Space): sp is Extract<Space, { kind: 'street' }> {
  return sp.kind === 'street'
}

export function isPurchasable(sp: Space): sp is Extract<Space, { kind: 'street' | 'rail' | 'utility' }> {
  return sp.kind === 'street' || sp.kind === 'rail' || sp.kind === 'utility'
}

export function spacePrice(sp: Space): number | null {
  return isPurchasable(sp) ? sp.price : null
}
