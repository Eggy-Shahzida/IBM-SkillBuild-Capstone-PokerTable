/**
 * PokerTable — Virtual Chip Manager
 * Texas Hold'em virtual chip tracker for in-person games.
 * All chip arithmetic uses integer values only.
 */

'use strict';

// ================================================================
// CONSTANTS
// ================================================================
const STORAGE_KEY   = 'pokertable_session_v3';
const MAX_PLAYERS   = 9;
const MIN_PLAYERS   = 2;
const DEFAULT_DENOMS = [5, 10, 25, 100, 500];

const STREETS = ['preflop', 'flop', 'turn', 'river', 'showdown'];
const STREET_LABELS = {
  preflop: 'Pre-flop', flop: 'Flop', turn: 'Turn', river: 'River', showdown: 'Showdown'
};

// Seat positions for 2–9 players (desktop layout, --W=840, --SH=525)
// Each entry: { x, y } in design units
const SEAT_POSITIONS = {
  2: [
    { x: 321, y: 0   },   // top
    { x: 328, y: 424 },   // bottom
  ],
  3: [
    { x: 321, y: 0   },
    { x: 0,   y: 82  },
    { x: 656, y: 82  },
  ],
  4: [
    { x: 321, y: 0   },
    { x: 0,   y: 82  },
    { x: 656, y: 344 },
    { x: 328, y: 424 },
  ],
  5: [
    { x: 321, y: 0   },
    { x: 0,   y: 82  },
    { x: 656, y: 82  },
    { x: 0,   y: 344 },
    { x: 656, y: 344 },
  ],
  6: [
    { x: 321, y: 0   },
    { x: 0,   y: 82  },
    { x: 656, y: 82  },
    { x: 0,   y: 344 },
    { x: 656, y: 344 },
    { x: 328, y: 424 },
  ],
  7: [
    { x: 321, y: 0   },
    { x: 0,   y: 0   },
    { x: 656, y: 0   },
    { x: 0,   y: 82  },
    { x: 656, y: 82  },
    { x: 0,   y: 344 },
    { x: 656, y: 344 },
  ],
  8: [
    { x: 321, y: 0   },
    { x: 0,   y: 0   },
    { x: 656, y: 0   },
    { x: 0,   y: 82  },
    { x: 656, y: 82  },
    { x: 0,   y: 344 },
    { x: 656, y: 344 },
    { x: 328, y: 424 },
  ],
  9: [
    { x: 321, y: 0   },
    { x: 110, y: 0   },
    { x: 532, y: 0   },
    { x: 0,   y: 82  },
    { x: 656, y: 82  },
    { x: 0,   y: 213 },
    { x: 656, y: 213 },
    { x: 0,   y: 344 },
    { x: 656, y: 344 },
  ],
};

/**
 * The position the "Add Player" button occupies for each active-player count.
 * This must never coincide with any entry in SEAT_POSITIONS[n] for the same n.
 * When n === MAX_PLAYERS (9) the button is hidden, so no entry is needed.
 */
const ADD_BTN_POSITIONS = {
  0: { x: 321, y: 0   },   // no players: centre top
  1: { x: 328, y: 424 },   // 1 player: bottom
  2: { x: 656, y: 82  },   // 2 players (top + bottom): right-top
  3: { x: 656, y: 344 },   // 3 players (top + left-top + right-top): right-bottom
  4: { x: 0,   y: 344 },   // 4 players: left-bottom
  5: { x: 328, y: 424 },   // 5 players: bottom
  6: { x: 0,   y: 0   },   // 6 players: left-top-corner
  7: { x: 328, y: 424 },   // 7 players: bottom
  8: { x: 110, y: 0   },   // 8 players: add in top row gap
};

// ================================================================
// STATE MODEL
// ================================================================
/**
 * session: {
 *   id: string,
 *   name: string,
 *   mode: 'interactive' | 'manual',
 *   smallBlind: int,
 *   bigBlind: int,
 *   denoms: int[],
 *   handNumber: int,
 *   players: Player[],
 *   hand: Hand | null,
 *   history: HistoryEntry[],
 *   createdAt: ISO string,
 *   active: boolean,
 * }
 *
 * Player: {
 *   id: string,
 *   name: string,
 *   stack: int,       // current chip balance
 *   totalBuyIn: int,  // chips they started with this session
 *   active: boolean,  // in the session (false = removed)
 *   seatIndex: int,   // logical clockwise seat number
 *   waitingToJoin: boolean, // added mid-hand, joins next hand
 *   pendingRemove: boolean, // wants to leave but hand is active
 * }
 *
 * Hand: {
 *   street: 'preflop'|'flop'|'turn'|'river'|'showdown',
 *   dealerSeatIndex: int,
 *   sbSeatIndex: int,
 *   bbSeatIndex: int,
 *   currentActorIndex: int,   // index into activeSeatOrder
 *   activeSeatOrder: int[],   // seatIndex array, clockwise order for this hand
 *   playerHand: {[playerId]: PlayerHandState},
 *   pot: int,
 *   currentBet: int,          // highest bet this street
 *   lastRaiserSeatIndex: int, // who last raised (for re-open detection)
 *   bbHasOption: boolean,     // pre-flop big-blind option check
 *   roundComplete: boolean,
 *   handComplete: boolean,
 *   communityReveal: int,     // 0=none, 3=flop, 4=turn, 5=river
 *   pot_distributed: boolean,
 * }
 *
 * PlayerHandState: {
 *   folded: boolean,
 *   allIn: boolean,
 *   roundBet: int,     // bet this street
 *   totalHandBet: int, // total contributed this hand
 *   acted: boolean,    // acted this street (for round-complete check)
 * }
 */

let session = null;
let undoStack = [];  // array of serialized session snapshots

// ================================================================
// UTILITY
// ================================================================
function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function sumBy(arr, fn) {
  return arr.reduce((s, x) => s + fn(x), 0);
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** Return session players who are active (not removed, not waitingToJoin) */
function activePlayers() {
  return session.players.filter(p => p.active && !p.waitingToJoin);
}

/** Return players who are active and have chips */
function eligiblePlayers() {
  return activePlayers().filter(p => p.stack > 0 || (session.hand && getHandState(p.id)?.allIn));
}

function getPlayer(id) {
  return session.players.find(p => p.id === id);
}

function getHandState(playerId) {
  return session.hand?.playerHand[playerId];
}

/** Get players participating in the current hand (in activeSeatOrder) */
function handPlayers() {
  if (!session.hand) return [];
  return session.hand.activeSeatOrder
    .map(si => session.players.find(p => p.seatIndex === si))
    .filter(Boolean);
}

function getHandPlayer(seatIndex) {
  return session.players.find(p => p.seatIndex === seatIndex && p.active && !p.waitingToJoin);
}

/** Mod arithmetic for circular seat wrap */
function nextSeatClockwise(currentSeatIndex, allSeats) {
  const sorted = [...allSeats].sort((a, b) => a - b);
  const idx = sorted.indexOf(currentSeatIndex);
  return sorted[(idx + 1) % sorted.length];
}

function seatAfter(seatIndex, seatArray) {
  // seatArray is the ordered clockwise list
  const idx = seatArray.indexOf(seatIndex);
  if (idx === -1) return seatArray[0];
  return seatArray[(idx + 1) % seatArray.length];
}

/** Total pot = pot + all current-round bets */
function totalPot() {
  if (!session.hand) return 0;
  const roundBets = handPlayers().reduce((s, p) => {
    const hs = getHandState(p.id);
    return s + (hs ? hs.roundBet : 0);
  }, 0);
  return session.hand.pot + roundBets;
}

/** Move current round bets into pot (end of street) */
function collectBetsToPot() {
  const hand = session.hand;
  handPlayers().forEach(p => {
    const hs = getHandState(p.id);
    if (hs) {
      hs.totalHandBet += hs.roundBet;
      hand.pot += hs.roundBet;
      hs.roundBet = 0;
    }
  });
  hand.currentBet = 0;
  hand.lastRaiserSeatIndex = -1;
}

// ================================================================
// HISTORY
// ================================================================
function addHistory(text, type = 'action') {
  // type: 'hand' | 'action' | 'system' | 'win' | 'fold'
  session.history.unshift({ text, type, ts: Date.now() });
  if (session.history.length > 200) session.history.length = 200;
  renderHistory();
}

// ================================================================
// TOAST NOTIFICATIONS
// ================================================================
function showToast(msg, type = '') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ` toast--${type}` : '');
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ================================================================
// CONFIRM MODAL
// ================================================================
let confirmCallback = null;

function showConfirm(title, body, okLabel = 'Confirm', okClass = 'btn--danger') {
  return new Promise(resolve => {
    document.getElementById('modal-confirm-title').textContent = title;
    document.getElementById('modal-confirm-body').textContent = body;
    const okBtn = document.getElementById('modal-confirm-ok');
    okBtn.textContent = okLabel;
    okBtn.className = `btn ${okClass}`;
    document.getElementById('modal-confirm').classList.remove('hidden');
    confirmCallback = resolve;
  });
}

document.getElementById('modal-confirm-ok').addEventListener('click', () => {
  document.getElementById('modal-confirm').classList.add('hidden');
  if (confirmCallback) { confirmCallback(true); confirmCallback = null; }
});
document.getElementById('modal-confirm-cancel').addEventListener('click', () => {
  document.getElementById('modal-confirm').classList.add('hidden');
  if (confirmCallback) { confirmCallback(false); confirmCallback = null; }
});

// ================================================================
// UNDO
// ================================================================
function pushUndo() {
  undoStack.push(JSON.stringify(session));
  if (undoStack.length > 30) undoStack.shift();
}

function popUndo() {
  if (undoStack.length === 0) {
    showToast('Nothing to undo.', 'warn');
    return;
  }
  session = JSON.parse(undoStack.pop());
  saveSession();
  renderAll();
  addHistory('Undo performed.', 'system');
  showToast('Undo successful.', 'success');
}

// ================================================================
// PERSISTENCE
// ================================================================
function saveSession() {
  if (!session) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch(e) {
    // Storage full or unavailable — silent fail
  }
}

function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.id || !s.players) return null;
    return s;
  } catch(e) {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}

// ================================================================
// SETUP PAGE
// ================================================================

// -- Denomination management --
let setupDenoms = [...DEFAULT_DENOMS];

function renderDenomTags() {
  const wrap = document.getElementById('denom-tags');
  wrap.innerHTML = '';
  [...setupDenoms].sort((a, b) => a - b).forEach(d => {
    const tag = document.createElement('div');
    tag.className = 'denom-tag';
    tag.setAttribute('role', 'listitem');
    tag.innerHTML = `<span>${d}</span>
      <button class="denom-tag__remove" type="button" aria-label="Remove denomination ${d}" data-denom="${d}">×</button>`;
    wrap.appendChild(tag);
  });
}

document.getElementById('denom-add-btn').addEventListener('click', () => {
  const input = document.getElementById('denom-input');
  const errEl = document.getElementById('denom-error');
  const val = parseInt(input.value, 10);
  errEl.textContent = '';
  if (!Number.isInteger(val) || val < 2) {
    errEl.textContent = 'Enter a positive integer ≥ 2.';
    return;
  }
  if (setupDenoms.includes(val)) {
    errEl.textContent = 'Denomination already exists.';
    return;
  }
  setupDenoms.push(val);
  input.value = '';
  renderDenomTags();
});

document.getElementById('denom-tags').addEventListener('click', e => {
  const btn = e.target.closest('.denom-tag__remove');
  if (!btn) return;
  const val = parseInt(btn.dataset.denom, 10);
  setupDenoms = setupDenoms.filter(d => d !== val);
  renderDenomTags();
});

document.getElementById('denom-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('denom-add-btn').click();
});

// -- Player management (setup) --
let setupPlayers = [];

function renderSetupPlayers() {
  const list = document.getElementById('player-list');
  list.innerHTML = '';
  setupPlayers.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'player-row';
    row.setAttribute('role', 'listitem');
    row.innerHTML = `
      <input class="form-input" type="text" placeholder="Name" maxlength="20" autocomplete="off"
             value="${escHtml(p.name)}" data-idx="${idx}" data-field="name">
      <input class="form-input" type="number" inputmode="numeric" min="1" placeholder="Chips"
             value="${p.chips}" data-idx="${idx}" data-field="chips">
      <button class="player-row__remove" type="button" aria-label="Remove player ${escHtml(p.name)}">×</button>
    `;
    row.querySelector('.player-row__remove').addEventListener('click', () => {
      setupPlayers.splice(idx, 1);
      renderSetupPlayers();
    });
    row.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('change', () => {
        const i = parseInt(inp.dataset.idx, 10);
        if (inp.dataset.field === 'name') {
          setupPlayers[i].name = inp.value.trim();
        } else {
          setupPlayers[i].chips = parseInt(inp.value, 10) || 0;
        }
      });
    });
    list.appendChild(row);
  });
  document.getElementById('player-count-label').textContent = `${setupPlayers.length} / ${MAX_PLAYERS} players`;
}

document.getElementById('add-player-btn').addEventListener('click', addSetupPlayer);
document.getElementById('new-player-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') addSetupPlayer();
});

function addSetupPlayer() {
  const nameEl  = document.getElementById('new-player-name');
  const chipsEl = document.getElementById('new-player-chips');
  const errEl   = document.getElementById('player-error');
  errEl.textContent = '';
  const name  = nameEl.value.trim();
  const chips = parseInt(chipsEl.value, 10);
  if (!name) { errEl.textContent = 'Enter a player name.'; return; }
  if (setupPlayers.some(p => p.name.toLowerCase() === name.toLowerCase())) {
    errEl.textContent = 'Player name already exists.'; return;
  }
  if (!Number.isInteger(chips) || chips < 1) {
    errEl.textContent = 'Enter a valid starting chip amount.'; return;
  }
  if (setupPlayers.length >= MAX_PLAYERS) {
    errEl.textContent = `Maximum ${MAX_PLAYERS} players.`; return;
  }
  setupPlayers.push({ name, chips });
  nameEl.value = '';
  renderSetupPlayers();
}

// -- Start Game --
document.getElementById('start-game-btn').addEventListener('click', startGame);

function validateSetup() {
  const errEl = document.getElementById('start-error');
  errEl.textContent = '';
  const sessionName = document.getElementById('session-name').value.trim() || 'Poker Night';
  const sb = parseInt(document.getElementById('small-blind').value, 10);
  const bb = parseInt(document.getElementById('big-blind').value, 10);
  const blindErr = document.getElementById('blinds-error');
  blindErr.textContent = '';

  if (!Number.isInteger(sb) || sb < 1) {
    blindErr.textContent = 'Small Blind must be a positive integer.'; return null;
  }
  if (!Number.isInteger(bb) || bb < 1) {
    blindErr.textContent = 'Big Blind must be a positive integer.'; return null;
  }
  if (bb < sb) {
    blindErr.textContent = 'Big Blind must be ≥ Small Blind.'; return null;
  }

  // Read final player data from inputs
  const nameInputs  = document.querySelectorAll('#player-list [data-field="name"]');
  const chipsInputs = document.querySelectorAll('#player-list [data-field="chips"]');
  const names = [];
  for (let i = 0; i < nameInputs.length; i++) {
    const name  = nameInputs[i].value.trim();
    const chips = parseInt(chipsInputs[i].value, 10);
    if (!name) { errEl.textContent = `Player ${i+1} has an empty name.`; return null; }
    if (names.includes(name.toLowerCase())) {
      errEl.textContent = `Duplicate player name: "${name}".`; return null;
    }
    if (!Number.isInteger(chips) || chips < 1) {
      errEl.textContent = `Player "${name}" has an invalid chip amount.`; return null;
    }
    names.push(name.toLowerCase());
    setupPlayers[i] = { name, chips };
  }

  if (setupPlayers.length < MIN_PLAYERS) {
    errEl.textContent = `Add at least ${MIN_PLAYERS} players to start.`; return null;
  }

  return { sessionName, sb, bb };
}

function startGame() {
  const v = validateSetup();
  if (!v) return;
  const { sessionName, sb, bb } = v;
  const mode = document.getElementById('game-mode').value;

  // Build players with clockwise seatIndex order
  const players = setupPlayers.map((p, i) => ({
    id: uid(),
    name: p.name,
    stack: p.chips,
    totalBuyIn: p.chips,
    active: true,
    seatIndex: i,
    waitingToJoin: false,
    pendingRemove: false,
  }));

  session = {
    id: uid(),
    name: sessionName,
    mode,
    smallBlind: sb,
    bigBlind: bb,
    denoms: [...setupDenoms].sort((a, b) => a - b),
    handNumber: 0,
    players,
    hand: null,
    history: [],
    createdAt: new Date().toISOString(),
    active: true,
  };

  undoStack = [];
  addHistory(`Session "${sessionName}" created. Mode: ${mode === 'interactive' ? 'Interactive' : 'Manual'}. ${players.length} players.`, 'system');

  saveSession();
  openGamePage();
  startNewHand();
}

// ================================================================
// GAME PAGE NAVIGATION
// ================================================================
function openGamePage() {
  document.body.classList.add('game-active');
}

function openSetupPage() {
  document.body.classList.remove('game-active');
}

// ================================================================
// HAND MANAGEMENT
// ================================================================

function startNewHand() {
  if (!session) return;

  const ap = activePlayers();
  if (ap.length < MIN_PLAYERS) {
    showToast(`Need at least ${MIN_PLAYERS} active players to start a hand.`, 'warn');
    renderAll();
    return;
  }

  pushUndo();

  session.handNumber++;
  const allSeats = ap.map(p => p.seatIndex).sort((a, b) => a - b);

  // Determine dealer position
  let dealerSeat;
  if (session.hand === null || session.hand === undefined) {
    // First hand: dealer is the first seat
    dealerSeat = allSeats[0];
  } else {
    const prevDealer = session.hand.dealerSeatIndex;
    dealerSeat = nextSeatClockwise(prevDealer, allSeats);
  }

  // Build clockwise activeSeatOrder starting from dealer
  const dealerIdx = allSeats.indexOf(dealerSeat);
  const orderedSeats = [
    ...allSeats.slice(dealerIdx),
    ...allSeats.slice(0, dealerIdx),
  ];

  const isHeadsUp = orderedSeats.length === 2;

  // Blind positions
  let sbSeat, bbSeat;
  if (isHeadsUp) {
    sbSeat = orderedSeats[0]; // dealer = SB in heads-up
    bbSeat = orderedSeats[1];
  } else {
    sbSeat = orderedSeats[1];
    bbSeat = orderedSeats[2];
  }

  // Build playerHand state
  const playerHand = {};
  ap.forEach(p => {
    playerHand[p.id] = {
      folded: false,
      allIn: false,
      roundBet: 0,
      totalHandBet: 0,
      acted: false,
    };
  });

  // Post blinds (deduct from stacks)
  const sbPlayer = ap.find(p => p.seatIndex === sbSeat);
  const bbPlayer = ap.find(p => p.seatIndex === bbSeat);

  const sbAmount = Math.min(session.smallBlind, sbPlayer.stack);
  const bbAmount = Math.min(session.bigBlind, bbPlayer.stack);

  sbPlayer.stack -= sbAmount;
  playerHand[sbPlayer.id].roundBet  = sbAmount;
  playerHand[sbPlayer.id].totalHandBet = sbAmount;
  if (sbPlayer.stack === 0) playerHand[sbPlayer.id].allIn = true;

  bbPlayer.stack -= bbAmount;
  playerHand[bbPlayer.id].roundBet  = bbAmount;
  playerHand[bbPlayer.id].totalHandBet = bbAmount;
  if (bbPlayer.stack === 0) playerHand[bbPlayer.id].allIn = true;

  // First to act pre-flop
  let firstActor;
  if (isHeadsUp) {
    firstActor = orderedSeats[0]; // SB/dealer acts first pre-flop heads-up
  } else {
    // UTG = first after BB
    const bbIdx = orderedSeats.indexOf(bbSeat);
    firstActor = orderedSeats[(bbIdx + 1) % orderedSeats.length];
  }

  // Skip all-in players for first actor
  const startIdx = orderedSeats.indexOf(firstActor);
  let actorIdx = startIdx;
  for (let i = 0; i < orderedSeats.length; i++) {
    const idx = (startIdx + i) % orderedSeats.length;
    const p = getHandPlayer(orderedSeats[idx]);
    if (p && !playerHand[p.id].allIn && !playerHand[p.id].folded) {
      actorIdx = idx;
      break;
    }
  }

  session.hand = {
    street: 'preflop',
    dealerSeatIndex: dealerSeat,
    sbSeatIndex: sbSeat,
    bbSeatIndex: bbSeat,
    currentActorIndex: actorIdx,
    activeSeatOrder: orderedSeats,
    playerHand,
    pot: 0,
    currentBet: bbAmount,
    lastRaiserSeatIndex: bbSeat,
    bbHasOption: true,  // BB can raise pre-flop even if all called
    roundComplete: false,
    handComplete: false,
    communityReveal: 0,
    pot_distributed: false,
  };

  // Promote waiting players for next hand
  session.players.forEach(p => {
    if (p.waitingToJoin) p.waitingToJoin = false;
  });
  // Finalize pending removals
  session.players.forEach(p => {
    if (p.pendingRemove) { p.active = false; p.pendingRemove = false; }
  });

  const dealerPlayer = getHandPlayer(dealerSeat);
  addHistory(`── Hand #${session.handNumber} started ──`, 'hand');
  addHistory(`Dealer: ${dealerPlayer?.name ?? '?'} | SB: ${sbPlayer?.name} (${sbAmount}) | BB: ${bbPlayer?.name} (${bbAmount})`, 'system');

  saveSession();
  renderAll();
  updateControlsForCurrentActor();
}

// ================================================================
// GAME ACTIONS
// ================================================================

function currentActor() {
  const hand = session.hand;
  if (!hand) return null;
  const seat = hand.activeSeatOrder[hand.currentActorIndex];
  return getHandPlayer(seat);
}

function performAction(action, amount) {
  if (!session.hand) return;
  const hand = session.hand;
  const actor = currentActor();
  if (!actor && session.mode === 'interactive') return;

  // In manual mode, actor is set by the selector
  const actingPlayer = session.mode === 'manual'
    ? getPlayer(document.getElementById('manual-player-select').value)
    : actor;

  if (!actingPlayer) return;
  const hs = getHandState(actingPlayer.id);
  if (!hs || hs.folded || hs.allIn) return;

  pushUndo();

  const call_amount   = Math.max(0, hand.currentBet - hs.roundBet);
  const can_check     = call_amount === 0;

  switch (action) {
    case 'fold':
      hs.folded = true;
      hs.acted = true;
      addHistory(`${actingPlayer.name} folds.`, 'fold');
      break;

    case 'check':
      if (!can_check) { showToast('Cannot check — there is a bet to call.', 'error'); undoStack.pop(); return; }
      hs.acted = true;
      // Clear BB option once BB acts
      if (actingPlayer.seatIndex === hand.bbSeatIndex) hand.bbHasOption = false;
      addHistory(`${actingPlayer.name} checks.`, 'action');
      break;

    case 'call': {
      const toCall = Math.min(call_amount, actingPlayer.stack);
      actingPlayer.stack -= toCall;
      hs.roundBet += toCall;
      hs.totalHandBet += toCall;
      hs.acted = true;
      // Clear BB option once BB acts (calls)
      if (actingPlayer.seatIndex === hand.bbSeatIndex) hand.bbHasOption = false;
      if (actingPlayer.stack === 0) {
        hs.allIn = true;
        addHistory(`${actingPlayer.name} calls ${toCall} (all-in).`, 'action');
      } else {
        addHistory(`${actingPlayer.name} calls ${toCall}.`, 'action');
      }
      break;
    }

    case 'bet':
    case 'raise': {
      // amount = total target bet this street (not the additional).
      // Enforce multiples-of-5: snap to nearest valid multiple, clamped to legal range.
      const maxBetTarget = hand.currentBet + actingPlayer.stack + hs.roundBet;
      const rawTarget    = clamp(Math.floor(amount), hand.currentBet + 1, maxBetTarget);
      // Snap DOWN to nearest multiple-of-5 (the UI should already send a snapped value,
      // but this guards against any path that bypasses the UI).
      const snappedTarget = snapDown5(rawTarget);
      // If snapping made it illegal (below minimum), reject.
      const targetBet = snappedTarget >= (hand.currentBet + 1) ? snappedTarget : rawTarget;
      const additional = targetBet - hs.roundBet;
      const actualAdd = Math.min(additional, actingPlayer.stack);

      if (actualAdd <= 0) { showToast('Invalid bet amount.', 'error'); undoStack.pop(); return; }
      if (targetBet % 5 !== 0) {
        showToast('Bet/Raise must be a multiple of 5.', 'error');
        undoStack.pop();
        return;
      }

      actingPlayer.stack -= actualAdd;
      hs.roundBet += actualAdd;
      hs.totalHandBet += actualAdd;
      hand.currentBet = hs.roundBet;
      hand.lastRaiserSeatIndex = actingPlayer.seatIndex;
      hand.bbHasOption = false;
      hs.acted = true;

      // Mark others as needing to act again
      handPlayers().forEach(p => {
        if (p.id !== actingPlayer.id) {
          const phs = getHandState(p.id);
          if (phs && !phs.folded && !phs.allIn) phs.acted = false;
        }
      });

      if (actingPlayer.stack === 0) {
        hs.allIn = true;
        addHistory(`${actingPlayer.name} ${action === 'bet' ? 'bets' : 'raises to'} ${hs.roundBet} (all-in).`, 'action');
      } else {
        addHistory(`${actingPlayer.name} ${action === 'bet' ? 'bets' : 'raises to'} ${hs.roundBet}.`, 'action');
      }
      break;
    }

    case 'allin': {
      const allInAmt = actingPlayer.stack;
      if (allInAmt === 0) { showToast('Player has no chips.', 'error'); undoStack.pop(); return; }
      actingPlayer.stack = 0;
      hs.roundBet += allInAmt;
      hs.totalHandBet += allInAmt;
      hs.allIn = true;
      hs.acted = true;
      if (hs.roundBet > hand.currentBet) {
        hand.currentBet = hs.roundBet;
        hand.lastRaiserSeatIndex = actingPlayer.seatIndex;
        hand.bbHasOption = false;
        // Force others to act again
        handPlayers().forEach(p => {
          if (p.id !== actingPlayer.id) {
            const phs = getHandState(p.id);
            if (phs && !phs.folded && !phs.allIn) phs.acted = false;
          }
        });
      }
      addHistory(`${actingPlayer.name} goes all-in (${allInAmt}).`, 'action');
      break;
    }

    default:
      undoStack.pop();
      return;
  }

  // In manual mode, don't auto-advance actor — just check for end conditions
  if (session.mode === 'manual') {
    checkHandEndConditions();
    saveSession();
    renderAll();
    return;
  }

  // Interactive mode: advance actor
  advanceActor();

  saveSession();
  renderAll();
}

/** For manual mode: check if hand/round should end after an action */
function checkHandEndConditions() {
  const hand = session.hand;
  const order = hand.activeSeatOrder;

  // Check if all but one have folded
  const activeSeat = order.filter(si => {
    const p = getHandPlayer(si);
    if (!p) return false;
    const hs = getHandState(p.id);
    return hs && !hs.folded;
  });
  if (activeSeat.length === 1) {
    hand.handComplete = true;
    addHistory('All others folded. Hand resolved.', 'system');
    collectBetsToPot();
    return;
  }

  // Check if round is complete
  if (isBettingRoundComplete()) {
    hand.roundComplete = true;
  }
}

function advanceActor() {
  const hand = session.hand;
  const order = hand.activeSeatOrder;

  // Check if hand should end (all but one folded)
  const activeSeat = order.filter(si => {
    const p = getHandPlayer(si);
    if (!p) return false;
    const hs = getHandState(p.id);
    return hs && !hs.folded;
  });
  if (activeSeat.length === 1) {
    hand.handComplete = true;
    addHistory('All others folded. Hand resolved.', 'system');
    collectBetsToPot(); // moves all roundBets into hand.pot
    saveSession();
    renderAll();
    return;
  }

  // Check if betting round is complete
  if (isBettingRoundComplete()) {
    hand.roundComplete = true;
    // Show the "next street" button — operator confirms the transition
    saveSession();
    renderAll();
    return;
  }

  // Find next player who must act
  const current = hand.currentActorIndex;
  for (let i = 1; i <= order.length; i++) {
    const nextIdx = (current + i) % order.length;
    const p = getHandPlayer(order[nextIdx]);
    if (!p) continue;
    const hs = getHandState(p.id);
    if (!hs || hs.folded || hs.allIn) continue;
    if (!hs.acted) {
      hand.currentActorIndex = nextIdx;
      updateControlsForCurrentActor();
      return;
    }
  }

  // All have acted — mark round complete, show next-street button
  hand.roundComplete = true;
  saveSession();
  renderAll();
}

function isBettingRoundComplete() {
  const hand = session.hand;
  const order = hand.activeSeatOrder;

  // Players who can still act
  const canAct = order.filter(si => {
    const p = getHandPlayer(si);
    if (!p) return false;
    const hs = getHandState(p.id);
    return hs && !hs.folded && !hs.allIn;
  });

  if (canAct.length === 0) return true;

  // Check if everyone who can act has acted and matched the current bet
  for (const si of canAct) {
    const p = getHandPlayer(si);
    const hs = getHandState(p.id);
    if (!hs.acted) return false;
    if (hs.roundBet < hand.currentBet) return false;
  }

  // Special: BB has option to raise pre-flop even if everyone called
  if (hand.street === 'preflop' && hand.bbHasOption) {
    const bbPlayer = getHandPlayer(hand.bbSeatIndex);
    if (bbPlayer) {
      const bbHs = getHandState(bbPlayer.id);
      if (bbHs && !bbHs.folded && !bbHs.allIn && !bbHs.acted) return false;
    }
  }

  return true;
}

function advanceStreet() {
  const hand = session.hand;

  if (hand.street === 'showdown') return;

  // Check again for single player standing
  const standing = hand.activeSeatOrder.filter(si => {
    const p = getHandPlayer(si);
    if (!p) return false;
    const hs = getHandState(p.id);
    return hs && !hs.folded;
  });
  if (standing.length <= 1) {
    hand.handComplete = true;
    collectBetsToPot();
    addHistory('Hand complete. Distribute pot.', 'system');
    renderAll();
    return;
  }

  // Check if all remaining are all-in => run all streets
  const canBet = standing.filter(si => {
    const p = getHandPlayer(si);
    const hs = getHandState(p.id);
    return hs && !hs.allIn;
  });

  collectBetsToPot();

  // Reset round state
  handPlayers().forEach(p => {
    const hs = getHandState(p.id);
    if (hs && !hs.folded) {
      hs.roundBet = 0;
      hs.acted = false;
    }
  });
  hand.currentBet = 0;
  hand.lastRaiserSeatIndex = -1;
  hand.bbHasOption = false;
  hand.roundComplete = false;

  const nextStreetMap = { preflop: 'flop', flop: 'turn', turn: 'river', river: 'showdown' };
  const prevReveal = hand.communityReveal;
  hand.street = nextStreetMap[hand.street];

  addHistory(`Street: ${STREET_LABELS[hand.street]}`, 'system');

  // Community card reveal counts + history messages
  const revealMessages = {
    flop:  'Reveal the Flop: Open 3 community cards on the physical table.',
    turn:  'Reveal the Turn: Open 1 additional community card.',
    river: 'Reveal the River: Open the final community card.',
  };
  if (hand.street === 'flop')  hand.communityReveal = 3;
  if (hand.street === 'turn')  hand.communityReveal = 4;
  if (hand.street === 'river') hand.communityReveal = 5;
  if (revealMessages[hand.street]) addHistory(revealMessages[hand.street], 'system');

  if (hand.street === 'showdown') {
    hand.handComplete = true;
    addHistory('Showdown — distribute pot to winner(s).', 'hand');
    saveSession();
    renderAll();
    return;
  }

  // Set post-flop first actor: first eligible clockwise after dealer
  const order = hand.activeSeatOrder;
  const dealerIdx = order.indexOf(hand.dealerSeatIndex);
  for (let i = 1; i <= order.length; i++) {
    const idx = (dealerIdx + i) % order.length;
    const p = getHandPlayer(order[idx]);
    if (!p) continue;
    const hs = getHandState(p.id);
    if (hs && !hs.folded && !hs.allIn) {
      hand.currentActorIndex = idx;
      break;
    }
  }

  saveSession();
  const cardRevealTarget = hand.communityReveal;
  if (cardRevealTarget > prevReveal) {
    // Render DOM with only previously-revealed cards so new ones start as unrevealed
    renderAllExceptCards(prevReveal);
    // Animate new cards
    triggerCardReveal(cardRevealTarget, prevReveal);
  } else {
    renderAll();
  }
  updateControlsForCurrentActor();
}

/** renderAll but with a custom revealed count for the card area (used during animations) */
function renderAllExceptCards(alreadyRevealedCount) {
  if (!session) return;
  renderSessionInfo();
  renderStage();
  renderPotPanel();
  renderHistory();
  if (session.hand) {
    renderCommunityCards(alreadyRevealedCount);
    revealedCards = alreadyRevealedCount;
    document.getElementById('board-street').textContent = STREET_LABELS[session.hand.street] || '';
    document.getElementById('game-street-label').textContent = STREET_LABELS[session.hand.street] || '';
  }
  updateControlsForCurrentActor();
}

// ================================================================
// COMMUNITY CARD ANIMATIONS
// ================================================================
let revealedCards = 0; // tracks what's been visually animated this render

/**
 * Animate community cards from `from` (exclusive) up to `upTo` (inclusive, 1-based count).
 * Assumes the DOM already has card slots; new cards should be unrevealed in DOM.
 */
function triggerCardReveal(upTo, from) {
  const slots = document.querySelectorAll('#community-cards .card-slot');
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  revealedCards = upTo;

  const messages = {
    3: 'Reveal the Flop: Open 3 community cards on the physical table.',
    4: 'Reveal the Turn: Open 1 additional community card.',
    5: 'Reveal the River: Open the final community card.',
  };

  for (let i = from; i < upTo; i++) {
    const slot = slots[i];
    if (!slot) continue;
    const card = slot.querySelector('.card');
    if (!card) continue;
    const delay = prefersReduced ? 0 : (i - from) * 200;
    setTimeout(() => {
      if (prefersReduced) {
        card.classList.remove('card--unrevealed');
        card.classList.add('card--revealed');
      } else {
        card.classList.add('card--flipping');
        card.addEventListener('animationend', () => {
          card.classList.remove('card--flipping', 'card--unrevealed');
          card.classList.add('card--revealed');
        }, { once: true });
      }
    }, delay);
  }

  // Show prompt
  const prompt = document.getElementById('street-prompt');
  if (prompt && messages[upTo]) {
    prompt.textContent = messages[upTo];
    prompt.classList.add('visible');
    setTimeout(() => prompt.classList.remove('visible'), 6000);
  }
}

/** Render community cards. alreadyRevealed: cards that should appear revealed without animation.
 *  pendingReveal: cards that will be animated (start as unrevealed). */
function renderCommunityCards(alreadyRevealed, pendingReveal) {
  const container = document.getElementById('community-cards');
  if (!container) return;
  container.innerHTML = '';

  for (let i = 0; i < 5; i++) {
    const slot = document.createElement('div');
    slot.className = 'card-slot';
    slot.setAttribute('role', 'listitem');
    slot.setAttribute('aria-label', `Community card ${i + 1}`);
    const card = document.createElement('div');
    card.className = 'card';
    if (i < alreadyRevealed) {
      card.classList.add('card--revealed');
    } else {
      card.classList.add('card--unrevealed');
    }
    slot.appendChild(card);
    container.appendChild(slot);
  }
}

// ================================================================
// POT DISTRIBUTION
// ================================================================

function renderPotPanel() {
  const hand = session?.hand;
  const total = hand ? totalPot() : 0;
  document.getElementById('pot-display-total').textContent = total;
  document.getElementById('board-pot').textContent = total;

  const list = document.getElementById('pot-list');
  list.innerHTML = '';

  if (!hand) return;

  const eligible = handPlayers().filter(p => {
    const hs = getHandState(p.id);
    return hs && !hs.folded;
  });

  eligible.forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `<label for="pd-${p.id}">${escHtml(p.name)}</label>
      <input id="pd-${p.id}" type="number" inputmode="numeric" min="0" value="0" data-pid="${p.id}">`;
    list.appendChild(li);
  });

  // Remainder indicator
  updatePotRemainder();

  // Enable Distribute only when hand is complete and pot hasn't been distributed yet
  const distBtn = document.getElementById('distribute-btn');
  distBtn.disabled = !hand.handComplete || hand.pot_distributed;
}

function updatePotRemainder() {
  const hand = session?.hand;
  if (!hand) return;
  const total = hand.pot_distributed ? 0 : totalPot();
  const inputs = document.querySelectorAll('#pot-list input');
  let assigned = 0;
  inputs.forEach(inp => { assigned += parseInt(inp.value, 10) || 0; });
  const rem = total - assigned;
  const remEl = document.getElementById('pot-remainder');
  if (rem === 0) {
    remEl.textContent = '✓ Balanced';
    remEl.style.color = 'var(--green)';
  } else if (rem > 0) {
    remEl.textContent = `Unassigned: ${rem}`;
    remEl.style.color = 'var(--gold)';
  } else {
    remEl.textContent = `Over by: ${Math.abs(rem)}`;
    remEl.style.color = 'var(--red)';
  }
}

document.getElementById('pot-list').addEventListener('input', updatePotRemainder);

document.getElementById('split-evenly-btn').addEventListener('click', () => {
  const hand = session?.hand;
  if (!hand) return;
  const total = totalPot();
  const inputs = document.querySelectorAll('#pot-list input');
  if (inputs.length === 0) return;
  const share = Math.floor(total / inputs.length);
  let rest = total - share * inputs.length;
  inputs.forEach(inp => {
    inp.value = share + (rest-- > 0 ? 1 : 0);
  });
  updatePotRemainder();
});

document.getElementById('distribute-btn').addEventListener('click', distributePot);

function distributePot() {
  const hand = session?.hand;
  if (!hand) return;
  if (hand.pot_distributed) { showToast('Pot already distributed.', 'warn'); return; }

  const total = totalPot();
  const inputs = document.querySelectorAll('#pot-list input');
  let assigned = 0;
  const alloc = [];
  inputs.forEach(inp => {
    const amt = parseInt(inp.value, 10) || 0;
    assigned += amt;
    alloc.push({ id: inp.dataset.pid, amount: amt });
  });

  if (assigned !== total) {
    showToast(`Allocations (${assigned}) must equal pot (${total}).`, 'error');
    return;
  }

  pushUndo();

  // Apply winnings
  alloc.forEach(({ id, amount }) => {
    if (amount <= 0) return;
    const p = getPlayer(id);
    if (!p) return;
    p.stack += amount;
    const hs = getHandState(id);
    if (hs && amount > 0) {
      addHistory(`${p.name} wins ${amount}.`, 'win');
    }
  });

  // Handle return of uncalled excess bets
  // (if currentBet > any player's all-in amount, the difference is returned)
  // This is handled conceptually — pot was computed correctly

  hand.pot = 0;
  hand.pot_distributed = true;
  hand.handComplete = true;

  addHistory(`Pot distributed. Hand #${session.handNumber} complete.`, 'hand');

  // Clean up players with 0 chips — they're effectively out
  // but we don't auto-remove them; operator decides

  saveSession();
  renderAll();
  showToast('Pot distributed!', 'success');
}

document.getElementById('pot-clear-btn').addEventListener('click', () => {
  document.querySelectorAll('#pot-list input').forEach(inp => { inp.value = 0; });
  updatePotRemainder();
});

// ================================================================
// CONTROLS / BETTING
// ================================================================

function updateControlsForCurrentActor() {
  if (!session?.hand) return;

  const hand = session.hand;
  const isInteractive = session.mode === 'interactive';
  const isManual = session.mode === 'manual';
  const handDone = hand.handComplete || hand.pot_distributed;

  const slider  = document.getElementById('bet-slider');
  const amtDisp = document.getElementById('bet-amount-display');
  const foldBtn = document.getElementById('fold-btn');
  const callBtn = document.getElementById('call-btn');
  const raiseBtn= document.getElementById('raise-btn');
  const allinBtn= document.getElementById('allin-btn');
  const undoBtn = document.getElementById('undo-btn');
  const nextBtn = document.getElementById('next-street-btn');
  const curBar  = document.getElementById('current-player-bar');
  const manRow  = document.getElementById('manual-select-row');

  // Manual mode: show player selector
  manRow.classList.toggle('hidden', isInteractive);
  if (isManual) renderManualPlayerSelect();

  // Determine acting player
  let actor = null;
  if (isInteractive) {
    actor = currentActor();
  } else {
    const sel = document.getElementById('manual-player-select').value;
    actor = sel ? getPlayer(sel) : null;
  }

  // Current player bar
  if (handDone) {
    curBar.innerHTML = `Hand complete — distribute pot.`;
  } else if (actor) {
    curBar.innerHTML = `Acting: <strong>${escHtml(actor.name)}</strong> — Stack: <strong class="text-gold">${actor.stack}</strong>`;
  } else {
    curBar.innerHTML = `Waiting…`;
  }

  // Next street / showdown button
  const roundDone = hand.roundComplete || isBettingRoundComplete();
  if (roundDone && !handDone) {
    const nextStreetLabel = {
      preflop: '→ Deal Flop',
      flop:    '→ Deal Turn',
      turn:    '→ Deal River',
      river:   '→ Showdown',
    }[hand.street] || '→ Continue';
    nextBtn.textContent = nextStreetLabel;
    nextBtn.classList.remove('hidden');
  } else {
    nextBtn.classList.add('hidden');
  }

  // If hand is done, disable all action buttons
  if (handDone) {
    [slider, foldBtn, callBtn, raiseBtn, allinBtn].forEach(el => el.disabled = true);
    amtDisp.textContent = '—';
    nextBtn.classList.add('hidden');
    return;
  }

  // Enable buttons based on state
  const hasActor = !!actor;
  const hs = actor ? getHandState(actor.id) : null;
  const canAct = hasActor && hs && !hs.folded && !hs.allIn && !roundDone;

  [foldBtn, callBtn, raiseBtn, allinBtn].forEach(el => el.disabled = !canAct);
  slider.disabled = !canAct;
  undoBtn.disabled = undoStack.length === 0;

  if (!canAct || !actor || !hs) {
    amtDisp.textContent = '—';
    return;
  }

  const callAmt    = Math.max(0, hand.currentBet - hs.roundBet);
  const canCheck   = callAmt === 0;
  const minBet     = hand.currentBet === 0 ? session.bigBlind : hand.currentBet * 2 - hs.roundBet;
  const maxBet     = actor.stack + hs.roundBet; // max target this street

  // Call / Check button label
  if (canCheck) {
    callBtn.textContent = 'Check';
    callBtn.className = 'btn btn--check';
    callBtn.onclick = () => performAction('check');
  } else {
    callBtn.textContent = `Call ${callAmt}`;
    callBtn.className = 'btn btn--call';
    callBtn.onclick = () => performAction('call');
  }

  // Fold
  foldBtn.onclick = () => performAction('fold');

  // All-in
  allinBtn.disabled = !canAct;
  allinBtn.onclick  = () => performAction('allin');

  // Slider: multiples-of-5 only
  // Minimum legal raise target, rounded UP to next multiple of 5
  const rawMin = Math.max(hand.currentBet + 1, hs.roundBet + 1);
  const snapMin = snapUp5(rawMin);
  // Maximum is the all-in total; round DOWN so we never exceed the stack
  // (All-in itself is always available via the All-in button regardless of step)
  const rawMax = maxBet;
  const snapMax = snapDown5(rawMax);

  // If no valid multiple-of-5 exists in [rawMin, rawMax], disable the raise button
  const raiseAvailable = snapMin <= rawMax;

  raiseBtn.disabled = !canAct || !raiseAvailable;

  if (!raiseAvailable) {
    // No valid step-5 target — only all-in applies
    amtDisp.textContent = '—';
    slider.disabled = true;
    return;
  }

  const effectiveMax = Math.max(snapMin, snapMax);
  const rawPrev = parseInt(slider.value, 10) || snapMin;
  const currentVal = snapTo5(clamp(rawPrev, snapMin, effectiveMax));

  slider.min   = snapMin;
  slider.max   = effectiveMax;
  slider.step  = 5;
  slider.value = currentVal;
  syncSlider(currentVal, hs.roundBet);

  // Raise / Bet button label
  const isFirstBet = hand.currentBet === 0;
  raiseBtn.textContent = isFirstBet ? `Bet ${currentVal}` : `Raise to ${currentVal}`;
  raiseBtn.onclick = () => {
    const snapped = snapTo5(clamp(parseInt(slider.value, 10), snapMin, effectiveMax));
    performAction(isFirstBet ? 'bet' : 'raise', snapped);
  };

  slider.oninput = () => {
    const snapped = snapTo5(clamp(parseInt(slider.value, 10), snapMin, effectiveMax));
    // Keep the slider thumb visually on a snap point
    if (parseInt(slider.value, 10) !== snapped) slider.value = snapped;
    syncSlider(snapped, hs.roundBet);
    raiseBtn.textContent = isFirstBet ? `Bet ${snapped}` : `Raise to ${snapped}`;
    raiseBtn.onclick = () => performAction(isFirstBet ? 'bet' : 'raise', snapped);
  };
}

/** Round x up to the nearest multiple of 5 */
function snapUp5(x) { return Math.ceil(x / 5) * 5; }
/** Round x down to the nearest multiple of 5 */
function snapDown5(x) { return Math.floor(x / 5) * 5; }
/** Round x to nearest multiple of 5 */
function snapTo5(x) { return Math.round(x / 5) * 5; }

function syncSlider(val, playerCurrentBet) {
  const slider  = document.getElementById('bet-slider');
  const amtDisp = document.getElementById('bet-amount-display');
  const min = parseInt(slider.min, 10);
  const max = parseInt(slider.max, 10);
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
  slider.style.setProperty('--p', pct + '%');
  const additional = val - playerCurrentBet;
  amtDisp.textContent = `${val} (+${additional})`;
}

function renderManualPlayerSelect() {
  const sel = document.getElementById('manual-player-select');
  const cur = sel.value;
  sel.innerHTML = '';
  const hand = session?.hand;
  if (!hand) return;
  handPlayers().forEach(p => {
    const hs = getHandState(p.id);
    if (!hs || hs.folded || hs.allIn) return;
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
  if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
  sel.onchange = updateControlsForCurrentActor;
}

// ================================================================
// NEW HAND / END SESSION
// ================================================================

document.getElementById('new-hand-btn').addEventListener('click', async () => {
  if (!session) return;
  const hand = session.hand;

  if (hand && !hand.handComplete) {
    const ok = await showConfirm(
      'New Hand',
      'The current hand is not resolved. Are you sure you want to start a new hand? (Pot will not be distributed.)',
      'Start New Hand',
      'btn--danger'
    );
    if (!ok) return;
  }

  // Check enough eligible players
  const ep = activePlayers().filter(p => p.stack > 0);
  if (ep.length < MIN_PLAYERS) {
    showToast(`Need at least ${MIN_PLAYERS} players with chips to start a new hand.`, 'warn');
    return;
  }

  startNewHand();
});

document.getElementById('end-session-btn').addEventListener('click', async () => {
  const ok = await showConfirm(
    'End Session',
    'Are you sure you want to end this session? A session summary will be shown.',
    'End Session',
    'btn--danger'
  );
  if (!ok) return;
  showSessionSummary();
});

function showSessionSummary() {
  const bodyEl = document.getElementById('modal-end-body');
  const lines = [];
  lines.push(`<strong>Session:</strong> ${escHtml(session.name)}`);
  lines.push(`<strong>Hands played:</strong> ${session.handNumber}`);
  lines.push(`<strong>Mode:</strong> ${session.mode === 'interactive' ? 'Interactive' : 'Manual'}`);
  lines.push('<br><strong>Final Chip Counts:</strong>');
  const sorted = [...session.players].filter(p => p.active || p.totalBuyIn > 0)
    .sort((a, b) => b.stack - a.stack);
  sorted.forEach(p => {
    const net = p.stack - p.totalBuyIn;
    const sign = net >= 0 ? '+' : '';
    lines.push(`&nbsp;&nbsp;${escHtml(p.name)}: ${p.stack} (${sign}${net})`);
  });
  bodyEl.innerHTML = lines.join('<br>');

  document.getElementById('modal-session-end').classList.remove('hidden');

  addHistory('Session ended.', 'hand');
  session.active = false;
  saveSession();
}

document.getElementById('modal-end-new').addEventListener('click', () => {
  document.getElementById('modal-session-end').classList.add('hidden');
  clearSession();
  session = null;
  setupPlayers = [];
  setupDenoms  = [...DEFAULT_DENOMS];
  renderDenomTags();
  renderSetupPlayers();
  openSetupPage();
});

document.getElementById('modal-end-close').addEventListener('click', () => {
  document.getElementById('modal-session-end').classList.add('hidden');
  openSetupPage();
});

// ================================================================
// NEXT STREET BUTTON
// ================================================================
document.getElementById('next-street-btn').addEventListener('click', () => {
  if (!session?.hand) return;
  const hand = session.hand;
  if (hand.roundComplete && !hand.handComplete) {
    advanceStreet();
  } else if (isBettingRoundComplete() && !hand.handComplete) {
    advanceStreet();
  }
});

// ================================================================
// PLAYER MANAGEMENT (DURING GAME)
// ================================================================

// Add player button on the table
document.getElementById('add-player-seat-btn').addEventListener('click', () => {
  document.getElementById('modal-player-name').value = '';
  document.getElementById('modal-player-chips').value = '1000';
  document.getElementById('modal-player-error').textContent = '';
  document.getElementById('modal-add-player').classList.remove('hidden');
  document.getElementById('modal-player-name').focus();
});

document.getElementById('modal-add-cancel').addEventListener('click', () => {
  document.getElementById('modal-add-player').classList.add('hidden');
});

document.getElementById('modal-add-ok').addEventListener('click', addPlayerDuringGame);

document.getElementById('modal-player-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') addPlayerDuringGame();
});

function addPlayerDuringGame() {
  const nameEl  = document.getElementById('modal-player-name');
  const chipsEl = document.getElementById('modal-player-chips');
  const errEl   = document.getElementById('modal-player-error');
  errEl.textContent = '';

  const name  = nameEl.value.trim();
  const chips = parseInt(chipsEl.value, 10);

  if (!name) { errEl.textContent = 'Enter a player name.'; return; }
  if (session.players.some(p => p.active && p.name.toLowerCase() === name.toLowerCase())) {
    errEl.textContent = 'A player with this name is already in the session.'; return;
  }
  if (!Number.isInteger(chips) || chips < 1) {
    errEl.textContent = 'Enter a valid chip amount.'; return;
  }
  const activeCount = activePlayers().length + session.players.filter(p => p.waitingToJoin).length;
  if (activeCount >= MAX_PLAYERS) {
    errEl.textContent = `Maximum ${MAX_PLAYERS} players.`; return;
  }

  pushUndo();

  // Assign next available seatIndex
  const usedSeats = session.players.map(p => p.seatIndex);
  let newSeat = 0;
  while (usedSeats.includes(newSeat)) newSeat++;

  const isHandActive = session.hand && !session.hand.handComplete;
  const newPlayer = {
    id: uid(),
    name,
    stack: chips,
    totalBuyIn: chips,
    active: true,
    seatIndex: newSeat,
    waitingToJoin: isHandActive, // must wait if hand is unresolved
    pendingRemove: false,
  };

  session.players.push(newPlayer);

  addHistory(`${name} joined the session${isHandActive ? ' (joins next hand)' : ''}.`, 'system');
  saveSession();
  document.getElementById('modal-add-player').classList.add('hidden');
  renderAll();
  showToast(`${name} added${isHandActive ? ' — will join next hand.' : '.'}`, 'success');
}

async function removePlayerDuringGame(playerId) {
  const p = getPlayer(playerId);
  if (!p) return;

  const hand = session.hand;
  const isHandActive = hand && !hand.handComplete;
  const hs = isHandActive ? getHandState(playerId) : null;

  if (isHandActive && hs && !hs.folded && hand.activeSeatOrder.includes(p.seatIndex)) {
    // Player is in active hand
    const ok = await showConfirm(
      'Remove Player',
      `${p.name} is in an active hand. They will be removed after the current hand completes.`,
      'Schedule Removal',
      'btn--danger'
    );
    if (!ok) return;
    p.pendingRemove = true;
    addHistory(`${p.name} will be removed after this hand.`, 'system');
    saveSession();
    renderAll();
    showToast(`${p.name} will be removed after this hand.`, 'warn');
    return;
  }

  const ok = await showConfirm(
    'Remove Player',
    `Remove ${p.name} from the session? Their history and final chip count will be preserved.`,
    'Remove',
    'btn--danger'
  );
  if (!ok) return;

  pushUndo();
  p.active = false;
  p.waitingToJoin = false;
  p.pendingRemove = false;
  addHistory(`${p.name} left the session (${p.stack} chips).`, 'system');
  saveSession();
  renderAll();
  showToast(`${p.name} removed.`, 'warn');

  // Check if enough players remain
  if (activePlayers().length < MIN_PLAYERS) {
    showToast(`Fewer than ${MIN_PLAYERS} active players — cannot start a new hand.`, 'warn');
  }
}

// ================================================================
// RENDERING
// ================================================================

function renderAll() {
  if (!session) return;
  renderSessionInfo();
  renderStage();
  renderPotPanel();
  renderHistory();
  if (session.hand) {
    // Render cards with current state (no pending reveal here — callers handle animation)
    renderCommunityCards(session.hand.communityReveal);
    revealedCards = session.hand.communityReveal;
    document.getElementById('board-street').textContent = STREET_LABELS[session.hand.street] || '';
    document.getElementById('game-street-label').textContent = STREET_LABELS[session.hand.street] || '';
  }
  updateControlsForCurrentActor();
}

function renderSessionInfo() {
  document.getElementById('game-session-name').textContent = session.name;
  document.getElementById('game-blinds-label').textContent = `${session.smallBlind}/${session.bigBlind}`;
  document.getElementById('game-hand-label').textContent   = `Hand #${session.handNumber}`;
  const modeEl = document.getElementById('game-mode-label');
  modeEl.innerHTML = `<span class="session__badge">${session.mode === 'interactive' ? 'Interactive' : 'Manual'}</span>`;
}

function renderHistory() {
  const list = document.getElementById('history-list');
  if (!list) return;
  list.innerHTML = '';
  session.history.slice(0, 50).forEach(entry => {
    const li = document.createElement('li');
    li.className = `h-${entry.type}`;
    li.textContent = entry.text;
    list.appendChild(li);
  });
}

function renderStage() {
  const stage  = document.getElementById('stage');
  if (!stage) return;

  // Remove old seats (keep .board, .table, community-cards, street-prompt, add-player-seat-btn)
  stage.querySelectorAll('.seat:not(#add-player-seat-btn)').forEach(s => s.remove());

  const hand = session.hand;
  const ap   = activePlayers();
  const n    = ap.length;
  const addBtn = document.getElementById('add-player-seat-btn');

  // Place player seats using the n-player layout
  if (n > 0) {
    const posKey = Math.min(n, 9).toString();
    const posSet = SEAT_POSITIONS[posKey] || SEAT_POSITIONS['6'];
    const sorted = [...ap].sort((a, b) => a.seatIndex - b.seatIndex);

    sorted.forEach((p, posIdx) => {
      // Clamp to last defined position if more players than slots (should not happen)
      const pos = posSet[posIdx] || posSet[posSet.length - 1];
      const seatEl = buildSeatElement(p, pos, hand);
      stage.insertBefore(seatEl, addBtn);
    });
  }

  // Place the Add Player button in its own dedicated slot — never overlapping a player seat
  if (n < MAX_PLAYERS) {
    const addPos = ADD_BTN_POSITIONS[n] || { x: 656, y: 344 };
    addBtn.style.setProperty('--x', addPos.x);
    addBtn.style.setProperty('--y', addPos.y);
    addBtn.style.display = 'grid';
  } else {
    addBtn.style.display = 'none';
  }
}

function buildSeatElement(player, pos, hand) {
  const hs = hand ? getHandState(player.id) : null;
  const isDealer = hand && hand.dealerSeatIndex === player.seatIndex;
  const isSB     = hand && hand.sbSeatIndex === player.seatIndex;
  const isBB     = hand && hand.bbSeatIndex === player.seatIndex;
  const isCurrent= hand && !hand.handComplete &&
                   hand.activeSeatOrder[hand.currentActorIndex] === player.seatIndex &&
                   session.mode === 'interactive';
  const isFolded = hs?.folded || false;
  const isAllIn  = hs?.allIn  || false;
  const isPending= player.pendingRemove;

  const seat = document.createElement('article');
  seat.className = 'seat';
  seat.style.setProperty('--x', pos.x);
  seat.style.setProperty('--y', pos.y);
  if (isCurrent) seat.classList.add('seat--active');
  if (isFolded)  seat.classList.add('seat--folded');
  if (isAllIn)   seat.classList.add('seat--allin');
  if (isPending) seat.classList.add('seat--waiting');

  seat.setAttribute('aria-label', `${player.name}, ${player.stack} chips`);

  // Badges
  let badges = '';
  if (isDealer) badges += `<span class="seat__badge badge--dealer">D</span>`;
  if (isSB)     badges += `<span class="seat__badge badge--sb">SB</span>`;
  if (isBB)     badges += `<span class="seat__badge badge--bb">BB</span>`;
  if (player.waitingToJoin) badges += `<span class="seat__badge badge--waiting">Next</span>`;

  const contrib = hs ? hs.roundBet : 0;
  const totalContrib = hs ? hs.totalHandBet : 0;
  const statusText = isFolded ? 'Folded' : isAllIn ? 'All-in' : isPending ? 'Leaving…' : '';

  seat.innerHTML = `
    <div class="seat__row1">
      <span class="seat__name">${escHtml(player.name)}</span>
      ${badges}
    </div>
    <div class="seat__row1-right">
      <button class="seat__exit" type="button" aria-label="Remove ${escHtml(player.name)}" data-pid="${player.id}">
        <svg aria-hidden="true"><use href="#icon-exit"/></svg>
      </button>
    </div>
    <p class="seat__stack">${player.stack}</p>
    ${contrib > 0 ? `<p class="seat__in">Bet: ${contrib}</p>` : ''}
    ${statusText ? `<p class="seat__status">${statusText}</p>` : ''}
  `;

  seat.querySelector('.seat__exit').addEventListener('click', () => {
    removePlayerDuringGame(player.id);
  });

  return seat;
}

// ================================================================
// ESCAPE HTML
// ================================================================
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ================================================================
// UNDO BUTTON
// ================================================================
document.getElementById('undo-btn').addEventListener('click', popUndo);

// ================================================================
// BOOTSTRAP
// ================================================================

(function init() {
  // Render initial setup state
  renderDenomTags();
  renderSetupPlayers();

  // Check for saved session
  const saved = loadSession();
  if (saved && saved.active) {
    const restore = confirm(
      `Restore saved session "${saved.name}" (Hand #${saved.handNumber})?`
    );
    if (restore) {
      session = saved;
      // Restore community cards without animation
      revealedCards = session.hand?.communityReveal || 0;
      openGamePage();
      renderAll();
      addHistory('Session restored from saved state.', 'system');
      return;
    } else {
      clearSession();
    }
  }

  // Start on setup page
  openSetupPage();
})();
