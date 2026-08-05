// Optional LLM review (OpenAI).
//
// The heuristic model runs on its own and the site works fine without this. When
// an API key is present, the model reviews rumours and may correct a misparsed
// player name, fix the direction, discard an entry that is not a real rumour,
// add a one-line rationale, and nudge the probability. The nudge is capped so
// the published number never drifts far from something the on-screen breakdown
// can still justify.
//
// Cost control matters here — the build runs eight times a day. Two measures:
//
//  1. Only rumours whose evidence actually changed since the last run are sent.
//     Reviews for unchanged rumours are reused from docs/data/llm-cache.json.
//     Most runs move very little, so this is the difference between reviewing
//     ~30 rumours per run and reviewing two or three.
//  2. A hard cap on how many are sent in any one run.
//
// The SDK is imported lazily so the heuristic-only build has no runtime
// dependencies at all.

import { createHash } from 'node:crypto';

const MAX_ADJUSTMENT = 18; // percentage points, either direction

// Configuration is read at call time, not module load, so it does not depend on
// import order.
const model = () => process.env.SPURS_LLM_MODEL || '';
const maxRumours = () => Number(process.env.SPURS_LLM_MAX_RUMOURS || 30);

function apiKey() {
  // The workflow maps whichever repository secret holds the key onto
  // OPENAI_API_KEY; the others are accepted so a local run needs no setup.
  return process.env.OPENAI_API_KEY || process.env.OPEN_AI_KEY
    || process.env.SPURSTRACKER || '';
}

const SYSTEM = `You review automatically extracted Tottenham Hotspur transfer rumours.

For each rumour you receive the parsed player, the direction (in = arrival at
Tottenham, out = departure), the heuristic probability, and the headlines the
probability was derived from, each tagged with its outlet reliability tier
(1 = most reliable, 4 = unranked).

For each rumour, return:
- player: the correct player name if the parsed one is wrong or incomplete, else unchanged.
- direction: "in" or "out", corrected if the headlines clearly say otherwise.
- adjustment: an integer from -18 to 18 percentage points to apply to the
  heuristic probability. Use 0 unless the headlines genuinely justify a change.
- note: one short sentence (max 20 words) explaining the current state of the rumour.
- discard: true only if this is not a real transfer rumour about this player.

Set discard when the named person is not the subject of a current transfer. This
is the most valuable correction you can make. Common cases:
- the headline quotes one player about another player's move;
- the real subject is described but unnamed ("USA striker", "Premier League
  defender") and a bystander's name was extracted;
- the headline is a match report, an opinion piece, or about a different club;
- the headline refers to a move the player completed in the past and is already
  settled — a player described as an existing squad member rather than someone
  arriving or leaving now. "Tottenham's new signing X said..." is about a deal
  that already happened; it is not a live rumour.

Judge whether a transfer is being *reported as happening now*. If the player is
simply at the club and being discussed, discard.

Judge only from the headlines provided. Do not use outside knowledge of whether a
transfer happened. Be conservative with adjustments: the heuristic already
accounts for source reliability, language strength, corroboration and recency.
Reserve larger adjustments for cases it clearly mishandled, such as a headline
whose meaning is inverted by context, or a denial scored as interest.`;

const SCHEMA = {
  type: 'object',
  properties: {
    reviews: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          player: { type: 'string' },
          direction: { type: 'string', enum: ['in', 'out'] },
          adjustment: { type: 'integer' },
          note: { type: 'string' },
          discard: { type: 'boolean' },
        },
        required: ['id', 'player', 'direction', 'adjustment', 'note', 'discard'],
        additionalProperties: false,
      },
    },
  },
  required: ['reviews'],
  additionalProperties: false,
};

/**
 * Fingerprint of the evidence behind a rumour. If this is unchanged, the
 * previous review still applies and the rumour does not need re-sending.
 */
export function evidenceSignature(rumour) {
  const parts = rumour.evidence
    .map((item) => `${item.outlet}|${item.headline}`)
    .sort();
  return createHash('sha1')
    .update(`${rumour.player}|${rumour.direction}|${parts.join('||')}`)
    .digest('hex')
    .slice(0, 16);
}

function buildPayload(rumours) {
  return rumours.map((rumour) => ({
    id: rumour.id,
    player: rumour.player,
    direction: rumour.direction,
    heuristicProbability: rumour.probability,
    stage: rumour.stage.label,
    headlines: rumour.evidence.slice(0, 8).map((item) => ({
      outlet: item.outlet,
      tier: item.tier,
      publishedAt: item.publishedAt,
      headline: item.headline,
    })),
  }));
}

function clampAdjustment(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-MAX_ADJUSTMENT, Math.min(MAX_ADJUSTMENT, Math.round(value)));
}

function applyReview(rumour, review) {
  const adjustment = clampAdjustment(review.adjustment);
  rumour.heuristicProbability = rumour.probability;
  rumour.llm = {
    adjustment,
    note: typeof review.note === 'string' ? review.note.slice(0, 200) : null,
    renamedFrom: review.player && review.player !== rumour.player ? rumour.player : null,
    redirectedFrom: review.direction && review.direction !== rumour.direction
      ? rumour.direction
      : null,
  };

  // A completed deal is not a probability, so leave confirmed entries alone.
  if (adjustment !== 0 && !rumour.done) {
    rumour.probability = Math.min(98, Math.max(2, rumour.probability + adjustment));
  }
  if (review.player && review.player.length <= 60) rumour.player = review.player;
  if (!rumour.done && (review.direction === 'in' || review.direction === 'out')) {
    rumour.direction = review.direction;
  }
}

/**
 * @param {Array} rumours - mutated in place; discarded entries are removed
 * @param {Object} cache - previous run's cache, `{ [id]: { signature, review } }`
 * @returns {Promise<{applied: boolean, cache: Object, reason?: string}>}
 */
export async function enrichRumours(rumours, cache = {}) {
  const nextCache = {};

  if (process.env.SPURS_DISABLE_LLM) {
    return { applied: false, cache, reason: 'disabled by SPURS_DISABLE_LLM' };
  }
  if (!apiKey()) {
    return { applied: false, cache, reason: 'no OPENAI_API_KEY set' };
  }
  const activeModel = model();
  if (!activeModel) {
    return {
      applied: false,
      cache,
      reason: 'no SPURS_LLM_MODEL set — see .github/workflows/update.yml',
    };
  }
  if (rumours.length === 0) {
    return { applied: false, cache, reason: 'nothing to review' };
  }

  // Split into rumours we already have a valid review for, and ones to send.
  const reused = [];
  const toReview = [];
  for (const rumour of rumours) {
    const signature = evidenceSignature(rumour);
    const cached = cache[rumour.id];
    if (cached && cached.signature === signature) {
      reused.push({ rumour, signature, review: cached.review });
    } else {
      toReview.push({ rumour, signature });
    }
  }

  const cap = maxRumours();
  const batch = toReview.slice(0, cap);
  // Anything over the cap keeps its heuristic score this run and gets picked up
  // next time, rather than being dropped or silently mis-cached.
  const deferred = toReview.slice(cap);

  let parsed = { reviews: [] };
  if (batch.length > 0) {
    let client;
    try {
      const { default: OpenAI } = await import('openai');
      client = new OpenAI({ apiKey: apiKey() });
    } catch (error) {
      return { applied: false, cache, reason: `openai package unavailable: ${error.message}` };
    }

    let response;
    try {
      response = await client.chat.completions.create({
        model: activeModel,
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: `Review these ${batch.length} rumours:\n\n${
              JSON.stringify(buildPayload(batch.map((entry) => entry.rumour)), null, 2)}`,
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'rumour_reviews', strict: true, schema: SCHEMA },
        },
      });
    } catch (error) {
      // Enrichment is a bonus, never a build blocker.
      return { applied: false, cache, reason: `API call failed: ${error.message}` };
    }

    const choice = response.choices?.[0];
    if (choice?.finish_reason === 'length') {
      return { applied: false, cache, reason: 'response truncated' };
    }
    if (choice?.message?.refusal) {
      return { applied: false, cache, reason: `model refused: ${choice.message.refusal}` };
    }

    const text = choice?.message?.content;
    if (!text) return { applied: false, cache, reason: 'empty response' };

    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { applied: false, cache, reason: `unparseable response: ${error.message}` };
    }
  }

  const reviewsById = new Map((parsed.reviews ?? []).map((review) => [review.id, review]));
  const bySignature = new Map(batch.map((entry) => [entry.rumour.id, entry.signature]));
  const discarded = new Set();
  let adjusted = 0;

  // Freshly reviewed.
  for (const { rumour, signature } of batch) {
    const review = reviewsById.get(rumour.id);
    if (!review) {
      // Model skipped it — leave the heuristic score and don't cache a guess.
      continue;
    }
    nextCache[rumour.id] = { signature, review };
    if (review.discard) {
      discarded.add(rumour.id);
      continue;
    }
    applyReview(rumour, review);
    if (clampAdjustment(review.adjustment) !== 0) adjusted += 1;
  }

  // Carried over from the cache.
  for (const { rumour, signature, review } of reused) {
    nextCache[rumour.id] = { signature, review };
    if (review.discard) {
      discarded.add(rumour.id);
      continue;
    }
    applyReview(rumour, review);
  }

  const kept = rumours.filter((rumour) => !discarded.has(rumour.id));
  rumours.length = 0;
  rumours.push(...kept);
  rumours.sort((a, b) => b.probability - a.probability || b.evidence.length - a.evidence.length);

  return {
    applied: true,
    cache: nextCache,
    model: activeModel,
    sent: batch.length,
    reusedFromCache: reused.length,
    deferred: deferred.length,
    adjusted,
    discarded: discarded.size,
  };
}
