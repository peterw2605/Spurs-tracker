# Spurs Transfer Tracker

Collects Tottenham Hotspur transfer stories from public news feeds, groups them
into one rumour per player, and scores each one with a probability you can audit
on screen. Runs as a scheduled GitHub Action and publishes a mobile-friendly
static site to GitHub Pages.

Arrivals and exits are tracked separately, and every rumour carries a trend
arrow showing which way it has moved.

---

## Setting it up

The repository is ready to run; two settings need turning on once.

**1. Enable Pages.** Repository → *Settings* → *Pages* → set **Source** to
**GitHub Actions**. No branch or folder to choose — the workflow uploads the
site itself.

**2. Allow the workflow to commit.** Repository → *Settings* → *Actions* →
*General* → *Workflow permissions* → **Read and write permissions**. The job
commits refreshed data back to the repo, which is what gives the trend arrows
something to compare against.

Then run the workflow once by hand (*Actions* → *Update tracker* → *Run
workflow*) rather than waiting for the schedule. When it finishes, the site URL
appears in the deploy job summary and under *Settings* → *Pages*.

On your phone, open that URL and use **Share → Add to Home Screen**. It is
installable as a standalone app — no App Store, no login.

### Optional: Claude review

The probability model works on its own. If you add an `ANTHROPIC_API_KEY`
secret (*Settings* → *Secrets and variables* → *Actions*), the build additionally
sends the top rumours to Claude, which can correct a misparsed player name, fix a
direction, add a one-line summary, and nudge the probability by up to ±18 points.
Cost is a few cents per day at the 3-hourly cadence. Remove the secret and the
build silently falls back to heuristics only.

---

## How the probability works

Everything is in `scripts/lib/score.mjs`, and the site shows the inputs for each
rumour so you can disagree with a number and see exactly why it landed there.

The model accumulates log-odds:

```
logit = prior (−1.75, about 15%)
      + Σ over outlets (tier weight × language strength × recency decay)
      + corroboration bonus
probability = sigmoid(logit), clamped to 2–98%
```

**Source reliability** — every outlet falls into a tier, from tier 1 (0.95
weight: The Athletic, BBC, Sky, the broadsheets, the established reporters) down
to tier 4 (0.16: unranked blogs and syndicated rewrites). Tiers live in
`scripts/lib/sources.mjs`.

**Language strength** — the headline sets a stage: done/confirmed (3.2),
imminent (1.9), advanced talks (0.95), interest (0.2), mention only (0.05).
Cooling language subtracts: deal off (−2.6), rejected or not for sale (−1.7),
cooling or denied (−1.1), rival competition (−0.55).

**Corroboration** — independent tier 1–2 outlets agreeing add up to +0.75, and
each additional outlet's contribution is damped by `1 / (1 + 0.4k)`. Twenty
tabloids repeating each other is not twenty confirmations.

**Recency** — evidence decays with a nine-day half-life, floored at 0.2, so old
links fade without being deleted.

### Completed deals

A transfer that has already happened is an outcome, not a probability, so it
moves to the **Done** tab and stops competing with live rumours.

A deal counts as done when **one tier-1 outlet** reports it complete, or **two
independent outlets** do. One mid-tier headline is deliberately not enough:
completion wording gets attached to the wrong player often enough — *"Tottenham's
new signing: Pedro Porro was the reason the deal was completed"* is about
somebody else's transfer — that a single source can't carry the claim. Those show
as *"Reported complete (1 source)"* and stay on the live board, scored at
imminent-level weight rather than confirmed, until something corroborates them.

Completion detection tolerates the fee sitting inside the phrase, which is how
these headlines are actually written: `complete £50m deal`, `seal £100m move
for`, `seal signing of X for club record £46m`. Matching `complete\s+deal`
misses all three. A speculation guard prevents `tipped to sign` from reading as
a completed signing, while still allowing `complete £50m deal to sign X`.

Once done, a deal **stays** done — recorded in `docs/data/done.json` so fading
coverage can't walk a finished signing back down the board. Entries are
re-validated against the current bar on every build, so tightening the rule
retroactively evicts anything an earlier, looser build wrote, and they retire
after 21 days.

Three further guards against the noise that dominates transfer coverage:

- **One article per outlet.** Only each outlet's strongest headline counts, so a
  busy transfer desk republishing all day cannot out-vote a single tier-1 report.
- **Roundups are demoted.** Multi-club live blogs and gossip columns count as a
  mention only — a "done deal" in a ten-club headline usually belongs to someone
  else's transfer.
- **Outlets are canonicalised.** "Evening Standard" and "London Evening
  Standard" are one publisher, not two independent sources.

Positive and negative evidence are damped separately, so a pile of weak links
cannot bury one credible denial.

### What it is not

These numbers describe **what the press is reporting**, not what the club is
doing. There is no inside information here, and a well-sourced story can still
be wrong. Treat a high number as "widely and credibly reported" rather than
"probably happening", and read the linked articles before believing any of it.

---

## Layout

```
scripts/
  build.mjs            fetch → cluster → score → write JSON
  serve.mjs            local static server for previewing docs/
  lib/rss.mjs          dependency-free RSS/Atom reader
  lib/sources.mjs      feed list, outlet tiers, outlet aliases
  lib/entities.mjs     player/club extraction, arrival-vs-exit inference
  lib/score.mjs        the probability model
  lib/cluster.mjs      groups headlines into one rumour per (player, direction)
  lib/llm.mjs          optional Claude review (lazily imported)
data/squad.json        editable roster — improves direction calls
docs/                  the published site (GitHub Pages serves this folder)
docs/data/rumours.json current board, committed each run
docs/data/history.json probability history, drives the trend arrows
docs/data/done.json     completed-deal ledger, keeps done deals done
```

## Running locally

```bash
node scripts/build.mjs     # fetch feeds and rebuild docs/data
npm run serve              # then open http://localhost:8080
```

The fetch-and-score pipeline has **no dependencies** — plain Node 20+. `npm
install` is only needed for the optional Claude review. To skip that layer even
with a key present:

```bash
npm run build:no-llm
```

Useful environment variables:

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` | Enables the Claude review layer |
| `SPURS_DISABLE_LLM` | Forces heuristics only |
| `SPURS_LLM_MODEL` | Override the model (default `claude-opus-5`) |
| `SPURS_MAX_AGE_DAYS` | Ignore articles older than this (default 30) |

## Tuning it

- **Wrong arrival/exit calls, or staff treated as targets** — edit
  `data/squad.json`. The build also infers squad membership at runtime from
  phrases like "Tottenham's <name>", so a stale roster degrades gracefully.
- **An outlet is weighted wrongly** — move it between tiers in
  `scripts/lib/sources.mjs`.
- **Probabilities feel systematically high or low** — adjust `PRIOR_LOGIT` or the
  stage values in `scripts/lib/score.mjs`.
- **A source is missing** — add its RSS URL to `FEEDS`. Reddit and TBR Football
  block automated requests, which is why they are absent.

## Known limitations

- Player names are extracted from headlines with heuristics, so an unusual name
  or a headline typo can produce an odd entry. The evidence links make these easy
  to spot, and the Claude review layer catches most of them.
- The heuristics can't tell who a sentence is *about*. When a headline quotes one
  player about another's transfer, the completion wording may attach to the
  quoted name — the confirmation bar stops that reaching the Done tab, but it can
  still inflate a live rumour. Discarding these is the clearest thing the Claude
  review layer adds.
- Feeds occasionally return 403 to automated clients. The build treats a failed
  feed as non-fatal and the site reports which sources were unavailable.
- Trend arrows need at least two runs of history before they mean anything.
