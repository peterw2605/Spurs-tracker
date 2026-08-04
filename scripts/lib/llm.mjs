// Optional Claude enrichment.
//
// The heuristic model runs on its own and the site works fine without this. When
// ANTHROPIC_API_KEY is present, Claude reviews the top rumours and may nudge the
// probability, correct a misparsed player name, fix the direction, and add a
// one-line rationale. The nudge is capped so the published number never drifts
// far from something the on-screen breakdown can still justify.

// The SDK is imported lazily so the heuristic-only build has no runtime
// dependencies at all — useful for `npm run build:no-llm` and for running the
// pipeline before `npm install`.

const MODEL = process.env.SPURS_LLM_MODEL || 'claude-opus-5';
const MAX_RUMOURS = Number(process.env.SPURS_LLM_MAX_RUMOURS || 30);
const MAX_ADJUSTMENT = 18; // percentage points, either direction

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
- discard: true only if this is not a real transfer rumour (a match report, a
  misparsed name, a pundit's opinion piece with no underlying claim).

Judge only from the headlines provided. Do not use outside knowledge of whether a
transfer happened. Be conservative with adjustments: the heuristic already
accounts for source reliability, language strength, corroboration and recency.
Reserve larger adjustments for cases it clearly mishandled, such as a headline
whose meaning is inverted by context, or a denial the pattern matcher scored as
interest.`;

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

/**
 * @returns {Promise<{applied: boolean, model?: string, reviewed?: number, reason?: string}>}
 */
export async function enrichRumours(rumours) {
  if (process.env.SPURS_DISABLE_LLM) {
    return { applied: false, reason: 'disabled by SPURS_DISABLE_LLM' };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { applied: false, reason: 'no ANTHROPIC_API_KEY set' };
  }
  if (rumours.length === 0) {
    return { applied: false, reason: 'nothing to review' };
  }

  const subset = rumours.slice(0, MAX_RUMOURS);

  let client;
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic();
  } catch (error) {
    return { applied: false, reason: `@anthropic-ai/sdk unavailable: ${error.message}` };
  }

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: SCHEMA },
      },
      messages: [
        {
          role: 'user',
          content: `Review these ${subset.length} rumours:\n\n${JSON.stringify(buildPayload(subset), null, 2)}`,
        },
      ],
    });
  } catch (error) {
    // Enrichment is a bonus, never a build blocker.
    return { applied: false, reason: `API call failed: ${error.message}` };
  }

  if (response.stop_reason === 'refusal') {
    return { applied: false, reason: 'model declined the request' };
  }
  if (response.stop_reason === 'max_tokens') {
    return { applied: false, reason: 'response truncated at max_tokens' };
  }

  const text = response.content.find((block) => block.type === 'text')?.text;
  if (!text) return { applied: false, reason: 'no text block in response' };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { applied: false, reason: `unparseable response: ${error.message}` };
  }

  const byId = new Map(rumours.map((rumour) => [rumour.id, rumour]));
  let changed = 0;
  const discarded = new Set();

  for (const review of parsed.reviews ?? []) {
    const rumour = byId.get(review.id);
    if (!rumour) continue;

    if (review.discard) {
      discarded.add(review.id);
      continue;
    }

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

    if (adjustment !== 0) {
      rumour.probability = Math.min(98, Math.max(2, rumour.probability + adjustment));
      changed += 1;
    }
    if (review.player && review.player.length <= 60) rumour.player = review.player;
    if (review.direction === 'in' || review.direction === 'out') rumour.direction = review.direction;
  }

  const kept = rumours.filter((rumour) => !discarded.has(rumour.id));
  rumours.length = 0;
  rumours.push(...kept);
  rumours.sort((a, b) => b.probability - a.probability || b.evidence.length - a.evidence.length);

  return {
    applied: true,
    model: MODEL,
    reviewed: subset.length,
    adjusted: changed,
    discarded: discarded.size,
    usage: {
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
    },
  };
}
