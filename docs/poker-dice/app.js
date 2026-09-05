// Poker dice scorecard. No build step, no framework, no network — the whole
// game lives in localStorage so a half-finished card survives a phone lock.

// Bumped from v1, which stored points multiplied by the column. Those cards
// would read wrong under the current scoring, so they are left behind.
const STORAGE_KEY = 'pokerDice.v2';

// Rolling a combination in one throw — serving it — is worth five on top.
const SERVE_BONUS = 5;

// Rows of the card. `perDie` rows score (matching dice x value); the rest are
// fixed-value combinations, all of which can be served. `shit` is a scoring
// row here, not a zero.
const ROWS = [
  { key: 'nines', label: '9s', perDie: 1 },
  { key: 'tens', label: '10s', perDie: 2 },
  { key: 'jacks', label: 'Jacks', perDie: 3 },
  { key: 'queens', label: 'Queens', perDie: 4 },
  { key: 'kings', label: 'Kings', perDie: 5 },
  { key: 'aces', label: 'Aces', perDie: 6 },
  { key: 'straight', label: 'Straight', fixed: 20 },
  { key: 'full', label: 'Full house', fixed: 30 },
  { key: 'poker', label: 'Poker', fixed: 40 },
  { key: 'grande', label: 'Grande', fixed: 50 },
  { key: 'shit', label: 'Shit', fixed: 10 },
];

// Three passes over the same rows. Every column scores at face value — the
// ×1/×2/×4 headers are kept as labels only, and multiply nothing.
const COLUMNS = [
  { key: 'x1', label: '×1' },
  { key: 'x2', label: '×2' },
  { key: 'x4', label: '×4' },
];

const CELLS_PER_CARD = ROWS.length * COLUMNS.length;
const MAX_PLAYERS = 8;

const state = {
  players: [], // [{ id, name, scores: { 'row:col': points } }]
  history: [], // [{ playerId, cellKey, previous }] — newest last, for undo
  setupNames: ['', ''],
  open: null, // { playerId, rowKey, colKey } while the sheet is up
};

const el = {
  setup: document.getElementById('setup'),
  game: document.getElementById('game'),
  playerInputs: document.getElementById('player-inputs'),
  addPlayer: document.getElementById('add-player'),
  startGame: document.getElementById('start-game'),
  cards: document.getElementById('cards'),
  leaderboard: document.getElementById('leaderboard'),
  progress: document.getElementById('progress'),
  subtitle: document.getElementById('subtitle'),
  undo: document.getElementById('undo'),
  newGame: document.getElementById('new-game'),
  sheet: document.getElementById('sheet'),
  sheetTitle: document.getElementById('sheet-title'),
  sheetSub: document.getElementById('sheet-sub'),
  sheetOptions: document.getElementById('sheet-options'),
  sheetClear: document.getElementById('sheet-clear'),
};

const cellKey = (rowKey, colKey) => `${rowKey}:${colKey}`;
const rowByKey = (key) => ROWS.find((row) => row.key === key);
const colByKey = (key) => COLUMNS.find((col) => col.key === key);
const playerById = (id) => state.players.find((player) => player.id === id);

function filledCount(player) {
  return Object.keys(player.scores).length;
}

function columnTotal(player, colKey) {
  return ROWS.reduce((sum, row) => sum + (player.scores[cellKey(row.key, colKey)] || 0), 0);
}

function total(player) {
  return COLUMNS.reduce((sum, col) => sum + columnTotal(player, col.key), 0);
}

const cardComplete = (player) => filledCount(player) === CELLS_PER_CARD;
const gameComplete = () => state.players.length > 0 && state.players.every(cardComplete);

/* ---------- storage ---------- */

function save() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ players: state.players, history: state.history }),
    );
  } catch {
    // Private browsing or a full quota: the game still works for this session.
  }
}

function load() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    return false;
  }
  if (!saved || !Array.isArray(saved.players) || saved.players.length === 0) return false;
  state.players = saved.players.map((player) => ({
    id: player.id,
    name: player.name,
    scores: player.scores && typeof player.scores === 'object' ? player.scores : {},
  }));
  state.history = Array.isArray(saved.history) ? saved.history : [];
  return true;
}

/* ---------- setup ---------- */

function renderSetup() {
  el.playerInputs.innerHTML = '';
  state.setupNames.forEach((name, index) => {
    const item = document.createElement('li');

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'player-input';
    input.value = name;
    input.placeholder = `Player ${index + 1}`;
    input.maxLength = 20;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', `Player ${index + 1} name`);
    input.addEventListener('input', () => {
      state.setupNames[index] = input.value;
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') startGame();
    });
    item.append(input);

    if (state.setupNames.length > 1) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-button';
      remove.innerHTML = '&times;';
      remove.setAttribute('aria-label', `Remove player ${index + 1}`);
      remove.addEventListener('click', () => {
        state.setupNames.splice(index, 1);
        renderSetup();
      });
      item.append(remove);
    }

    el.playerInputs.append(item);
  });

  el.addPlayer.disabled = state.setupNames.length >= MAX_PLAYERS;
}

function startGame() {
  const names = state.setupNames.map((name, index) => name.trim() || `Player ${index + 1}`);
  state.players = names.map((name, index) => ({
    id: `p${index}-${Date.now().toString(36)}`,
    name,
    scores: {},
  }));
  state.history = [];
  save();
  showGame();
}

function showSetup() {
  el.setup.hidden = false;
  el.game.hidden = true;
  el.subtitle.textContent = 'Add the players, then start.';
  renderSetup();
}

function showGame() {
  el.setup.hidden = true;
  el.game.hidden = false;
  render();
}

/* ---------- scorecards ---------- */

function render() {
  renderLeaderboard();
  renderCards();

  const filled = state.players.reduce((sum, player) => sum + filledCount(player), 0);
  const cells = state.players.length * CELLS_PER_CARD;
  el.progress.textContent = gameComplete()
    ? 'All cards full — game over.'
    : `${filled} of ${cells} cells filled.`;

  if (gameComplete()) {
    const best = Math.max(...state.players.map(total));
    const winners = state.players.filter((player) => total(player) === best);
    el.subtitle.textContent =
      winners.length === 1
        ? `${winners[0].name} wins with ${best}.`
        : `Tied on ${best}: ${winners.map((player) => player.name).join(', ')}.`;
  } else {
    el.subtitle.textContent = 'Tap a cell to score it.';
  }

  el.undo.disabled = state.history.length === 0;
}

function renderLeaderboard() {
  const ranked = [...state.players].sort((a, b) => total(b) - total(a));
  el.leaderboard.innerHTML = '';
  ranked.forEach((player) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.innerHTML = `<span class="chip-name"></span><span class="chip-total">${total(player)}</span>`;
    chip.querySelector('.chip-name').textContent = player.name;
    // Chips double as navigation on phones, where cards scroll horizontally.
    chip.addEventListener('click', () => {
      document
        .getElementById(`card-${player.id}`)
        ?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
    });
    el.leaderboard.append(chip);
  });
}

function renderCards() {
  el.cards.innerHTML = '';
  state.players.forEach((player) => {
    el.cards.append(buildCard(player));
  });
}

function buildCard(player) {
  const card = document.createElement('section');
  card.className = 'card';
  card.id = `card-${player.id}`;

  const head = document.createElement('header');
  head.className = 'card-head';
  const name = document.createElement('h2');
  name.textContent = player.name;
  const score = document.createElement('span');
  score.className = 'card-total';
  score.textContent = total(player);
  head.append(name, score);
  card.append(head);

  const table = document.createElement('table');
  table.className = 'score-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.innerHTML = '<th scope="col"></th>';
  COLUMNS.forEach((col) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = col.label;
    headRow.append(th);
  });
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement('tbody');
  ROWS.forEach((row) => {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    // Kept to one line so the combination rows stay as tall as the number rows.
    th.innerHTML = `${row.label}<small>${row.perDie ? `${row.perDie}/die` : `${row.fixed} (+${SERVE_BONUS})`}</small>`;
    tr.append(th);

    COLUMNS.forEach((col) => {
      const td = document.createElement('td');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cell';
      const value = player.scores[cellKey(row.key, col.key)];
      if (value === undefined) {
        button.textContent = '–';
        button.classList.add('empty');
      } else {
        button.textContent = value;
        if (value === 0) button.classList.add('zero');
      }
      button.setAttribute(
        'aria-label',
        `${player.name}, ${row.label}, ${col.label}: ${value === undefined ? 'empty' : value}`,
      );
      button.addEventListener('click', () => openSheet(player.id, row.key, col.key));
      td.append(button);
      tr.append(td);
    });

    tbody.append(tr);
  });
  table.append(tbody);

  const tfoot = document.createElement('tfoot');
  const footRow = document.createElement('tr');
  footRow.innerHTML = '<th scope="row">Total</th>';
  COLUMNS.forEach((col) => {
    const td = document.createElement('td');
    td.textContent = columnTotal(player, col.key);
    footRow.append(td);
  });
  tfoot.append(footRow);
  table.append(tfoot);

  card.append(table);
  return card;
}

/* ---------- entry sheet ---------- */

function openSheet(playerId, rowKey, colKey) {
  const player = playerById(playerId);
  const row = rowByKey(rowKey);
  const col = colByKey(colKey);
  if (!player || !row || !col) return;

  state.open = { playerId, rowKey, colKey };
  const current = player.scores[cellKey(rowKey, colKey)];

  el.sheetTitle.textContent = `${row.label} ${col.label}`;
  el.sheetSub.textContent = row.perDie
    ? `${player.name} — how many ${row.label}? (${row.perDie} point${row.perDie === 1 ? '' : 's'} per die)`
    : `${player.name} — ${row.fixed} points, ${row.fixed + SERVE_BONUS} if served`;

  el.sheetOptions.innerHTML = '';
  const options = row.perDie
    ? [0, 1, 2, 3, 4, 5].map((count) => ({
        label: String(count),
        note: `${count * row.perDie}`,
        points: count * row.perDie,
      }))
    : [
        { label: 'Rolled it', note: `${row.fixed}`, points: row.fixed },
        { label: 'Served', note: `${row.fixed + SERVE_BONUS}`, points: row.fixed + SERVE_BONUS },
        { label: 'Cross out', note: '0', points: 0 },
      ];

  options.forEach((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'option';
    if (current === option.points) button.classList.add('selected');
    button.innerHTML = `<span class="option-label"></span><span class="option-note"></span>`;
    button.querySelector('.option-label').textContent = option.label;
    button.querySelector('.option-note').textContent = `${option.note} pts`;
    button.addEventListener('click', () => writeCell(option.points));
    el.sheetOptions.append(button);
  });

  el.sheetClear.hidden = current === undefined;
  el.sheet.hidden = false;
  document.body.classList.add('sheet-open');
  el.sheetOptions.querySelector('button')?.focus();
}

function closeSheet() {
  el.sheet.hidden = true;
  document.body.classList.remove('sheet-open');
  state.open = null;
}

function writeCell(points) {
  if (!state.open) return;
  const { playerId, rowKey, colKey } = state.open;
  const player = playerById(playerId);
  if (!player) return;

  const key = cellKey(rowKey, colKey);
  state.history.push({ playerId, cellKey: key, previous: player.scores[key] });
  player.scores[key] = points;
  save();
  closeSheet();
  render();
}

function clearCell() {
  if (!state.open) return;
  const { playerId, rowKey, colKey } = state.open;
  const player = playerById(playerId);
  if (!player) return;

  const key = cellKey(rowKey, colKey);
  if (!(key in player.scores)) return;
  state.history.push({ playerId, cellKey: key, previous: player.scores[key] });
  delete player.scores[key];
  save();
  closeSheet();
  render();
}

function undo() {
  const last = state.history.pop();
  if (!last) return;
  const player = playerById(last.playerId);
  if (player) {
    if (last.previous === undefined) delete player.scores[last.cellKey];
    else player.scores[last.cellKey] = last.previous;
  }
  save();
  render();
}

/* ---------- wiring ---------- */

el.addPlayer.addEventListener('click', () => {
  if (state.setupNames.length >= MAX_PLAYERS) return;
  state.setupNames.push('');
  renderSetup();
  el.playerInputs.querySelector('li:last-child input')?.focus();
});

el.startGame.addEventListener('click', startGame);
el.undo.addEventListener('click', undo);
el.sheetClear.addEventListener('click', clearCell);

el.newGame.addEventListener('click', () => {
  const started = state.players.some((player) => filledCount(player) > 0);
  if (started && !confirm('Start a new game? The current scores are lost.')) return;
  state.setupNames = state.players.length
    ? state.players.map((player) => player.name)
    : ['', ''];
  state.players = [];
  state.history = [];
  save();
  showSetup();
});

el.sheet.addEventListener('click', (event) => {
  if (event.target.closest('[data-close]')) closeSheet();
});

document.addEventListener('keydown', (event) => {
  if (el.sheet.hidden) return;
  if (event.key === 'Escape') {
    closeSheet();
    return;
  }
  // Number rows take a digit straight from the keyboard.
  const row = rowByKey(state.open?.rowKey);
  if (row?.perDie && /^[0-5]$/.test(event.key)) {
    writeCell(Number(event.key) * row.perDie);
  }
});

if (load()) showGame();
else showSetup();
