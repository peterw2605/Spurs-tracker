#!/usr/bin/env node
// Fetch feeds -> extract rumours -> score -> write docs/data/*.json
//
// Run locally with `npm run build`. In CI this is invoked on a schedule and the
// resulting JSON is committed so that history (and therefore trend arrows)
// survives between runs.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { FEEDS, canonicalOutlet } from './lib/sources.mjs';
import { fetchText, parseFeed, splitTitleOutlet } from './lib/rss.mjs';
import { buildRumours } from './lib/cluster.mjs';
import { enrichRumours } from './lib/llm.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dataDir = join(root, 'docs', 'data');

const HISTORY_POINTS = 60;
// How long a completed deal stays on the Done board before it is retired.
const DONE_RETENTION_DAYS = 21;
const HISTORY_RETENTION_DAYS = 45;
const TREND_LOOKBACK_MS = 36 * 60 * 60 * 1000;
const MAX_AGE_DAYS = Number(process.env.SPURS_MAX_AGE_DAYS || 30);

function log(...args) {
  console.log('[build]', ...args);
}

async function collectArticles() {
  const sources = [];
  const articles = [];
  const seen = new Set();

  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => ({ feed, xml: await fetchText(feed.url) })),
  );

  for (const [index, result] of results.entries()) {
    const feed = FEEDS[index];
    if (result.status === 'rejected') {
      log(`FAILED ${feed.name}: ${result.reason?.message ?? result.reason}`);
      sources.push({ name: feed.name, ok: false, itemCount: 0, error: String(result.reason?.message ?? result.reason) });
      continue;
    }

    const items = parseFeed(result.value.xml);
    let kept = 0;

    for (const item of items) {
      const { headline, outlet } = splitTitleOutlet(item.rawTitle);
      const resolvedOutlet = canonicalOutlet(feed.outlet || outlet);
      // Dedupe on headline text: the same story arrives via several queries.
      const key = `${headline.toLowerCase()}|${(resolvedOutlet || '').toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (item.publishedAt) {
        const ageDays = (Date.now() - new Date(item.publishedAt).getTime()) / 86_400_000;
        if (ageDays > MAX_AGE_DAYS) continue;
      }

      articles.push({
        headline,
        outlet: resolvedOutlet,
        url: item.link,
        publishedAt: item.publishedAt,
        source: feed.name,
        // Club-specific feeds are Spurs by definition, even if the headline
        // never names the club.
        spursFeed: Boolean(feed.outlet),
      });
      kept += 1;
    }

    log(`ok ${feed.name}: ${items.length} items, ${kept} new`);
    sources.push({ name: feed.name, ok: true, itemCount: kept });
  }

  return { articles, sources };
}

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    log(`could not read ${path}: ${error.message}`);
    return fallback;
  }
}

function updateHistory(history, rumours, now) {
  const cutoff = now - HISTORY_RETENTION_DAYS * 86_400_000;
  const next = {};

  // Drop series for rumours that have gone quiet for a while.
  for (const [id, points] of Object.entries(history)) {
    const fresh = points.filter(([timestamp]) => timestamp >= cutoff);
    if (fresh.length) next[id] = fresh;
  }

  for (const rumour of rumours) {
    const series = next[rumour.id] ?? [];
    const last = series.at(-1);
    // Only append when the number actually moved, or an hour has passed.
    if (!last || last[1] !== rumour.probability || now - last[0] > 3_600_000) {
      series.push([now, rumour.probability]);
    }
    next[rumour.id] = series.slice(-HISTORY_POINTS);
  }

  return next;
}

/**
 * A completed transfer stays completed. Coverage of a done deal dries up within
 * days, and without this the recency decay would quietly walk a finished signing
 * back down the board as if it were still in doubt.
 *
 * Returns the updated ledger; mutates each rumour's done/probability in place.
 */
function applyDoneLedger(ledger, rumours, now) {
  const next = {};
  const cutoff = now - DONE_RETENTION_DAYS * 86_400_000;

  // Carry forward entries that are still inside the retention window AND still
  // clear the current confirmation bar. Re-validating rather than trusting the
  // file means a tightened rule retroactively evicts entries an earlier, looser
  // build wrote — otherwise a past false positive is pinned at 98% forever.
  for (const [id, entry] of Object.entries(ledger)) {
    if (entry.confirmedAt < cutoff) continue;
    const sources = entry.confirmedBy ?? [];
    const stillValid = sources.some((s) => s.tier === 1) || sources.length >= 2;
    if (stillValid) next[id] = entry;
    else log(`dropping stale done entry (no longer meets bar): ${entry.player}`);
  }

  for (const rumour of rumours) {
    if (rumour.done) {
      // Date the confirmation from the earliest article that reported it, not
      // from when this build first noticed. A deal completed three weeks ago
      // should not read "8m ago" because the ledger is new.
      const reportedAt = (rumour.confirmedBy ?? [])
        .map((s) => (s.publishedAt ? new Date(s.publishedAt).getTime() : null))
        .filter((t) => t !== null && t <= now);
      const existing = next[rumour.id];
      next[rumour.id] = {
        confirmedAt: existing?.confirmedAt
          ?? (reportedAt.length ? Math.min(...reportedAt) : now),
        player: rumour.player,
        direction: rumour.direction,
        clubs: rumour.clubs,
        confirmedBy: rumour.confirmedBy,
      };
    } else if (next[rumour.id]) {
      // Previously confirmed, current evidence has faded. Trust the earlier
      // confirmation rather than the decay.
      rumour.done = true;
      rumour.probability = 98;
      rumour.stage = { id: 'confirmed', label: 'Done / confirmed' };
      rumour.confirmedBy = next[rumour.id].confirmedBy ?? [];
      rumour.doneCarriedForward = true;
    }
    rumour.confirmedAt = rumour.done ? next[rumour.id].confirmedAt : null;
  }

  return next;
}

function attachTrends(rumours, history, now) {
  for (const rumour of rumours) {
    const series = history[rumour.id] ?? [];
    // Compare against the most recent point that is at least the lookback old,
    // so a burst of runs in one hour does not flatten the trend to zero.
    const older = [...series].reverse().find(([timestamp]) => now - timestamp >= TREND_LOOKBACK_MS);
    const reference = older ?? series[0];
    const previous = reference ? reference[1] : null;

    rumour.previousProbability = previous;
    rumour.change = previous === null ? null : rumour.probability - previous;
    rumour.isNew = series.length <= 1;
    rumour.history = series.map(([timestamp, probability]) => ({ t: timestamp, p: probability }));
  }
}

async function main() {
  const now = Date.now();
  log(`starting, ${FEEDS.length} feeds`);

  const { articles, sources } = await collectArticles();
  log(`${articles.length} unique articles collected`);

  const { rumours, consideredArticles, squadHints } = buildRumours(articles, { now });
  log(`${rumours.length} rumours from ${consideredArticles} transfer-related articles`);

  const llm = await enrichRumours(rumours);
  log(llm.applied
    ? `Claude review applied (${llm.model}): ${llm.adjusted} adjusted, ${llm.discarded} discarded`
    : `Claude review skipped: ${llm.reason}`);

  mkdirSync(dataDir, { recursive: true });

  // Sticky "done" is applied before history so a carried-forward confirmation
  // is what gets recorded, not the decayed score.
  const donePath = join(dataDir, 'done.json');
  const doneLedger = applyDoneLedger(loadJson(donePath, {}), rumours, now);

  const historyPath = join(dataDir, 'history.json');
  const history = updateHistory(loadJson(historyPath, {}), rumours, now);
  attachTrends(rumours, history, now);

  const done = rumours.filter((r) => r.done);
  const live = rumours.filter((r) => !r.done);
  const incoming = live.filter((r) => r.direction === 'in');
  const outgoing = live.filter((r) => r.direction === 'out');

  const payload = {
    generatedAt: new Date(now).toISOString(),
    counts: {
      rumours: live.length,
      incoming: incoming.length,
      outgoing: outgoing.length,
      done: done.length,
      articles: articles.length,
      transferArticles: consideredArticles,
      likely: live.filter((r) => r.probability >= 65).length,
    },
    model: {
      type: llm.applied ? 'heuristic + Claude review' : 'heuristic',
      llm: llm.applied
        ? { model: llm.model, reviewed: llm.reviewed, adjusted: llm.adjusted, discarded: llm.discarded }
        : { skipped: llm.reason },
    },
    sources,
    squadHints,
    rumours,
  };

  writeFileSync(join(dataDir, 'rumours.json'), `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(historyPath, `${JSON.stringify(history)}\n`);
  writeFileSync(donePath, `${JSON.stringify(doneLedger, null, 2)}\n`);

  log(`wrote docs/data/rumours.json (${incoming.length} in, ${outgoing.length} out, ${done.length} done)`);
  if (done.length) {
    log('completed:');
    for (const rumour of done) {
      const carried = rumour.doneCarriedForward ? ' (carried forward)' : '';
      log(`  DONE  ${rumour.direction.toUpperCase()}  ${rumour.player}${carried}`);
    }
  }
  log('live board:');
  for (const rumour of live.slice(0, 10)) {
    log(`  ${String(rumour.probability).padStart(3)}%  ${rumour.direction.toUpperCase()}  ${rumour.player}  — ${rumour.stage.label}`);
  }
}

main().catch((error) => {
  console.error('[build] fatal:', error);
  process.exit(1);
});
