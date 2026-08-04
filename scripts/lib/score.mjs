// The probability model.
//
// Every number the UI shows is produced here, and every step is designed to be
// explainable in one line on screen. The shape is a log-odds accumulation:
//
//   logit = PRIOR
//         + sum over outlets of (tier weight x stage strength x recency decay)
//           with diminishing returns applied per additional outlet
//         + a small corroboration bonus for independent agreement
//
//   probability = sigmoid(logit), clamped to [2, 98]
//
// Two deliberate choices worth knowing about:
//
//  1. Only the strongest article per outlet counts. Transfer desks republish the
//     same claim all day; without this, one busy aggregator could out-vote The
//     Athletic.
//  2. Contributions get diminishing returns (1 / (1 + 0.4k)). Twenty tabloids
//     repeating each other is not the same as twenty independent confirmations,
//     so agreement raises the number without ever pinning it to certainty.

export const PRIOR_LOGIT = -1.75; // ~14.8% for a single unremarkable mention

// Speculative markers. A headline carrying one of these is reporting a
// possibility, not an outcome, so it can never reach the `confirmed` stage no
// matter which completion verb it also contains ("Tottenham tipped to sign X").
//
// Kept deliberately narrow: phrases like "to sign", "move for", "bid" and
// "talks" all appear inside genuinely completed-deal headlines ("Brighton
// complete £50m deal to sign Tottenham defender"), so they are not listed here.
const SPECULATION_GUARD = [
  /\btipped\b/i,
  /\bset\s+to\b/i,
  /\bexpected\s+to\b/i,
  /\b(?:could|would|might|may)\b/i,
  /\breportedly\b/i,
  /\brumou?rs?\b/i,
  /\blinked\s+with\b/i,
  /\binterested\s+in\b/i,
  /\b(?:eyeing|targeting|chasing|pursuing|monitoring|scouting|weighing|considering)\b/i,
  /\bwants?\s+to\b/i,
  /\bhop(?:e|es|ing)\s+to\b/i,
  /\bin\s+talks\b/i,
  /\bclosing\s+in\b/i,
  /\bon\s+the\s+verge\b/i,
  /\bpoised\s+to\b/i,
  /\burged\s+to\b/i,
  /\b(?:shortlist|wishlist)\b/i,
  /\btouted\b/i,
  /\bplot(?:s|ting)?\b/i,
  /\b(?:edging|inching|moving)\s+closer\b/i,
  /\bcloser\s+to\b/i,
  /\bnearing\b/i,
];

export function isSpeculative(headline) {
  return SPECULATION_GUARD.some((re) => re.test(headline));
}

// Language stages, strongest first. The first pattern that matches an article
// sets its stage, so order matters: "medical booked" should beat "interested in"
// when a headline contains both.
export const STAGES = [
  {
    id: 'confirmed',
    label: 'Done / confirmed',
    value: 3.2,
    // Every pattern here tolerates an intervening fee or descriptor, because
    // that is how completed deals are actually written: "complete £50m deal",
    // "seal £100m move for", "seal signing of X for club record £46m". Matching
    // `complete\s+deal` misses all of them.
    guardedBySpeculation: true,
    patterns: [
      /\b(?:done deal|deal done|deal is done|here we go)\b/i,
      // seal / complete / finalise ... signing|transfer|move|deal|switch
      /\b(?:seal|seals|sealed|sealing|complete|completes|completed|completing|wrap(?:s|ped)?\s+up|finalis\w+|finaliz\w+)\b[^.!?]{0,45}?\b(?:signing|transfer|move|deal|switch|arrival|departure|capture)\b/i,
      // ... deal|move|transfer is complete|confirmed|official|done
      /\b(?:signing|transfer|move|deal)\b[^.!?]{0,30}?\b(?:complete|completed|confirmed|official|finalised|finalized|is\s+done)\b/i,
      // "signs for Brighton", "joined with", and "joins Brighton from Tottenham"
      /\b(?:signs?|signed|joins?|joined)\s+(?:for|with)\s+\p{Lu}/u,
      /\b(?:joins|joined)\s+\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)?\s+(?:from|on\s+a)\b/u,
      // present-tense club action: "Tottenham sign Italy midfielder"
      /\b(?:tottenham|spurs)\s+(?:sign|signs)\s+(?:\p{Lu}|the\b|\d|£|new\b|a\s+\p{Lu})/u,
      /\p{Lu}[\p{L}'’-]+\s+(?:sign|signs)\s+(?:\p{Lu}[\p{L}'’-]+\s+)?(?:defender|midfielder|forward|striker|winger|goalkeeper|keeper)\b/u,
      // "have sold", "has signed", "have completed"
      /\b(?:has|have|had)\s+(?:sold|signed|completed|joined|left)\b/i,
      /\bsold\b/i,
      // Announcements and unveilings. The negative lookahead matters: "club
      // chief confirms transfer talks" confirms the talks, not the transfer.
      /\b(?:announce|announces|announced|unveil|unveils|unveiled|confirm|confirms|confirmed)\b[^.!?]{0,30}?\b(?:signing|arrival|transfer|deal|capture|departure)\b(?!\s+(?:talks|interest|negotiations|rumou?rs|saga|target))/i,
      /\b(?:officially|official)\s+(?:sign|signed|announce|announced|confirmed|unveiled|joined)\b/i,
      /\bmedical\s+(?:complete|completed|passed)\b/i,
      /\bshirt\s+number\s+(?:confirmed|revealed|handed)\b/i,
      /\bfirst\s+(?:words|interview)\s+(?:as|after)\b/i,
    ],
  },
  {
    id: 'imminent',
    label: 'Imminent',
    value: 1.9,
    patterns: [
      /\bmedical\s+(?:booked|scheduled|set|arranged)\b/i,
      /\b(?:undergo|undergoing|set for)\s+(?:a\s+)?medical\b/i,
      /\b(?:agree|agreed|reach|reached)\s+(?:a\s+)?(?:deal|fee|agreement|terms)\b/i,
      /\bpersonal\s+terms\s+(?:agreed|settled|done)\b/i,
      /\bfee\s+agreed\b/i,
      /\b(?:set|poised|ready)\s+to\s+(?:sign|join|complete|seal|move)\b/i,
      /\bon\s+the\s+verge\b/i,
      /\bclosing\s+in\s+on\b/i,
      /\bcloses?\s+in\s+on\b/i,
      /\bfinal\s+stages\b/i,
      /\bimminent\b/i,
      /\bpaperwork\b/i,
      /\bboard(?:ed|ing)?\s+a\s+(?:flight|plane)\b/i,
    ],
  },
  {
    id: 'advanced',
    label: 'Advanced talks',
    value: 0.95,
    patterns: [
      /\badvanced\s+(?:talks|negotiations|stage|discussions)\b/i,
      /\bin\s+(?:talks|negotiations|discussions)\b/i,
      /\b(?:open|opened|held|hold|step(?:ped)?\s+up)\s+(?:talks|negotiations|discussions)\b/i,
      /\bverbal\s+agreement\b/i,
      /\b(?:submit|submitted|table|tabled|lodge|lodged|make|made|prepare|preparing)\s+(?:a\s+|an\s+)?(?:bid|offer|proposal)\b/i,
      /\b(?:improved|second|fresh|new|opening)\s+(?:bid|offer)\b/i,
      /\b(?:bid|offer)\s+(?:accepted|approved)\b/i,
      /\bnegotiat(?:e|ing|ions)\b/i,
      /\bswap\s+deal\s+(?:proposed|discussed)\b/i,
      /\bconcrete\s+interest\b/i,
      /\bpriorit(?:y|ise|ised|izing|ising)\b/i,
    ],
  },
  {
    id: 'interest',
    label: 'Interest / link',
    value: 0.2,
    patterns: [
      /\b(?:interested|interest)\b/i,
      /\b(?:keen|keen on)\b/i,
      /\b(?:eye|eyes|eyeing|eyed)\b/i,
      /\b(?:target|targets|targeting|targeted)\b/i,
      /\b(?:link|links|linked)\b/i,
      /\b(?:monitor|monitoring|monitored|track|tracking|watch|watching|scout|scouting)\b/i,
      /\b(?:consider|considering|weigh|weighing|mull|mulling|explore|exploring)\b/i,
      /\b(?:want|wants|wanted|chase|chasing|pursue|pursuing|hunt|hunting)\b/i,
      /\bon\s+(?:the\s+)?(?:radar|shortlist|wishlist|list)\b/i,
      /\b(?:shortlist|wishlist|shortlisted)\b/i,
      /\b(?:enquiry|enquiries|inquiry|asked about|approach)\b/i,
      /\b(?:offered|touted|pitched|available)\b/i,
      /\b(?:could|may|might)\s+(?:sign|join|move|leave|sell)\b/i,
      /\bidentif(?:y|ied|ies)\b/i,
    ],
  },
];

// Applied on top of whatever stage matched. Cooling language is the single most
// useful correction available from a headline, so it is weighted to matter.
export const COOLERS = [
  { id: 'collapsed', label: 'Deal off', value: -2.6, patterns: [
    /\b(?:deal|move|transfer)\s+(?:off|collapsed|collapses|dead|called off)\b/i,
    /\b(?:pull|pulled|pulls)\s+out\b/i,
    /\b(?:end|ends|ended)\s+(?:their\s+)?interest\b/i,
    /\b(?:abandon|abandoned|scrap|scrapped|shelve|shelved)\b/i,
    /\boff\s+the\s+table\b/i,
    /\bno\s+longer\s+(?:a\s+target|interested|pursuing)\b/i,
  ] },
  { id: 'rejected', label: 'Rejected / not for sale', value: -1.7, patterns: [
    /\b(?:reject|rejects|rejected|turn down|turns down|turned down|knock back|knocked back)\b/i,
    /\bnot\s+for\s+sale\b/i,
    /\b(?:rule|rules|ruled)\s+out\b/i,
    /\bno\s+(?:plans|intention|interest)\b/i,
    /\brefuse[sd]?\b/i,
    /\bslam\s+the\s+door\b/i,
    /\bunwilling\s+to\s+sell\b/i,
  ] },
  { id: 'cooling', label: 'Cooling', value: -1.1, patterns: [
    /\b(?:cool|cools|cooled|cooling)\s+(?:their\s+)?interest\b/i,
    /\binterest\s+(?:cools|cooled|has cooled)\b/i,
    /\b(?:priced|price)\d*\s*out\b/i,
    /\bpriced\s+out\b/i,
    /\bdistance\s+(?:themselves|itself)\b/i,
    /\b(?:deny|denies|denied|dismiss|dismisses|dismissed)\b/i,
    /\bno\s+truth\b/i,
    /\bwide\s+of\s+the\s+mark\b/i,
    /\bset\s+to\s+miss\s+out\b/i,
    /\bmiss(?:es|ed)?\s+out\s+on\b/i,
    /\b(?:stall|stalls|stalled|stalling|snag|hitch|standoff|stand-off|impasse|deadlock)\b/i,
    /\bclarif(?:y|ies|ied)\b/i,
  ] },
  { id: 'rival', label: 'Rival competition', value: -0.55, patterns: [
    /\b(?:beat|beats|pip|pips|pipped)\s+(?:tottenham|spurs)\s+to\b/i,
    /\bahead\s+of\s+(?:tottenham|spurs)\b/i,
    /\b(?:hijack|hijacks|hijacked)\b/i,
    /\brival\s+(?:bid|offer|interest)\b/i,
    /\bcompetition\s+from\b/i,
    /\b(?:prefer|prefers|preferred)\s+(?:a\s+)?move\s+to\b/i,
  ] },
];

export function classifyArticle(headline, { roundup = false } = {}) {
  // A live blog covering ten clubs mentions "done deal" about somebody — just
  // not necessarily the player we are scoring. Count it as a mention only.
  if (roundup) {
    return { stage: { id: 'roundup', label: 'Named in a roundup', value: 0.05 }, cooler: null };
  }
  let stage = { id: 'mention', label: 'Mentioned only', value: 0.05 };
  const speculative = isSpeculative(headline);
  for (const candidate of STAGES) {
    // "Tottenham tipped to sign X" contains a completion verb but reports a
    // possibility, so guarded stages are skipped when speculation is present.
    if (candidate.guardedBySpeculation && speculative) continue;
    if (candidate.patterns.some((re) => re.test(headline))) {
      stage = { id: candidate.id, label: candidate.label, value: candidate.value };
      break;
    }
  }
  const coolers = [];
  for (const cooler of COOLERS) {
    if (cooler.patterns.some((re) => re.test(headline))) {
      coolers.push({ id: cooler.id, label: cooler.label, value: cooler.value });
    }
  }
  // Only the strongest cooler applies — "rejected" and "cooling" in one headline
  // is one piece of news, not two.
  const cooler = coolers.sort((a, b) => a.value - b.value)[0] ?? null;
  return { stage, cooler };
}

const HALF_LIFE_DAYS = 9;
const MIN_RECENCY = 0.2;

export function recencyFactor(publishedAt, now) {
  if (!publishedAt) return 0.5;
  const ageDays = Math.max(0, (now - new Date(publishedAt).getTime()) / 86_400_000);
  const decayed = 0.5 ** (ageDays / HALF_LIFE_DAYS);
  return Math.max(MIN_RECENCY, Math.min(1, decayed));
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Score one rumour from its evidence.
 *
 * @param {Array} articles - {outlet, tier, tierWeight, headline, url, publishedAt}
 * @param {number} now - epoch ms
 * @returns {{probability:number, logit:number, evidence:Array, breakdown:Object, stage:Object}}
 */
export function scoreRumour(articles, now = Date.now()) {
  const raw = articles.map((article) => ({
    article,
    ...classifyArticle(article.headline, { roundup: article.roundup }),
  }));

  // Decide whether the deal is actually done before scoring, because the answer
  // changes how much a completion headline is worth. The bar is one tier-1
  // outlet, or two independent outlets of any tier: completion verbs get
  // attached to the wrong player often enough ("Tottenham's new signing: Pedro
  // Porro was the reason the deal was completed") that one mid-tier headline
  // cannot carry the claim.
  const confirmedOutlets = new Map();
  for (const { article, stage } of raw) {
    if (stage.id !== 'confirmed') continue;
    const key = (article.outlet || 'unknown').toLowerCase();
    const tier = Math.min(confirmedOutlets.get(key) ?? 9, article.tier);
    confirmedOutlets.set(key, tier);
  }
  const confirmedTiers = [...confirmedOutlets.values()];
  const done = confirmedTiers.includes(1) || confirmedTiers.length >= 2;

  // An uncorroborated completion report is downgraded in weight as well as in
  // label — otherwise one misattributed headline alone reads as a coin flip.
  const UNVERIFIED_STAGE = {
    id: 'confirmed_unverified',
    label: 'Reported complete (1 source)',
    value: 1.9,
  };

  const classified = raw.map(({ article, stage, cooler }) => {
    const effectiveStage = !done && stage.id === 'confirmed' ? UNVERIFIED_STAGE : stage;
    const recency = recencyFactor(article.publishedAt, now);
    const strength = effectiveStage.value + (cooler ? cooler.value : 0);
    return {
      ...article,
      stage: effectiveStage,
      cooler,
      recency: Number(recency.toFixed(3)),
      // Raw per-article strength before per-outlet dedupe and damping.
      rawContribution: article.tierWeight * strength * recency,
    };
  });

  // Keep the single most informative article per outlet. "Most informative"
  // means largest absolute contribution, so a tier-1 denial is not discarded in
  // favour of that outlet's earlier neutral mention.
  const bestPerOutlet = new Map();
  for (const article of classified) {
    const key = (article.outlet || 'unknown').toLowerCase();
    const existing = bestPerOutlet.get(key);
    if (!existing || Math.abs(article.rawContribution) > Math.abs(existing.rawContribution)) {
      bestPerOutlet.set(key, article);
    }
  }

  // Positive and negative evidence are damped separately, so a pile of weak
  // positives cannot drown out one strong denial.
  const distinct = [...bestPerOutlet.values()];
  const positives = distinct.filter((a) => a.rawContribution > 0)
    .sort((a, b) => b.rawContribution - a.rawContribution);
  const negatives = distinct.filter((a) => a.rawContribution < 0)
    .sort((a, b) => a.rawContribution - b.rawContribution);

  const damp = (list) => list.map((article, index) => {
    const factor = 1 / (1 + 0.4 * index);
    return { ...article, dampingFactor: Number(factor.toFixed(3)),
      contribution: Number((article.rawContribution * factor).toFixed(4)) };
  });

  const scored = [...damp(positives), ...damp(negatives)];
  const neutral = distinct
    .filter((a) => a.rawContribution === 0)
    .map((a) => ({ ...a, dampingFactor: 1, contribution: 0 }));
  const evidence = [...scored, ...neutral];

  const evidenceSum = evidence.reduce((sum, a) => sum + a.contribution, 0);

  // Independent agreement is worth a little beyond the sum of its parts, but
  // only when the corroborating outlets are actually credible.
  const credibleAgreeing = positives.filter((a) => a.tier <= 2 && a.stage.id !== 'mention').length;
  const corroboration = credibleAgreeing >= 2
    ? Math.min(0.75, 0.25 * (credibleAgreeing - 1))
    : 0;

  const logit = PRIOR_LOGIT + evidenceSum + corroboration;
  let probability = sigmoid(logit) * 100;

  // A transfer that has actually happened is not a probability any more. Treat
  // it as done when a reliable outlet reports completion, or when two outlets of
  // any tier agree on it.
  // A transfer that has actually happened is not a probability any more.
  if (done) probability = 98;

  probability = Math.min(98, Math.max(2, probability));

  const strongest = positives[0]?.stage ?? { id: 'mention', label: 'Mentioned only' };
  const activeCooler = negatives[0]?.cooler ?? null;

  return {
    probability: Math.round(probability),
    logit: Number(logit.toFixed(4)),
    done,
    confirmedBy: done
      ? raw
        .filter((r) => r.stage.id === 'confirmed')
        .map((r) => r.article)
        .sort((a, b) => a.tier - b.tier)
        .slice(0, 3)
        .map((a) => ({
          outlet: a.outlet,
          tier: a.tier,
          headline: a.headline,
          url: a.url,
          publishedAt: a.publishedAt,
        }))
      : [],
    stage: strongest,
    cooler: activeCooler,
    evidence: evidence.sort((a, b) => {
      const timeA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const timeB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return timeB - timeA;
    }),
    breakdown: {
      prior: PRIOR_LOGIT,
      evidenceSum: Number(evidenceSum.toFixed(4)),
      corroboration: Number(corroboration.toFixed(4)),
      distinctOutlets: distinct.length,
      tier1Outlets: distinct.filter((a) => a.tier === 1).length,
      totalArticles: articles.length,
      confirmedFloorApplied: done,
    },
  };
}
