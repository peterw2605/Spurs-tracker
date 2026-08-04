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

  const historyPath = join(dataDir, 'history.json');
  const history = updateHistory(loadJson(historyPath, {}), rumours, now);
  attachTrends(rumours, history, now);

  const incoming = rumours.filter((r) => r.direction === 'in');
  const outgoing = rumours.filter((r) => r.direction === 'out');

  const payload = {
    generatedAt: new Date(now).toISOString(),
    counts: {
      rumours: rumours.length,
      incoming: incoming.length,
      outgoing: outgoing.length,
      articles: articles.length,
      transferArticles: consideredArticles,
      likely: rumours.filter((r) => r.probability >= 65).length,
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

  log(`wrote docs/data/rumours.json (${incoming.length} in, ${outgoing.length} out)`);
  for (const rumour of rumours.slice(0, 10)) {
    log(`  ${String(rumour.probability).padStart(3)}%  ${rumour.direction.toUpperCase()}  ${rumour.player}  — ${rumour.stage.label}`);
  }
}

main().catch((error) => {
  console.error('[build] fatal:', error);
  process.exit(1);
});
