// ── Company registry (rails + utilities) ──
// For each of the 6 company spaces, the real-world company the board space
// is themed after (renamed 2026-11-24: railways to JR East / JR Central /
// South Western Railway / Namma Metro, electric company to BESCOM).
// The user will supply images later, keyed by `company` (or `space`); drop
// them in `public/img/companies/` and set `image` below.

export interface CompanyBrand {
  /** Board space index this company occupies */
  space: number
  /** Name as printed on the board */
  boardName: string
  /** The company the space is themed after */
  company: string
  /** The exact query used to find the company */
  query: string
  /** Source URL for the company */
  source: string
  /** Image path - set when the user provides artwork */
  image: string | null
}

export const COMPANIES: CompanyBrand[] = [
  {
    space: 5,
    boardName: 'JR East - Yamanote Line',
    company: 'JR East',
    query: 'JR East Yamanote Line',
    source: 'https://www.jreast.co.jp/e/',
    image: null,
  },
  {
    space: 12,
    boardName: 'BESCOM',
    company: 'BESCOM',
    query: 'BESCOM Bangalore electricity',
    source: 'https://bescom.karnataka.gov.in',
    image: null,
  },
  {
    space: 15,
    boardName: 'JR Central - Nozomi Shinkansen',
    company: 'JR Central',
    query: 'JR Central Nozomi Shinkansen',
    source: 'https://global.jr-central.co.jp/en/',
    image: null,
  },
  {
    space: 25,
    boardName: 'South Western Railway',
    company: 'South Western Railway',
    query: 'South Western Railway UK',
    source: 'https://www.southwesternrailway.com',
    image: null,
  },
  {
    space: 28,
    boardName: 'Water Works',
    company: 'WaterWorks Pools Spas',
    query: 'Water Works company',
    source: 'https://waterworkscompany.com',
    image: null,
  },
  {
    space: 35,
    boardName: 'Namma Metro',
    company: 'Namma Metro',
    query: 'Namma Metro Bangalore',
    source: 'https://english.bmrc.co.in',
    image: null,
  },
]

export const COMPANY_BY_SPACE: Record<number, CompanyBrand> = Object.fromEntries(
  COMPANIES.map((c) => [c.space, c]),
)
