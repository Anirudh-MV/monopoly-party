// ── Company registry (rails + utilities) ──
// For each of the 6 company spaces, the FIRST web-search result's company
// name for the query "{board name} company" (searched 2026-11-21).
// The user will supply images later, keyed by `company` (or `space`);
// drop them in `public/img/companies/` and set `image` below.

export interface CompanyBrand {
  /** Board space index this company occupies */
  space: number
  /** Name as printed on the board */
  boardName: string
  /** First search result's company name — stored verbatim */
  company: string
  /** The exact query used */
  query: string
  /** Source URL of the first result */
  source: string
  /** Image path — set when the user provides artwork */
  image: string | null
}

export const COMPANIES: CompanyBrand[] = [
  {
    space: 5,
    boardName: 'Reading Railroad',
    company: 'Reading Company',
    query: 'Reading Railroad company',
    source: 'https://readingrailroad.org/about-us',
    image: null,
  },
  {
    space: 12,
    boardName: 'Electric Company',
    company: 'The Electric Company',
    query: 'Electric Company company',
    source: 'https://mkeelectriccompany.com',
    image: null,
  },
  {
    space: 15,
    boardName: 'Pennsylvania Railroad',
    company: 'Pennsylvania Railroad Company',
    query: 'Pennsylvania Railroad company',
    source: 'http://pennsylvania-railroad.com/history',
    image: null,
  },
  {
    space: 25,
    boardName: 'B&O Railroad',
    company: 'Baltimore and Ohio Railroad',
    query: 'B&O Railroad company',
    source: 'https://sova.si.edu/record/nmah.ac.1086',
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
    boardName: 'Short Line',
    company: 'Patriot Rail',
    query: 'Short Line company',
    source: 'https://patriotrail.com/about-us/',
    image: null,
  },
]

export const COMPANY_BY_SPACE: Record<number, CompanyBrand> = Object.fromEntries(
  COMPANIES.map((c) => [c.space, c]),
)
