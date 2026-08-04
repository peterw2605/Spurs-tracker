// Renders docs/data/rumours.json. No build step, no framework — the JSON is
// already in the exact shape the board needs.

const state = {
  data: null,
  filter: 'live',
  query: '',
  sort: 'probability',
};

const board = document.getElementById('board');
const subtitle = document.getElementById('subtitle');
const statsEl = document.getElementById('stats');
const sourcesNote = document.getElementById('sources-note');
const searchInput = document.getElementById('search');
const sortSelect = document.getElementById('sort');

function probabilityClass(p) {
  if (p >= 80) return 'p-high';
  if (p >= 60) return 'p-good';
  if (p >= 40) return 'p-mid';
  if (p >= 20) return 'p-low';
  return 'p-cold';
}

function relativeTime(iso) {
  if (!iso) return 'date unknown';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'date unknown';
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Tiny inline sparkline of the probability history. */
function sparkline(history) {
  if (!history || history.length < 3) return '';
  const width = 54;
  const height = 18;
  const values = history.map((point) => point.p);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  const step = width / (values.length - 1);
  const points = values
    .map((value, index) => {
      const x = (index * step).toFixed(1);
      const y = (height - ((value - min) / span) * (height - 2) - 1).toFixed(1);
      return `${x},${y}`;
    })
    .join(' ');
  const rising = values.at(-1) >= values[0];
  const stroke = rising ? 'var(--up)' : 'var(--down)';
  return `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
    aria-hidden="true"><polyline fill="none" stroke="${stroke}" stroke-width="1.6"
    stroke-linejoin="round" stroke-linecap="round" points="${points}" /></svg>`;
}

function trendBlock(rumour) {
  const spark = sparkline(rumour.history);
  if (rumour.isNew || rumour.change === null) {
    return `<div class="trend"><span class="delta delta-flat">new</span>${spark}</div>`;
  }
  if (rumour.change === 0) {
    return `<div class="trend"><span class="delta delta-flat">–</span>${spark}</div>`;
  }
  const up = rumour.change > 0;
  const cls = up ? 'delta-up' : 'delta-down';
  const arrow = up ? '▲' : '▼';
  return `<div class="trend"><span class="delta ${cls}">${arrow} ${Math.abs(rumour.change)}</span>${spark}</div>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function mathsSummary(rumour) {
  const b = rumour.breakdown;
  const parts = [
    `<strong>${b.distinctOutlets}</strong> outlet${b.distinctOutlets === 1 ? '' : 's'}`,
    `<strong>${b.tier1Outlets}</strong> tier&nbsp;1`,
    `strongest claim: <strong>${escapeHtml(rumour.stage.label)}</strong>`,
  ];
  if (rumour.cooler) parts.push(`pushback: <strong>${escapeHtml(rumour.cooler.label)}</strong>`);
  if (rumour.done) {
    const who = (rumour.confirmedBy ?? []).map((s) => s.outlet).join(', ');
    parts.push(`<strong>completed</strong>${who ? ` — reported by ${escapeHtml(who)}` : ''}`);
    if (rumour.doneCarriedForward) {
      parts.push('held from an earlier confirmation as coverage faded');
    }
  }

  let note = '';
  if (rumour.llm?.note) {
    const adj = rumour.llm.adjustment;
    const adjText = adj ? ` (Claude adjusted by ${adj > 0 ? '+' : ''}${adj} points)` : '';
    note = `<span class="llm-note">${escapeHtml(rumour.llm.note)}${adjText}</span>`;
  }
  return `<p class="maths">${parts.join(' · ')}${note}</p>`;
}

function evidenceList(rumour) {
  const items = rumour.evidence
    .map((item) => {
      const link = item.url
        ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.headline)}</a>`
        : escapeHtml(item.headline);
      const cooler = item.cooler ? ` · ${escapeHtml(item.cooler)}` : '';
      return `<li class="tier-${item.tier}">
        ${link}
        <div class="row">
          <span>${escapeHtml(item.outlet)}</span>
          <span>tier ${item.tier}</span>
          <span>${escapeHtml(item.stage)}${cooler}</span>
          <span>${relativeTime(item.publishedAt)}</span>
        </div>
      </li>`;
    })
    .join('');
  return `<p class="evidence-title">Evidence (${rumour.evidence.length})</p><ul class="evidence">${items}</ul>`;
}

function card(rumour) {
  const directionChip = rumour.direction === 'in'
    ? '<span class="chip chip-in">ARRIVAL</span>'
    : '<span class="chip chip-out">EXIT</span>';
  const newChip = rumour.isNew && !rumour.done ? '<span class="chip chip-new">NEW</span>' : '';
  const coolChip = rumour.cooler ? '<span class="chip chip-cool">PUSHBACK</span>' : '';
  const doneChip = rumour.done ? '<span class="chip chip-done">DONE</span>' : '';
  const clubs = rumour.clubs.length
    ? `<span>${escapeHtml(rumour.clubs.join(' · '))}</span>`
    : '';

  // A completed deal shows a tick rather than a percentage — putting "98%" on a
  // transfer that has already happened invites the wrong reading.
  const gauge = rumour.done
    ? '<span class="gauge is-done"><span class="value">✓</span><span class="unit">DONE</span></span>'
    : `<span class="gauge ${probabilityClass(rumour.probability)}">
        <span class="value">${rumour.probability}</span><span class="unit">PCT</span>
      </span>`;

  return `<details class="rumour${rumour.done ? ' is-done' : ''}" data-id="${escapeHtml(rumour.id)}">
    <summary>
      ${gauge}
      <span class="headline-block">
        <span class="player">${escapeHtml(rumour.player)}</span>
        <span class="tagline">
          ${directionChip}${doneChip}${newChip}${coolChip}
          ${clubs}
          ${rumour.done ? '' : `<span>${escapeHtml(rumour.stage.label)}</span>`}
          <span>${relativeTime(rumour.done ? rumour.confirmedAt : rumour.latestAt)}</span>
        </span>
      </span>
      ${rumour.done ? '' : trendBlock(rumour)}
    </summary>
    <div class="detail">
      ${mathsSummary(rumour)}
      ${evidenceList(rumour)}
    </div>
  </details>`;
}

function visibleRumours() {
  const { data, filter, query, sort } = state;
  let list = data.rumours;

  // Completed deals live in their own tab — they are outcomes, not open questions.
  if (filter === 'done') list = list.filter((rumour) => rumour.done);
  else if (filter === 'live') list = list.filter((rumour) => !rumour.done);
  else list = list.filter((rumour) => !rumour.done && rumour.direction === filter);

  if (query) {
    const needle = query.toLowerCase();
    list = list.filter((rumour) =>
      rumour.player.toLowerCase().includes(needle) ||
      rumour.clubs.some((club) => club.toLowerCase().includes(needle)) ||
      rumour.evidence.some((item) => item.headline.toLowerCase().includes(needle)));
  }

  const byTime = (rumour) => (rumour.latestAt ? new Date(rumour.latestAt).getTime() : 0);
  const sorted = [...list];
  if (sort === 'movement') {
    sorted.sort((a, b) => Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0)
      || b.probability - a.probability);
  } else if (sort === 'latest') {
    sorted.sort((a, b) => byTime(b) - byTime(a));
  } else if (sort === 'sources') {
    sorted.sort((a, b) => b.evidence.length - a.evidence.length || b.probability - a.probability);
  } else {
    sorted.sort((a, b) => b.probability - a.probability || b.evidence.length - a.evidence.length);
  }
  return sorted;
}

function render() {
  const list = visibleRumours();
  if (!list.length) {
    board.innerHTML = '<p class="placeholder">Nothing matches that filter.</p>';
    return;
  }
  board.innerHTML = list.map(card).join('');
}

function renderHeader() {
  const { counts, generatedAt, model, sources } = state.data;
  subtitle.textContent = `Updated ${relativeTime(generatedAt)} · ${model.type}`;

  const cells = [
    ['Live', counts.rumours],
    ['Arrivals', counts.incoming],
    ['Exits', counts.outgoing],
    ['Done', counts.done ?? 0],
    ['At 65%+', counts.likely],
    ['Headlines', counts.articles],
  ];
  statsEl.innerHTML = cells
    .map(([label, value]) => `<div><dd>${value}</dd><dt>${label}</dt></div>`)
    .join('');

  const ok = sources.filter((source) => source.ok);
  const failed = sources.filter((source) => !source.ok);
  const failedNote = failed.length
    ? ` Unavailable this run: ${failed.map((source) => source.name).join(', ')}.`
    : '';
  sourcesNote.textContent =
    `Built from ${ok.length} of ${sources.length} public feeds.${failedNote} ` +
    `Generated ${new Date(generatedAt).toLocaleString('en-GB')}.`;
}

async function load() {
  try {
    // Cache-bust so a phone that has the page open gets fresh data on refresh.
    const res = await fetch(`data/rumours.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
    renderHeader();
    render();
  } catch (error) {
    board.innerHTML = `<p class="placeholder">Could not load the data (${escapeHtml(error.message)}).<br />
      If this is a fresh deployment, the first scheduled build may not have run yet.</p>`;
    subtitle.textContent = 'Data unavailable';
  }
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((other) => {
      other.classList.toggle('is-active', other === tab);
      other.setAttribute('aria-selected', String(other === tab));
    });
    state.filter = tab.dataset.filter;
    render();
  });
});

let searchTimer;
searchInput.addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = event.target.value.trim();
    render();
  }, 120);
});

sortSelect.addEventListener('change', (event) => {
  state.sort = event.target.value;
  render();
});

document.getElementById('refresh').addEventListener('click', load);

load();
