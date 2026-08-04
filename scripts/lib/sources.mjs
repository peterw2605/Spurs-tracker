// Feed list plus the outlet reliability tiers that feed the probability model.
//
// Every source here is a public RSS feed. Google News search feeds do the heavy
// lifting: they aggregate outlets we cannot fetch directly (The Athletic, the
// nationals, journalist blogs) and attribute each headline to its publisher,
// which is exactly what the tier weighting needs.

const GOOGLE_NEWS = 'https://news.google.com/rss/search?hl=en-GB&gl=GB&ceid=GB:en&q=';

const q = (query) => GOOGLE_NEWS + encodeURIComponent(query);

export const FEEDS = [
  {
    name: 'BBC Sport — Tottenham',
    url: 'https://feeds.bbci.co.uk/sport/football/teams/tottenham-hotspur/rss.xml',
    outlet: 'BBC Sport',
  },
  {
    name: 'The Guardian — Tottenham',
    url: 'https://www.theguardian.com/football/tottenham-hotspur/rss',
    outlet: 'The Guardian',
  },
  {
    name: 'Sky Sports — Tottenham',
    url: 'https://www.skysports.com/rss/11095',
    outlet: 'Sky Sports',
  },
  {
    name: 'football.london — Spurs',
    url: 'https://www.football.london/tottenham-hotspur-fc/?service=rss',
    outlet: 'football.london',
  },
  {
    name: 'Evening Standard — Tottenham',
    url: 'https://www.standard.co.uk/sport/football/tottenham/rss',
    outlet: 'Evening Standard',
  },
  // Google News queries. Multiple angles because each query returns a capped
  // window, and "transfer" alone misses exit/contract stories.
  { name: 'Google News — Tottenham transfer', url: q('Tottenham transfer'), outlet: null },
  { name: 'Google News — Spurs transfer news', url: q('Spurs transfer news'), outlet: null },
  { name: 'Google News — Tottenham sign', url: q('Tottenham sign OR signing OR bid'), outlet: null },
  { name: 'Google News — Tottenham exit', url: q('Tottenham exit OR leave OR sell OR sale'), outlet: null },
  { name: 'Google News — Tottenham medical/agreed', url: q('Tottenham "medical" OR "agreed" OR "done deal"'), outlet: null },
  { name: 'Google News — Tottenham loan', url: q('Tottenham loan OR contract talks'), outlet: null },
];

// Reliability weight per outlet. This is the single biggest lever on the output
// probability, so it is a plain readable table rather than anything clever.
//
//   tier 1 (0.95) — outlets and reporters whose transfer stories are typically
//                   sourced directly and rarely wrong
//   tier 2 (0.62) — solid regional/national coverage, some aggregation
//   tier 3 (0.34) — aggregators and tabloid transfer desks
//   tier 4 (0.16) — fan blogs, syndicated rewrites, unknown publishers
const TIER_1 = [
  'the athletic', 'athletic', 'bbc sport', 'bbc', 'sky sports', 'sky sport',
  'the guardian', 'guardian', 'the times', 'times of london', 'the telegraph',
  'telegraph', 'fabrizio romano', 'david ornstein', 'l\'equipe', 'lequipe',
  'sky sport italia', 'gianluca di marzio', 'di marzio', 'reuters',
  'the athletic fc', 'the independent',
];

const TIER_2 = [
  'football.london', 'footballlondon', 'football london', 'evening standard',
  'the standard', 'standard.co.uk', 'espn', 'espn fc', 'the i paper', 'inews',
  'daily mail', 'mailonline', 'mail online', 'alasdair gold', 'the athletic uk',
  'football insider', 'the boot room', 'goal.com', 'goal', 'bild', 'as',
  'marca', 'relevo', 'la gazzetta dello sport', 'gazzetta', 'corriere dello sport',
  'onefootball', 'the mirror football', 'nbc sports', 'talksport',
  'london evening standard', 'manchester evening news', 'liverpool echo',
  'the athletic uk', 'sky sports news',
];

const TIER_3 = [
  'teamtalk', 'caughtoffside', 'caught offside', 'tbr football', 'tbrfootball',
  'givemesport', 'give me sport', 'the sun', 'thesun', 'daily mirror', 'mirror',
  'daily express', 'express', 'express.co.uk', '90min', 'football365',
  'hitc', 'sport witness', 'sportwitness', 'tribal football', 'tribalfootball',
  'football fancast', 'fancast', 'fichajes', 'fichajes.net', 'defensa central',
  'football transfers', 'footballtransfers', 'the peoples person', 'sportskeeda',
  'msn', 'yahoo sports', 'yahoo', 'newsnow', 'sports mole', 'sportsmole',
  'planet football', 'squawka', 'the boot room', 'football transfer league',
  'transfermarkt', 'soccernet', 'the sporting news',
];

const TIER_WEIGHTS = { 1: 0.95, 2: 0.62, 3: 0.34, 4: 0.16 };

// The same publisher reaches us under different names — directly from its own
// feed and again via Google News. Folding them together matters because the
// corroboration bonus counts *distinct* outlets, and two spellings of one
// newspaper is not two independent reports.
const OUTLET_ALIASES = new Map(Object.entries({
  'london evening standard': 'Evening Standard',
  'the standard': 'Evening Standard',
  'standard.co.uk': 'Evening Standard',
  'football london': 'football.london',
  footballlondon: 'football.london',
  'footballlondon - spurs': 'football.london',
  bbc: 'BBC Sport',
  'bbc news': 'BBC Sport',
  'bbc.com': 'BBC Sport',
  'sky sports news': 'Sky Sports',
  'sky sports football': 'Sky Sports',
  'the athletic': 'The Athletic',
  'the athletic fc': 'The Athletic',
  'the athletic uk': 'The Athletic',
  'new york times': 'The Athletic',
  mailonline: 'Daily Mail',
  'mail online': 'Daily Mail',
  'the daily mail': 'Daily Mail',
  thesun: 'The Sun',
  'the sun uk': 'The Sun',
  'daily mirror': 'The Mirror',
  'mirror football': 'The Mirror',
  mirror: 'The Mirror',
  'express.co.uk': 'Daily Express',
  express: 'Daily Express',
  guardian: 'The Guardian',
  'the guardian uk': 'The Guardian',
  'caught offside': 'CaughtOffside',
  caughtoffside: 'CaughtOffside',
  'give me sport': 'GiveMeSport',
  givemesport: 'GiveMeSport',
  'tbr football': 'TBR Football',
  tbrfootball: 'TBR Football',
  'sports mole': 'Sports Mole',
  sportsmole: 'Sports Mole',
  'teamtalk.com': 'TEAMtalk',
  teamtalk: 'TEAMtalk',
}));

/** Fold outlet spellings onto one canonical publisher name. */
export function canonicalOutlet(outlet) {
  if (!outlet) return null;
  const cleaned = outlet.replace(/\s+/g, ' ').trim();
  const key = cleaned.toLowerCase();
  return OUTLET_ALIASES.get(key) ?? cleaned;
}

function normaliseOutlet(outlet) {
  return (canonicalOutlet(outlet) || '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function matches(list, name) {
  return list.some((entry) => {
    const candidate = entry.replace(/^the\s+/, '');
    return name === candidate || name.startsWith(`${candidate} `) || name.endsWith(` ${candidate}`);
  });
}

export function outletTier(outlet) {
  const name = normaliseOutlet(outlet);
  if (!name) return 4;
  if (matches(TIER_1, name)) return 1;
  if (matches(TIER_2, name)) return 2;
  if (matches(TIER_3, name)) return 3;
  return 4;
}

export function tierWeight(tier) {
  return TIER_WEIGHTS[tier] ?? TIER_WEIGHTS[4];
}

export const TIER_LABELS = {
  1: 'Tier 1 — top reliability',
  2: 'Tier 2 — reliable',
  3: 'Tier 3 — aggregator / tabloid',
  4: 'Tier 4 — unranked source',
};
