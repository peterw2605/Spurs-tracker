// Turning a headline into (player, direction, other club) without an LLM.
//
// The approach is deliberately conservative: pull out capitalised token runs
// that look like person names, throw away anything that matches a club, a
// competition, a football noun, or a known non-player (managers, pundits), then
// decide direction from the surrounding language. False negatives are cheap
// here — a missed headline just means one less piece of evidence — whereas
// false positives put junk on the board, so the filters lean strict.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', 'data');

const roster = JSON.parse(readFileSync(join(dataDir, 'squad.json'), 'utf8'));

// Lowercase words that join a surname rather than starting a new name. Declared
// up here because the ignore-surname index below needs it at module load.
const PARTICLE_WORDS = new Set([
  'de', 'da', 'do', 'dos', 'das', 'del', 'della', 'di', 'du', 'van', 'von', 'der',
  'den', 'ten', 'ter', 'la', 'le', 'el', 'al', 'bin', 'ibn', 'mac', 'mc', "o'", 'st',
]);

export const SQUAD = new Set(roster.squad.map(normaliseName));
export const KNOWN_TARGETS = new Set(roster.knownTargets.map(normaliseName));
export const IGNORE_PEOPLE = new Set(
  [...roster.ignorePeople, ...roster.staff].map(normaliseName),
);
const MONONYMS = new Set(roster.mononyms.map(normaliseName));

// Surnames of people we never treat as transfer subjects, so a misspelled or
// truncated first name ("Robert De Zerbi") is still recognised and skipped.
const IGNORE_SURNAMES = new Set(
  [...roster.ignorePeople, ...roster.staff]
    .map(normaliseName)
    .map((name) => {
      const parts = name.split(' ');
      // Keep the particle with the surname: "de zerbi", not "zerbi".
      if (parts.length >= 3 && PARTICLE_WORDS.has(parts.at(-2))) return parts.slice(-2).join(' ');
      return parts.at(-1);
    })
    .filter((surname) => surname && surname.length > 3),
);

export function isIgnoredPerson(key) {
  if (IGNORE_PEOPLE.has(key)) return true;
  const parts = key.split(' ');
  if (parts.length < 2) return false;
  const tail = PARTICLE_WORDS.has(parts.at(-2)) ? parts.slice(-2).join(' ') : parts.at(-1);
  return IGNORE_SURNAMES.has(tail);
}

/** Names we already recognise as footballers, so single-source reports are trusted. */
export function isKnownPlayer(key) {
  return SQUAD.has(key) || KNOWN_TARGETS.has(key) || MONONYMS.has(key);
}

/** Is this name on the current squad list? Accepts a display name or a key. */
export function isSquadPlayer(name) {
  return SQUAD.has(normaliseName(name));
}

export function normaliseName(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Clubs
// ---------------------------------------------------------------------------

// Canonical name -> alias list. Aliases are matched case-insensitively as whole
// words, longest first, so "Manchester United" wins over "United".
const CLUBS = {
  Tottenham: ['Tottenham Hotspur', 'Tottenham', 'Spurs', 'THFC'],
  Arsenal: ['Arsenal', 'Gunners'],
  Chelsea: ['Chelsea', 'Blues'],
  Liverpool: ['Liverpool', 'Reds', 'LFC'],
  'Manchester United': ['Manchester United', 'Man United', 'Man Utd', 'United', 'MUFC'],
  'Manchester City': ['Manchester City', 'Man City', 'City', 'MCFC'],
  'Newcastle United': ['Newcastle United', 'Newcastle', 'Magpies'],
  'Aston Villa': ['Aston Villa', 'Villa'],
  'West Ham': ['West Ham United', 'West Ham', 'Hammers'],
  Everton: ['Everton', 'Toffees'],
  'Crystal Palace': ['Crystal Palace', 'Palace'],
  Brighton: ['Brighton & Hove Albion', 'Brighton', 'Seagulls'],
  Brentford: ['Brentford', 'Bees'],
  Fulham: ['Fulham'],
  Bournemouth: ['AFC Bournemouth', 'Bournemouth'],
  Wolves: ['Wolverhampton Wanderers', 'Wolverhampton', 'Wolves'],
  'Nottingham Forest': ['Nottingham Forest', 'Nottm Forest', 'Forest'],
  Leeds: ['Leeds United', 'Leeds'],
  Burnley: ['Burnley'],
  Sunderland: ['Sunderland'],
  Leicester: ['Leicester City', 'Leicester', 'Foxes'],
  Southampton: ['Southampton', 'Saints'],
  Ipswich: ['Ipswich Town', 'Ipswich'],
  'Real Madrid': ['Real Madrid', 'Madrid'],
  Barcelona: ['Barcelona', 'Barca', 'Barça'],
  'Atletico Madrid': ['Atletico Madrid', 'Atlético Madrid', 'Atletico', 'Atleti'],
  Sevilla: ['Sevilla'],
  Valencia: ['Valencia'],
  'Real Betis': ['Real Betis', 'Betis'],
  'Real Sociedad': ['Real Sociedad', 'Sociedad'],
  'Athletic Bilbao': ['Athletic Bilbao', 'Athletic Club'],
  Villarreal: ['Villarreal'],
  PSG: ['Paris Saint-Germain', 'Paris St-Germain', 'Paris SG', 'PSG'],
  Marseille: ['Olympique Marseille', 'Marseille', 'OM'],
  Lyon: ['Olympique Lyonnais', 'Lyon', 'OL'],
  Monaco: ['AS Monaco', 'Monaco'],
  Lille: ['Lille', 'LOSC'],
  Nice: ['OGC Nice', 'Nice'],
  Rennes: ['Rennes'],
  'Bayern Munich': ['Bayern Munich', 'Bayern Münich', 'Bayern'],
  'Borussia Dortmund': ['Borussia Dortmund', 'Dortmund', 'BVB'],
  'Bayer Leverkusen': ['Bayer Leverkusen', 'Leverkusen'],
  'RB Leipzig': ['RB Leipzig', 'Leipzig'],
  Stuttgart: ['VfB Stuttgart', 'Stuttgart'],
  'Eintracht Frankfurt': ['Eintracht Frankfurt', 'Eintracht', 'Frankfurt'],
  'Borussia Monchengladbach': ['Borussia Monchengladbach', 'Borussia Mönchengladbach', 'Gladbach'],
  Juventus: ['Juventus', 'Juve'],
  'Inter Milan': ['Inter Milan', 'Internazionale', 'Inter'],
  'AC Milan': ['AC Milan', 'Milan'],
  Napoli: ['Napoli'],
  Roma: ['AS Roma', 'Roma'],
  Lazio: ['Lazio'],
  Atalanta: ['Atalanta'],
  Fiorentina: ['Fiorentina'],
  Bologna: ['Bologna'],
  'Sporting CP': ['Sporting Lisbon', 'Sporting CP', 'Sporting'],
  Benfica: ['Benfica'],
  Porto: ['FC Porto', 'Porto'],
  Ajax: ['Ajax'],
  PSV: ['PSV Eindhoven', 'PSV'],
  Feyenoord: ['Feyenoord'],
  Celtic: ['Celtic'],
  Rangers: ['Rangers'],
  Galatasaray: ['Galatasaray'],
  Fenerbahce: ['Fenerbahce', 'Fenerbahçe'],
  Besiktas: ['Besiktas', 'Beşiktaş'],
  'Al Hilal': ['Al Hilal', 'Al-Hilal'],
  'Al Nassr': ['Al Nassr', 'Al-Nassr'],
  'Al Ittihad': ['Al Ittihad', 'Al-Ittihad'],
  'Al Ahli': ['Al Ahli', 'Al-Ahli'],
  Flamengo: ['Flamengo'],
  Palmeiras: ['Palmeiras'],
  'River Plate': ['River Plate'],
  'Boca Juniors': ['Boca Juniors'],
  'Inter Miami': ['Inter Miami'],
  Shakhtar: ['Shakhtar Donetsk', 'Shakhtar'],
  Salzburg: ['RB Salzburg', 'Red Bull Salzburg', 'Salzburg'],
  Genk: ['KRC Genk', 'Genk'],
  Bruges: ['Club Brugge', 'Club Bruges', 'Brugge'],
  Anderlecht: ['Anderlecht'],
  Slavia: ['Slavia Prague', 'Slavia'],
  // EFL and lower-league sides show up constantly in loan and academy stories,
  // and are the main source of "club parsed as a person" false positives.
  'Sheffield United': ['Sheffield United', 'Sheffield Utd'],
  'Sheffield Wednesday': ['Sheffield Wednesday'],
  'West Bromwich Albion': ['West Bromwich Albion', 'West Brom', 'WBA'],
  Middlesbrough: ['Middlesbrough', 'Boro'],
  'Norwich City': ['Norwich City', 'Norwich'],
  Watford: ['Watford'],
  'Coventry City': ['Coventry City', 'Coventry'],
  Millwall: ['Millwall'],
  'Queens Park Rangers': ['Queens Park Rangers', 'QPR'],
  'Stoke City': ['Stoke City', 'Stoke'],
  'Preston North End': ['Preston North End', 'Preston'],
  'Blackburn Rovers': ['Blackburn Rovers', 'Blackburn'],
  'Bristol City': ['Bristol City'],
  'Cardiff City': ['Cardiff City', 'Cardiff'],
  'Swansea City': ['Swansea City', 'Swansea'],
  'Hull City': ['Hull City', 'Hull'],
  'Luton Town': ['Luton Town', 'Luton'],
  'Plymouth Argyle': ['Plymouth Argyle', 'Plymouth'],
  Portsmouth: ['Portsmouth', 'Pompey'],
  'Derby County': ['Derby County', 'Derby'],
  'Oxford United': ['Oxford United'],
  'Charlton Athletic': ['Charlton Athletic', 'Charlton'],
  'Birmingham City': ['Birmingham City', 'Birmingham'],
  'Leyton Orient': ['Leyton Orient'],
  'Wrexham': ['Wrexham'],
  'Reading': ['Reading'],
  'Peterborough United': ['Peterborough United', 'Peterborough'],
  'Barnsley': ['Barnsley'],
  'Bolton Wanderers': ['Bolton Wanderers', 'Bolton'],
  'Blackpool': ['Blackpool'],
  'Wycombe Wanderers': ['Wycombe Wanderers', 'Wycombe'],
  'Stevenage': ['Stevenage'],
  'Colchester United': ['Colchester United', 'Colchester'],
  'Shamrock Rovers': ['Shamrock Rovers'],
  "St Patrick's Athletic": ["St Patrick's Athletic", "St Pat's", 'St Patricks Athletic'],
  Bohemians: ['Bohemians'],
  Dundalk: ['Dundalk'],
  'Hearts': ['Heart of Midlothian', 'Hearts'],
  'Hibernian': ['Hibernian', 'Hibs'],
};

const CLUB_LOOKUP = [];
for (const [canonical, aliases] of Object.entries(CLUBS)) {
  for (const alias of aliases) {
    CLUB_LOOKUP.push({ canonical, alias, key: normaliseName(alias) });
  }
}
CLUB_LOOKUP.sort((a, b) => b.alias.length - a.alias.length);

const CLUB_TOKENS = new Set();
for (const { key } of CLUB_LOOKUP) {
  for (const token of key.split(' ')) CLUB_TOKENS.add(token);
}

export function findClubs(text) {
  const found = [];
  const seen = new Set();
  for (const { canonical, alias } of CLUB_LOOKUP) {
    const re = new RegExp(`(?<![\\p{L}])${escapeRegExp(alias)}(?![\\p{L}])`, 'iu');
    if (re.test(text) && !seen.has(canonical)) {
      seen.add(canonical);
      found.push(canonical);
    }
  }
  return found;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Name extraction
// ---------------------------------------------------------------------------

// Capitalised words that show up constantly in headlines and are never part of
// the player's name we are looking for.
const STOP_WORDS = new Set([
  // transfer vocabulary
  'transfer', 'transfers', 'signing', 'signings', 'sign', 'signs', 'signed', 'deal', 'deals',
  'bid', 'bids', 'offer', 'offers', 'offered', 'medical', 'contract', 'contracts', 'wages',
  'fee', 'fees', 'clause', 'release', 'loan', 'loans', 'exit', 'exits', 'move', 'moves',
  'swap', 'swoop', 'target', 'targets', 'targeting', 'interest', 'interested', 'links',
  'linked', 'talks', 'agreement', 'agreed', 'agree', 'window', 'deadline', 'day', 'sale',
  'sales', 'sell', 'selling', 'buy', 'raid', 'hijack', 'pursuit', 'chase', 'saga', 'update',
  'updates', 'latest', 'rumours', 'rumors', 'rumour', 'rumor', 'gossip', 'news', 'report',
  'reports', 'reportedly', 'confirmed', 'confirm', 'confirms', 'revealed', 'reveals', 'claim',
  'claims', 'verdict', 'stance', 'decision', 'boost', 'blow', 'twist', 'hint', 'hints',
  'price', 'priced', 'pricetag', 'valuation', 'value', 'asking', 'met', 'meet', 'meets',
  'demand', 'demands', 'condition', 'conditions', 'dilemma', 'emerges', 'emerged',
  'responds', 'response', 'reply', 'replies', 'insists', 'insist', 'admits', 'admit',
  'denies', 'deny', 'warns', 'warn', 'urges', 'urge', 'backs', 'back', 'names', 'name',
  'named', 'picks', 'pick', 'lands', 'land', 'landed', 'seals', 'seal', 'sealed',
  'eyed', 'wants', 'raids', 'swoops', 'battle', 'race', 'fight', 'hunt', 'search',
  'replacement', 'shortlist', 'wishlist', 'plan', 'plans', 'planning', 'budget',
  'funds', 'cash', 'money', 'millions', 'million', 'billion', 'record', 'bargain',
  'escape', 'route', 'door', 'exit', 'future', 'plea', 'promise', 'vow', 'message',
  'admission', 'update', 'talk', 'talking', 'quotes', 'comment', 'comments',
  'expensive', 'cheap', 'huge', 'massive', 'shock', 'stunning', 'perfect', 'ideal',
  'positive', 'negative', 'green', 'light', 'step', 'stepped', 'move', 'switch',
  'free', 'stream', 'live', 'watch', 'show', 'podcast', 'video', 'gallery',
  'briefing', 'bulletin', 'column', 'blog', 'notebook', 'mailbox', 'mailbag',
  'every', 'each', 'told', 'reveal', 'reveals', 'explains', 'explain', 'drops',
  'tipped', 'urged', 'warned', 'linked', 'eyed', 'handed', 'given', 'faces',
  // football nouns
  'striker', 'strikers', 'forward', 'forwards', 'winger', 'wingers', 'midfielder',
  'midfielders', 'defender', 'defenders', 'goalkeeper', 'goalkeepers', 'keeper', 'star',
  'stars', 'ace', 'man', 'men', 'player', 'players', 'squad', 'team', 'side', 'club',
  'clubs', 'boss', 'manager', 'managers', 'head', 'coach', 'gaffer', 'chairman', 'owner',
  'director', 'chief', 'agent', 'agents', 'captain', 'academy', 'youngster', 'starlet',
  'prodigy', 'international', 'sensation', 'talent', 'signing', 'flop', 'outcast', 'legend',
  'goal', 'goals', 'assist', 'assists', 'injury', 'injuries', 'fitness', 'return',
  'line', 'lineup', 'xi', 'bench', 'formation', 'position', 'shirt', 'number',
  // competitions and organisations
  'premier', 'league', 'champions', 'europa', 'conference', 'cup', 'fa', 'efl', 'carabao',
  'uefa', 'fifa', 'world', 'euro', 'euros', 'nations', 'olympics', 'liga', 'serie',
  'bundesliga', 'ligue', 'eredivisie', 'mls', 'saudi', 'pro', 'championship', 'wsl',
  'community', 'shield', 'super', 'club', 'friendly', 'friendlies', 'preseason',
  // generic headline filler
  'the', 'a', 'an', 'and', 'or', 'but', 'as', 'at', 'in', 'on', 'to', 'for', 'from',
  'with', 'without', 'after', 'before', 'over', 'under', 'into', 'onto', 'off', 'out',
  'up', 'down', 'about', 'amid', 'amidst', 'ahead', 'behind', 'between', 'against',
  'this', 'that', 'these', 'those', 'his', 'her', 'their', 'its', 'our', 'your', 'my',
  'he', 'she', 'they', 'it', 'we', 'you', 'i', 'who', 'what', 'when', 'where', 'why',
  'how', 'which', 'all', 'both', 'each', 'more', 'most', 'other', 'others', 'some',
  'any', 'no', 'not', 'now', 'new', 'old', 'next', 'last', 'first', 'second', 'third',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'double', 'triple', 'big', 'huge', 'major', 'top', 'best',
  'worst', 'good', 'great', 'key', 'full', 'live', 'here', 'there', 'still', 'set',
  'ready', 'close', 'closing', 'want', 'wants', 'wanted', 'eye', 'eyes', 'eyeing',
  'could', 'would', 'should', 'may', 'might', 'must', 'can', 'will', 'wont', 'have',
  'has', 'had', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did',
  'get', 'gets', 'got', 'make', 'makes', 'made', 'take', 'takes', 'taken', 'give',
  'gives', 'given', 'say', 'says', 'said', 'tell', 'tells', 'told', 'ask', 'asks',
  'asked', 'see', 'sees', 'seen', 'look', 'looks', 'looking', 'go', 'goes', 'going',
  'come', 'comes', 'coming', 'join', 'joins', 'joining', 'leave', 'leaves', 'leaving',
  'stay', 'stays', 'staying', 'why', 'yes', 'exclusive', 'breaking', 'opinion',
  'analysis', 'preview', 'review', 'ratings', 'talking', 'points', 'january', 'february',
  'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november',
  'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
  'sunday', 'summer', 'winter', 'january', 'season', 'week', 'weekend', 'today',
  'tomorrow', 'yesterday', 'england', 'brazil', 'france', 'spain', 'germany', 'italy',
  'portugal', 'argentina', 'netherlands', 'belgium', 'sweden', 'denmark', 'norway',
  'wales', 'scotland', 'ireland', 'nigeria', 'ghana', 'senegal', 'morocco', 'japan',
  'korea', 'usa', 'america', 'europe', 'african', 'european', 'london', 'paris',
  'madrid', 'milan', 'munich', 'lisbon', 'amsterdam', 'turkey', 'greece',
]);

const PARTICLES = PARTICLE_WORDS;

const NAME_TOKEN = /^[A-ZÀ-Þ][\p{L}'’\-]*$/u;

function tokenise(headline) {
  return headline
    .replace(/[“”"„»«]/g, ' ')
    .replace(/[.,:;!?()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function isRejectedToken(token) {
  // Strip a trailing possessive first, or "Newcastle's" slips past the club
  // filter and becomes part of a player name ("Newcastle's Tonali").
  const key = normaliseName(token).replace(/'s$/, '').replace(/'$/, '');
  return STOP_WORDS.has(key) || CLUB_TOKENS.has(key);
}

/**
 * Extract candidate person names from a headline.
 * Returns canonical-cased display names, deduped, in order of appearance.
 */
export function extractPeople(headline) {
  const tokens = tokenise(headline);
  const runs = [];
  let current = [];

  const flush = () => {
    if (current.length) runs.push(current);
    current = [];
  };

  for (let i = 0; i < tokens.length; i += 1) {
    // "Archie Gray's" and "Rafael Leao's" are the same players as their
    // unpossessed forms; keeping the "'s" forks them into separate rumours.
    const token = tokens[i].replace(/[’']s$/, '').replace(/[’']$/, '');
    if (!token) { flush(); continue; }
    const lower = normaliseName(token);

    if (NAME_TOKEN.test(token) && !isRejectedToken(token)) {
      current.push(token);
      continue;
    }
    // A lowercase particle only continues a run, never starts one.
    if (current.length && PARTICLES.has(lower)) {
      current.push(token);
      continue;
    }
    flush();
  }
  flush();

  const results = [];
  const seen = new Set();
  for (const run of runs) {
    for (const candidate of candidatesFromRun(run)) {
      const key = normaliseName(candidate);
      if (seen.has(key)) continue;
      if (isIgnoredPerson(key)) continue;
      seen.add(key);
      results.push({ name: candidate, key });
    }
  }
  return results;
}

function candidatesFromRun(run) {
  // A run can hold more than one name ("Cody Gakpo Kevin Danso"). Prefer known
  // players first, then fall back to 2–3 token windows.
  const out = [];
  const joined = run.join(' ');
  const joinedKey = normaliseName(joined);

  if (SQUAD.has(joinedKey) || KNOWN_TARGETS.has(joinedKey)) return [joined];

  // Known multi-token names inside the run.
  for (let size = Math.min(4, run.length); size >= 2; size -= 1) {
    for (let start = 0; start + size <= run.length; start += 1) {
      const slice = run.slice(start, start + size).join(' ');
      const key = normaliseName(slice);
      if (SQUAD.has(key) || KNOWN_TARGETS.has(key)) out.push(slice);
    }
  }
  if (out.length) return out;

  // Known single-name players.
  for (const token of run) {
    const key = normaliseName(token);
    if (MONONYMS.has(key) || SQUAD.has(key) || KNOWN_TARGETS.has(key)) out.push(token);
  }
  if (out.length) return out;

  // Unknown name: accept a plain 2- or 3-token run and nothing else. A single
  // capitalised word is far too noisy to treat as a player.
  if (run.length === 2 || run.length === 3) {
    const hasParticle = run.some((t) => PARTICLES.has(normaliseName(t)));
    if (run.length === 3 && !hasParticle) {
      // Three unknown capitalised words is usually two concepts colliding;
      // take the trailing pair, which is where the surname tends to sit.
      out.push(run.slice(1).join(' '));
    } else {
      out.push(run.join(' '));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Direction (incoming vs outgoing)
// ---------------------------------------------------------------------------

const SPURS_RE = /\b(tottenham(?:\s+hotspur)?|spurs|thfc)\b/i;

const OUT_CUES = [
  { re: /\b(tottenham|spurs)(?:'s|s')?\s+(?:star|ace|man|forward|striker|winger|midfielder|defender|centre-back|full-back|goalkeeper|keeper|player|outcast|flop|academy)\b/i, w: 2.2 },
  { re: /\b(?:leave|leaving|quit|quitting|exit|exiting|depart|departing)\s+(?:tottenham|spurs)\b/i, w: 2.4 },
  { re: /\b(?:tottenham|spurs)\s+(?:exit|departure|future|sale|sales|clear-?out|clearout)\b/i, w: 2.0 },
  { re: /\b(?:tottenham|spurs)\s+(?:to\s+)?(?:sell|offload|cash in on|axe|release|loan out|listen to offers)\b/i, w: 2.4 },
  { re: /\b(?:bid|offer|move|swoop|approach|enquiry)\s+for\s+(?:tottenham|spurs)(?:'s|s')?\b/i, w: 2.2 },
  { re: /\b(?:tottenham|spurs)\s+(?:accept|reject|turn down|hold firm on)\b/i, w: 1.2 },
  { re: /\bavailable\s+(?:for|on)\b/i, w: 0.6 },
  { re: /\b(?:permanent\s+(?:deal|move|transfer)|loan\s+move)\s+for\b/i, w: 0.5 },
  { re: /\bcontract\s+(?:talks|extension|renewal|standoff|stand-off|dispute)\b/i, w: 0.8 },
  { re: /\btour\s+omission\b|\btraining\s+ground\s+absence\b/i, w: 0.8 },
];

const IN_CUES = [
  { re: /\b(?:tottenham|spurs)\s+(?:eye|eyes|eyeing|target|targets|targeting|want|wants|wanted|chase|chasing|pursue|pursuing|monitor|monitoring|scout|scouting|track|tracking|consider|considering|line up|lining up|prioritis(?:e|ing)|identif(?:y|ied))\b/i, w: 2.2 },
  { re: /\b(?:tottenham|spurs)\s+(?:in|hold|open|step up|advance)\s+(?:talks|negotiations)\b/i, w: 2.2 },
  { re: /\b(?:tottenham|spurs)\s+(?:submit|submitted|table|tabled|make|made|lodge|lodged|prepare|preparing)\s+(?:a\s+|an\s+)?(?:bid|offer|proposal)\b/i, w: 2.4 },
  { re: /\b(?:tottenham|spurs)\s+(?:sign|signing|snap up|swoop for|close in on|closing in on|agree|agreed|complete|completing|seal|sealing)\b/i, w: 2.4 },
  { re: /\bto\s+(?:tottenham|spurs)\b|\bjoin(?:s|ing)?\s+(?:tottenham|spurs)\b/i, w: 2.2 },
  { re: /\b(?:tottenham|spurs)\s+(?:transfer\s+)?(?:interest|link|links|linked)\b/i, w: 1.4 },
  { re: /\b(?:offered|touted|pitched)\s+to\s+(?:tottenham|spurs)\b/i, w: 1.6 },
  { re: /\b(?:tottenham|spurs)\s+offered\b/i, w: 1.4 },
  { re: /\breplacement\b|\bshortlist\b|\bwishlist\b/i, w: 0.7 },
];

/**
 * Decide whether a rumour is an arrival or a departure.
 * Squad membership is the strongest signal; language cues break ties and cover
 * players the squad file does not know about yet.
 */
export function inferDirection(headline, personKey, { squadHints } = {}) {
  let out = 0;
  let inn = 0;
  for (const { re, w } of OUT_CUES) if (re.test(headline)) out += w;
  for (const { re, w } of IN_CUES) if (re.test(headline)) inn += w;

  const isSquad = SQUAD.has(personKey) || squadHints?.has(personKey);
  if (isSquad) out += 3.0;

  if (out === 0 && inn === 0) {
    // No cue either way: assume incoming, which is what most Spurs transfer
    // chatter is, unless we already know the player is on the books.
    return { direction: isSquad ? 'out' : 'in', confidence: 0.3 };
  }
  const total = out + inn;
  const direction = out > inn ? 'out' : 'in';
  return { direction, confidence: Math.abs(out - inn) / total };
}

/**
 * Headlines like "Tottenham's Nicolas Jackson stance revealed" tell us a player
 * is on the books. Collecting these lets the tracker stay useful even when
 * data/squad.json drifts out of date.
 */
export function detectSquadHints(headline, people) {
  const hints = new Set();
  const possessive = /\b(?:tottenham(?:\s+hotspur)?|spurs)(?:'s|s'|')\s+([A-Z][\p{L}'’\-]+(?:\s+[A-Z][\p{L}'’\-]+)?)/giu;
  const descriptor = /\b(?:tottenham|spurs)\s+(?:star|ace|man|forward|striker|winger|midfielder|defender|goalkeeper|keeper|player|outcast|flop)\s+([A-Z][\p{L}'’\-]+(?:\s+[A-Z][\p{L}'’\-]+)?)/giu;

  for (const re of [possessive, descriptor]) {
    let match;
    while ((match = re.exec(headline)) !== null) {
      const key = normaliseName(match[1]);
      if (people.some((p) => p.key === key || key.includes(p.key) || p.key.includes(key))) {
        const person = people.find((p) => p.key === key) || people.find((p) => key.includes(p.key));
        if (person) hints.add(person.key);
      }
    }
  }
  return hints;
}

export function mentionsSpurs(text) {
  return SPURS_RE.test(text);
}

export function otherClubs(text) {
  return findClubs(text).filter((club) => club !== 'Tottenham');
}
