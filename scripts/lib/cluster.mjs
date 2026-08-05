// Group individual headlines into one rumour per (player, direction).

import {
  extractPeople,
  detectSquadHints,
  inferDirection,
  mentionsSpurs,
  otherClubs,
  normaliseName,
  isKnownPlayer,
  isSquadPlayer,
} from './entities.mjs';
import { outletTier, tierWeight } from './sources.mjs';
import { scoreRumour, classifyArticle } from './score.mjs';

// A headline has to be about a transfer for us to care. Match reports and
// injury news mention players constantly and would otherwise flood the board.
const TRANSFER_CONTEXT =
  /\b(transfer|transfers|signing|signings|sign|signs|signed|deal|deals|bid|bids|offer|offers|offered|medical|fee|fees|clause|loan|exit|exits|departure|swap|swoop|move|moves|window|deadline|sale|sales|sell|sells|selling|sold|buy|contract|wages|talks|negotiat\w*|target|targets|targeting|linked|links|interest|interested|eyeing|eyes|chase|chasing|pursue|pursuing|wanted|wants|replacement|shortlist|wishlist|join|joins|joining|leave|leaves|leaving|available|price|priced|valuation|release)\b/i;

// Live blogs and gossip columns cover a dozen clubs in one headline, so a
// phrase like "done deal" in them belongs to some other club's transfer. These
// still count as a mention, but their stage language cannot be attributed to any
// single player, so it gets demoted rather than the article being dropped.
const ROUNDUP_PATTERNS = [
  /\bLIVE!?\b/, // case-sensitive on purpose: "LIVE" is a live-blog marker
  /^(?:football\s+)?transfer\s+(?:news|rumours|rumors|gossip|centre|center|round-?up|latest|talk|blog)\b/i,
  /\btransfer\s+(?:news|centre|center|rumours|rumors)\s+live\b/i,
  /\b(?:gossip|paper\s+talk|paper\s+round-?up|newspaper\s+round-?up|daily\s+briefing|rumour\s+mill)\b/i,
  /\bdeadline\s+day\s+live\b/i,
  /\bwhat\s+we\s+know\b/i,
];

export function isRoundup(headline, clubCount) {
  if (clubCount >= 3) return true;
  return ROUNDUP_PATTERNS.some((re) => re.test(headline));
}

/**
 * Remove arrival rumours for players already on the squad list.
 *
 * A player on the books cannot be arriving — he is here. This shows up when a
 * headline references a past, completed move ("Tottenham's new signing: Pedro
 * Porro was the reason the deal was completed") and the parser reads it as
 * current transfer news. Completed deals are exempt: a signing that has just
 * landed is legitimately "in".
 *
 * Mutates `rumours` in place and returns the entries removed.
 */
export function dropContradictoryArrivals(rumours) {
  const dropped = rumours.filter(
    (rumour) => !rumour.done && rumour.direction === 'in' && isSquadPlayer(rumour.player),
  );
  if (dropped.length === 0) return dropped;

  const ids = new Set(dropped.map((rumour) => rumour.id));
  const remaining = rumours.filter((rumour) => !ids.has(rumour.id));
  rumours.length = 0;
  rumours.push(...remaining);
  return dropped;
}

export function slug(value) {
  return normaliseName(value).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Short names ("Gakpo") and full names ("Cody Gakpo") arrive from different
 * outlets for the same player. Fold the short form into the long one when the
 * mapping is unambiguous.
 */
function buildAliasMap(counts) {
  const keys = [...counts.keys()];
  const multi = keys.filter((k) => k.includes(' '));
  const alias = new Map();

  for (const key of keys) {
    if (key.includes(' ')) continue;
    const candidates = multi.filter((full) => full.split(' ').includes(key));
    if (candidates.length === 0) continue;
    // Prefer the most-mentioned full name; ties go to the longer string so we
    // land on the fullest version of the name.
    candidates.sort((a, b) => (counts.get(b) - counts.get(a)) || (b.length - a.length));
    alias.set(key, candidates[0]);
  }
  return alias;
}

export function buildRumours(articles, { now = Date.now() } = {}) {
  const relevant = articles.filter((article) => {
    if (!TRANSFER_CONTEXT.test(article.headline)) return false;
    // Requiring the club to be named costs us the occasional "Why we sold X"
    // headline on a club feed, but those feeds also carry general transfer
    // roundups and — observed in practice — horse racing. Naming the club is a
    // cheap, reliable filter.
    return mentionsSpurs(`${article.headline} ${article.outlet || ''}`);
  });

  // Pass 1 — collect people and learn who is already at the club.
  const squadHints = new Set();
  const nameCounts = new Map();
  const displayNames = new Map();

  const parsed = relevant.map((article) => {
    const people = extractPeople(article.headline);
    for (const hint of detectSquadHints(article.headline, people)) squadHints.add(hint);
    for (const person of people) {
      nameCounts.set(person.key, (nameCounts.get(person.key) ?? 0) + 1);
      const existing = displayNames.get(person.key);
      if (!existing || person.name.length > existing.length) {
        displayNames.set(person.key, person.name);
      }
    }
    return { article, people };
  });

  const aliases = buildAliasMap(nameCounts);
  const resolve = (key) => aliases.get(key) ?? key;
  // Squad knowledge learned under a short name should apply to the full name too.
  for (const hint of [...squadHints]) squadHints.add(resolve(hint));

  // Pass 2 — attach each headline to a (player, direction) bucket.
  const buckets = new Map();

  for (const { article, people } of parsed) {
    const clubs = otherClubs(article.headline);
    const tier = outletTier(article.outlet);
    const roundup = isRoundup(article.headline, clubs.length);

    for (const person of people) {
      const key = resolve(person.key);
      const { direction, confidence } = inferDirection(article.headline, key, { squadHints });
      const id = `${direction}-${slug(displayNames.get(key) ?? key)}`;

      if (!buckets.has(id)) {
        buckets.set(id, {
          id,
          player: displayNames.get(key) ?? person.name,
          playerKey: key,
          direction,
          directionConfidence: confidence,
          clubs: new Map(),
          articles: [],
        });
      }
      const bucket = buckets.get(id);
      bucket.directionConfidence = Math.max(bucket.directionConfidence, confidence);
      // Roundups name many clubs; attributing them to this rumour would be
      // guesswork, so only single-focus headlines contribute a club.
      if (!roundup) {
        for (const club of clubs) bucket.clubs.set(club, (bucket.clubs.get(club) ?? 0) + 1);
      }

      bucket.articles.push({
        outlet: article.outlet || 'Unknown source',
        tier,
        tierWeight: tierWeight(tier),
        headline: article.headline,
        url: article.url,
        publishedAt: article.publishedAt,
        source: article.source,
        roundup,
      });
    }
  }

  const rumours = [];
  for (const bucket of buckets.values()) {
    // A name that only ever appears in multi-club roundups is not a rumour we
    // can say anything useful about.
    if (bucket.articles.every((a) => a.roundup)) continue;
    // Neither is one article about a player from a single unranked blog.
    const distinctOutlets = new Set(bucket.articles.map((a) => a.outlet.toLowerCase())).size;
    const bestTier = Math.min(...bucket.articles.map((a) => a.tier));
    if (distinctOutlets < 2 && bestTier >= 4) continue;

    // An unfamiliar name carried by one aggregator headline is more often a
    // misparse than a player. But a reliable outlet naming a player once is
    // usually right — that is how women's-team signings, academy moves and loans
    // get reported — so this only applies below tier 3, and never to a headline
    // reporting a completed deal. Syndication means two outlets can carry one
    // identical headline, so count distinct headlines rather than articles.
    const known = isKnownPlayer(bucket.playerKey);
    const distinctHeadlines = new Set(
      bucket.articles.map((a) => a.headline.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()),
    ).size;
    const hasCompletion = bucket.articles.some(
      (a) => !a.roundup && classifyArticle(a.headline).stage.id === 'confirmed',
    );
    if (!known && distinctHeadlines < 2 && bestTier >= 3 && !hasCompletion) continue;

    const scored = scoreRumour(bucket.articles, now);
    const timestamps = bucket.articles
      .map((a) => (a.publishedAt ? new Date(a.publishedAt).getTime() : null))
      .filter((t) => t !== null);

    rumours.push({
      id: bucket.id,
      player: bucket.player,
      direction: bucket.direction,
      directionConfidence: Number(bucket.directionConfidence.toFixed(2)),
      clubs: [...bucket.clubs.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([club]) => club),
      probability: scored.probability,
      logit: scored.logit,
      done: scored.done,
      confirmedBy: scored.confirmedBy,
      stage: scored.stage,
      cooler: scored.cooler,
      breakdown: scored.breakdown,
      evidence: scored.evidence.map((a) => ({
        outlet: a.outlet,
        tier: a.tier,
        headline: a.headline,
        url: a.url,
        publishedAt: a.publishedAt,
        stage: a.stage.label,
        cooler: a.cooler ? a.cooler.label : null,
        recency: a.recency,
        contribution: a.contribution,
      })),
      latestAt: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
      earliestAt: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
    });
  }

  rumours.sort((a, b) => b.probability - a.probability || b.evidence.length - a.evidence.length);
  return { rumours, consideredArticles: relevant.length, squadHints: [...squadHints] };
}
