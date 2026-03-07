/* ============================================================
   POCKET APP — script.js  (Apex Survival-Budget v2)
   Dynamic micro-income · Utang protocol · Buffer tax · Health tracking
   ============================================================ */

/* ════════════════════════════════════════════════════════════
   1. CONSTANTS & INITIAL STATE
   ════════════════════════════════════════════════════════════ */

const STORAGE_KEY = 'pocket-app-v2';

const INITIAL_STATE = {
  isSetupComplete: false,
  microIncomeLedger: [],      // [{ id, amount(¢), label, date(ISO) }]
  nextIncomeDate: null,    // ISO — next expected cash injection
  cashOnHand: 0,       // centavos — liquid funds after bills/utang
  tier1Bills: [],      // [{ id, label, amount(¢), dueDate(ISO), isPaid }]
  tier2Config: { categories: ['food', 'transport'] },
  transactions: [],      // [{ id, date(ISO), amount(¢), tier, category, satietyScore?, note? }]
  setupDate: null,    // ISO
  utangLedger: [],      // [{ id, amount(¢), label, date(ISO), isPaid }]
  emergencyVault: 0,       // centavos — locked Tier 3 savings
  nutritionLog: [],      // [{ date, score, cost }]
  lastProcessedDate: null,    // ISO — last date we ran end-of-day rollover
};

const SATIETY_TAGS = [
  { value: 1, label: 'Junk', emoji: '🍜' },
  { value: 2, label: 'Low', emoji: '🍞' },
  { value: 3, label: 'Fair', emoji: '👌' },
  { value: 4, label: 'Good', emoji: '🥩' },
  { value: 5, label: 'Excellent', emoji: '🥗' },
];

const CAT_ICONS = { food: '🍚', transport: '🚌' };

/* ════════════════════════════════════════════════════════════
   2. STORAGE HELPERS
   ════════════════════════════════════════════════════════════ */

let appState = { ...INITIAL_STATE };

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...INITIAL_STATE };
    return { ...INITIAL_STATE, ...JSON.parse(raw) };
  } catch { return { ...INITIAL_STATE }; }
}

function saveState(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { /* silent */ }
}

function clearState() {
  localStorage.removeItem(STORAGE_KEY);
  appState = { ...INITIAL_STATE };
}

function exportJSON() {
  const blob = new Blob([JSON.stringify(appState, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pocket-app-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ════════════════════════════════════════════════════════════
   3. FORMATTING UTILITIES
   ════════════════════════════════════════════════════════════ */

function formatPeso(centavos) { return '₱' + (centavos / 100).toFixed(2); }

function pesoToCentavos(str) {
  const n = parseFloat(String(str).replace(/[^0-9.]/g, ''));
  if (!n || n <= 0 || isNaN(n)) return 0;
  return Math.round(n * 100);
}

function todayISO() { return localISO(new Date()); }

function localISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function formatDate(isoStr) {
  if (!isoStr) return '';
  const [y, m, d] = isoStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function daysBetween(iso1, iso2) {
  const d1 = new Date(iso1 + 'T00:00:00').getTime();
  const d2 = new Date(iso2 + 'T00:00:00').getTime();
  return Math.max(1, Math.ceil((d2 - d1) / 86400000));
}

/* ════════════════════════════════════════════════════════════
   4. BUDGET ENGINE — Dynamic micro-income + 50/50 buffer tax
   ════════════════════════════════════════════════════════════ */

/**
 * processEndOfDay(state)
 * Called on boot / after actions. Walks from lastProcessedDate to yesterday,
 * applying the 50/50 buffer tax on each day's surplus.
 * Mutates state.emergencyVault and state.lastProcessedDate, returns rollover.
 */
function processEndOfDay(state) {
  const today = todayISO();
  if (!state.setupDate || !state.lastProcessedDate) return 0;

  const startDate = state.lastProcessedDate;
  if (startDate >= today) return 0; // already up to date

  const billsTotal = state.tier1Bills.filter(b => !b.isPaid).reduce((s, b) => s + b.amount, 0);
  const utangOwed = state.utangLedger.filter(u => !u.isPaid).reduce((s, u) => s + u.amount, 0);
  const availableCash = state.cashOnHand - billsTotal;
  const daysToNext = state.nextIncomeDate ? daysBetween(today, state.nextIncomeDate) : 30;
  const rawDaily = availableCash / Math.max(1, daysToNext);

  let rollover = 0;
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(today + 'T00:00:00');

  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    const ds = localISO(d);
    if (ds === today) break; // don't process today yet
    const daySpent = state.transactions
      .filter(t => t.date === ds && t.tier === 2)
      .reduce((s, t) => s + t.amount, 0);
    const surplus = rawDaily - daySpent;
    if (surplus > 0) {
      // 50/50 BUFFER TAX: half rolls over, half locked in vault
      const half = Math.floor(surplus / 2);
      rollover += half;
      state.emergencyVault += (surplus - half); // ceiling goes to vault
    }
  }

  state.lastProcessedDate = today;
  return rollover;
}

/**
 * computeEngine(state) → { dailyAllowance, isDeficit, todayState, unpaidBillsTotal, ... }
 * Core: dailyAllowance = cashOnHand / daysUntilNextIncome
 */
function computeEngine(state) {
  const today = todayISO();

  /* ── Bills & Utang totals ── */
  const billsTotal = state.tier1Bills.filter(b => !b.isPaid).reduce((s, b) => s + b.amount, 0);
  const utangOwed = state.utangLedger.filter(u => !u.isPaid).reduce((s, u) => s + u.amount, 0);
  const availableCash = state.cashOnHand - billsTotal;

  /* ── Daily allowance from cash-on-hand / days remaining ── */
  const daysToNext = state.nextIncomeDate ? daysBetween(today, state.nextIncomeDate) : 30;
  const dailyAllowance = availableCash / Math.max(1, daysToNext);
  const isDeficit = dailyAllowance <= 0;

  /* ── Process past days (50/50 buffer tax) ── */
  const rollover = processEndOfDay(state);

  /* ── Today's tier-2 spending ── */
  const todaySpent = state.transactions
    .filter(t => t.date === today && t.tier === 2)
    .reduce((s, t) => s + t.amount, 0);

  const todayState = {
    allowance: Math.max(0, dailyAllowance),
    spent: todaySpent,
    rollover: rollover,
  };

  /* ── Vault: unpaid bills ── */
  const unpaidBills = state.tier1Bills.filter(b => !b.isPaid);
  const unpaidBillsTotal = unpaidBills.reduce((s, b) => s + b.amount, 0);

  let nextBillDays = null;
  const todayMs = new Date(today + 'T00:00:00').getTime();
  for (const bill of unpaidBills) {
    if (!bill.dueDate) continue;
    const du = Math.ceil((new Date(bill.dueDate + 'T00:00:00').getTime() - todayMs) / 86400000);
    if (du >= 0 && (nextBillDays === null || du < nextBillDays)) nextBillDays = du;
  }

  /* ── Health debt check ── */
  const healthWarning = checkHealthDebt(state);

  return {
    dailyAllowance: Math.max(0, dailyAllowance), isDeficit, todayState,
    unpaidBillsTotal, nextBillDays, buffer: rollover,
    emergencyVault: state.emergencyVault, utangOwed, healthWarning,
    daysToNext, availableCash,
  };
}

/* ── Health Debt Detection ── */
function checkHealthDebt(state) {
  const today = todayISO();
  const threeDaysAgo = new Date(today + 'T00:00:00');
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  const cutoff = localISO(threeDaysAgo);

  const recent = state.nutritionLog.filter(n => n.date >= cutoff);
  if (recent.length < 3) return null;

  const avgScore = recent.reduce((s, n) => s + n.score, 0) / recent.length;
  const avgCost = recent.reduce((s, n) => s + n.cost, 0) / recent.length;

  if (avgScore <= 2 && avgCost > 3000) { // avg ≤2 score, avg >₱30 cost
    return {
      avgScore: avgScore.toFixed(1),
      avgCost: Math.round(avgCost),
      meals: recent.length,
    };
  }
  return null;
}

/* ════════════════════════════════════════════════════════════
   5. TRANSACTION, BILL & INCOME HELPERS
   ════════════════════════════════════════════════════════════ */

function addTransaction(tx) {
  const engine = computeEngine(appState);
  const pool = engine.todayState.allowance + engine.buffer;
  const projected = engine.todayState.spent + tx.amount;
  if (projected > pool) return { blocked: true };

  appState.transactions.push({ ...tx, id: uid() });

  // Track nutrition
  if (tx.category === 'food' && tx.satietyScore) {
    appState.nutritionLog.push({ date: tx.date, score: tx.satietyScore, cost: tx.amount });
  }

  // Deduct from cash on hand
  appState.cashOnHand = Math.max(0, appState.cashOnHand - tx.amount);

  saveState(appState);
  return { blocked: false };
}

function addMicroIncome(amount, label) {
  const entry = { id: uid(), amount, label: label || 'Funds added', date: todayISO() };
  appState.microIncomeLedger.push(entry);

  // Auto-deduct utang FIFO before crediting cash
  let remaining = amount;
  for (const u of appState.utangLedger) {
    if (u.isPaid || remaining <= 0) continue;
    if (remaining >= u.amount) {
      remaining -= u.amount;
      u.isPaid = true;
    } else {
      u.amount -= remaining;
      remaining = 0;
    }
  }

  appState.cashOnHand += remaining;
  saveState(appState);
  return { deducted: amount - remaining, credited: remaining };
}

function addUtang(amount, label) {
  appState.utangLedger.push({
    id: uid(), amount, label: label || 'Micro-loan', date: todayISO(), isPaid: false,
  });
  // Utang gives you cash now (borrowed money)
  appState.cashOnHand += amount;
  saveState(appState);
}

function toggleBillPaid(id) {
  const bill = appState.tier1Bills.find(b => b.id === id);
  if (bill) {
    bill.isPaid = !bill.isPaid;
    if (bill.isPaid) {
      appState.cashOnHand -= bill.amount;
    } else {
      appState.cashOnHand += bill.amount;
    }
    saveState(appState);
  }
}

/* ════════════════════════════════════════════════════════════
   6. VIEW / MODAL HELPERS
   ════════════════════════════════════════════════════════════ */

const VIEWS = ['view-loading', 'view-welcome', 'view-setup', 'view-dashboard'];

function showView(id, displayType) {
  VIEWS.forEach(v => { const el = document.getElementById(v); if (el) el.style.display = 'none'; });
  const target = document.getElementById(id);
  if (!target) return;
  target.style.display = displayType || (id === 'view-loading' || id === 'view-welcome' ? 'flex' : 'block');
}

function openModal(id) { const el = document.getElementById(id); if (el) el.style.display = 'flex'; }
function closeModal(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
function showEl(id, type = 'block') { const el = document.getElementById(id); if (el) el.style.display = type; }
function hideEl(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }

function shakeInput(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('animate-shake');
  void el.offsetWidth;
  el.classList.add('animate-shake');
  el.style.borderColor = '#ff4b4b';
  setTimeout(() => { el.classList.remove('animate-shake'); el.style.borderColor = '#ede8df'; }, 650);
}

function addFocusBorder(id, fc = '#1cb0f6', bc = '#ede8df') {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('focus', () => el.style.borderColor = fc);
  el.addEventListener('blur', () => el.style.borderColor = bc);
}


/* ════════════════════════════════════════════════════════════
   7. SETUP RENDERERS
   ════════════════════════════════════════════════════════════ */

let pendingSetupBills = [];
let currentSetupStep = 1;

function showSetupStep(step) {
  currentSetupStep = step;
  [1, 2, 3].forEach(s => {
    const el = document.getElementById(`setup-step-${s}`);
    if (el) el.style.display = s === step ? 'block' : 'none';
  });
  document.querySelectorAll('.setup-step-dot').forEach((dot, i) => {
    const s = i + 1;
    dot.classList.toggle('active', s === step);
    dot.classList.toggle('done', s < step);
  });
}

function renderSetupBills() {
  const list = document.getElementById('bills-list');
  if (!list) return;
  if (pendingSetupBills.length === 0) {
    list.innerHTML = `<p class="text-center text-sm py-3" style="color:#7a7a7a">No bills added yet — tap below to add one</p>`;
    return;
  }
  list.innerHTML = pendingSetupBills.map((b, i) => `
    <div class="flex items-center justify-between rounded-xl px-4 py-3 animate-fade-in"
         style="background:#f7f4f0; border:2px solid #ede8df;">
      <div>
        <div class="text-sm font-bold" style="color:#2e2e2e">${esc(b.label)}</div>
        <div style="font-size:11px; font-weight:600; color:#7a7a7a">${formatDate(b.dueDate)}</div>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span class="font-nums text-sm" style="color:#ff4b4b;">${formatPeso(b.amount)}</span>
        <button class="btn-squishy w-8 h-8 rounded-full flex items-center justify-center text-sm"
                style="background:#fff0f0; color:#ff4b4b;"
                data-remove-bill="${i}" aria-label="Remove bill">✕</button>
      </div>
    </div>`).join('');
}

function renderSetupSummary() {
  const funds = pesoToCentavos(document.getElementById('income-input').value);
  const nextDate = document.getElementById('next-income-date').value || '';
  const billsTotal = pendingSetupBills.reduce((s, b) => s + b.amount, 0);
  const daysToNext = nextDate ? daysBetween(todayISO(), nextDate) : 30;
  const utangTotal = 0;
  const available = funds - billsTotal - utangTotal;
  const daily = available / Math.max(1, daysToNext);
  const isDeficit = daily <= 0;

  const el = document.getElementById('setup-summary');
  if (!el) return;

  el.innerHTML = `
    <div class="space-y-3">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span class="text-sm font-bold" style="color:#7a7a7a;">Initial Funds</span>
        <span class="font-nums text-sm" style="color:#1cb0f6;">${formatPeso(funds)}</span>
      </div>
      ${pendingSetupBills.length > 0 ? `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span class="text-sm font-bold" style="color:#7a7a7a;">Total Bills</span>
        <span class="font-nums text-sm" style="color:#ff4b4b;">−${formatPeso(billsTotal)}</span>
      </div>` : ''}
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span class="text-sm font-bold" style="color:#7a7a7a;">Days Until Next Income</span>
        <span class="font-nums text-sm" style="color:#7a7a7a;">${daysToNext} days</span>
      </div>
      <div style="height:1px; background:#ede8df;"></div>
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span class="font-bold" style="font-size:13px; color:#7a7a7a;">Daily Budget</span>
        <span class="font-nums" style="font-size:22px; font-weight:900; color:${isDeficit ? '#ff4b4b' : '#58cc02'};">
          ${isDeficit ? '😟 Deficit!' : formatPeso(Math.max(0, daily))}
        </span>
      </div>
      <div class="text-xs font-semibold text-center" style="color:#7a7a7a;">
        ${pendingSetupBills.length} bill${pendingSetupBills.length !== 1 ? 's' : ''} tracked •
        ${isDeficit ? 'Consider an Advance to bridge the gap 🛡️' : `${formatPeso(Math.max(0, daily))}/day for ${daysToNext} days`}
      </div>
    </div>`;
}


/* ════════════════════════════════════════════════════════════
   8. DASHBOARD RENDERERS
   ════════════════════════════════════════════════════════════ */

function renderDashboard() {
  const engine = computeEngine(appState);
  renderDeficitAlert(engine);
  renderBudgetRing(engine.todayState);
  renderBufferFund(engine.buffer);
  renderEmergencyVault(engine.emergencyVault);
  renderUtangStatus();
  renderVaultStatus(appState.tier1Bills, engine.unpaidBillsTotal, engine.nextBillDays);
  renderHealthWarning(engine.healthWarning);
  renderCashStatus(engine);
}

/* ── Deficit Alert + Crisis Protocol trigger ── */
function renderDeficitAlert(engine) {
  const el = document.getElementById('deficit-alert');
  if (!el) return;
  if (!engine.isDeficit) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  const deficitAmt = Math.abs(engine.availableCash);
  el.innerHTML = `
    <div class="rounded-2xl p-4 relative overflow-hidden animate-shake"
         style="background:linear-gradient(135deg,#fff8e0,#fff0e0);
                border:2px solid #ffc800; box-shadow:0 6px 20px rgba(255,200,0,0.2);">
      <div style="position:absolute; top:-24px; right:-24px; width:80px; height:80px;
                  border-radius:50%; background:#ffc800; opacity:0.1;"></div>
      <div style="position:relative; display:flex; align-items:center; gap:12px;">
        <div class="flex-shrink-0 w-12 h-12 rounded-2xl flex items-center justify-center text-2xl"
             style="background:rgba(255,200,0,0.15);">🛡️</div>
        <div style="flex:1;">
          <div class="font-display" style="font-size:14px; color:#8a6d00;">Need a Bridge?</div>
          <div style="font-size:11px; font-weight:700; color:#7a7a7a; margin-top:2px;">
          You're ${deficitAmt > 0 ? `₱${(deficitAmt / 100).toFixed(0)} short for bills.` : `out of daily budget.`} Activate the bridge to keep moving forward.
        </div>
        </div>
        <button id="trigger-crisis-btn" class="btn-squishy px-4 py-2 rounded-xl text-xs font-bold text-white"
                style="background:linear-gradient(135deg,#ffc800,#e0a000); box-shadow:0 3px 0 #c89000; white-space:nowrap;">
          Bridge It 🌉
        </button>
      </div>
    </div>`;
  const crisisBtn = document.getElementById('trigger-crisis-btn');
  if (crisisBtn) {
    crisisBtn.onclick = () => {
      document.getElementById('utang-amount').value = (deficitAmt / 100).toFixed(2);
      openModal('modal-crisis');
    };
  }
}

/* ── Cash Status Bar ── */
function renderCashStatus(engine) {
  const el = document.getElementById('cash-status-container');
  if (!el) return;
  const nextLabel = appState.nextIncomeDate ? formatDate(appState.nextIncomeDate) : '—';
  el.innerHTML = `
    <div class="rounded-2xl p-4 animate-fade-in"
         style="background:linear-gradient(135deg,#e8f6ff,#d4efff); border:2px solid #1cb0f622;">
      <div style="display:flex; align-items:center; justify-content:space-between;">
        <div style="display:flex; align-items:center; gap:10px;">
          <span style="font-size:22px;">💰</span>
          <div>
            <div style="font-size:11px; font-weight:700; color:#1899d6;">CASH ON HAND</div>
            <div class="font-nums" style="font-size:20px; color:#1cb0f6;">${formatPeso(appState.cashOnHand)}</div>
          </div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:10px; font-weight:700; color:#7a7a7a;">NEXT INCOME</div>
          <div style="font-size:13px; font-weight:700; color:#2e2e2e;">${nextLabel}</div>
          <div style="font-size:10px; font-weight:600; color:#7a7a7a;">${engine.daysToNext} day${engine.daysToNext !== 1 ? 's' : ''} left</div>
        </div>
      </div>
    </div>`;
}

/* ── Budget Ring (same SVG approach) ── */
function renderBudgetRing({ allowance, spent, rollover }) {
  const total = allowance + rollover;
  const remaining = total - spent;
  const pct = total > 0 ? Math.min(spent / total, 1) : (spent > 0 ? 1 : 0);
  const isOver = remaining < 0;
  const isWarn = !isOver && pct > 0.8;
  const r = 74, C = 2 * Math.PI * r;
  const dashOffset = C * (1 - pct);
  const color = isOver ? '#ff4b4b' : isWarn ? '#ffc800' : '#58cc02';
  const gradId = isOver ? 'gradRed' : isWarn ? 'gradYellow' : 'gradGreen';
  const badgeBg = isOver ? '#fff0f0' : isWarn ? '#fff8e0' : '#e8ffe8';
  const badge = isOver ? '😰 over budget' : isWarn ? '⚠️ almost gone' : '✨ left today';

  const container = document.getElementById('budget-ring-container');
  if (!container) return;
  container.innerHTML = `
    <div style="position:relative; filter:drop-shadow(0 8px 24px ${color}44);">
      <svg width="210" height="210" viewBox="0 0 210 210" aria-hidden="true">
        <defs>
          <linearGradient id="gradGreen" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#78e820"/><stop offset="100%" stop-color="#46a302"/>
          </linearGradient>
          <linearGradient id="gradYellow" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#ffd940"/><stop offset="100%" stop-color="#e0a000"/>
          </linearGradient>
          <linearGradient id="gradRed" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#ff7070"/><stop offset="100%" stop-color="#cc1c1c"/>
          </linearGradient>
        </defs>
        <circle cx="105" cy="105" r="${r}" fill="none" stroke="#ede8df" stroke-width="16" stroke-linecap="round"/>
        ${pct > 0 ? `
          <circle cx="105" cy="105" r="${r}" fill="none" stroke="${color}"
                  stroke-width="16" stroke-linecap="round" stroke-dasharray="${C.toFixed(4)}"
                  stroke-dashoffset="${dashOffset.toFixed(4)}" transform="rotate(-90 105 105)" opacity="0.15"/>
          <circle class="ring-progress" cx="105" cy="105" r="${r}" fill="none" stroke="url(#${gradId})"
                  stroke-width="16" stroke-linecap="round" stroke-dasharray="${C.toFixed(4)}"
                  stroke-dashoffset="${dashOffset.toFixed(4)}" transform="rotate(-90 105 105)"/>
          <text x="105" y="21" text-anchor="middle" font-size="11" font-weight="800"
                font-family="Nunito" fill="${color}" opacity="0.85">${Math.round(pct * 100)}% used</text>
        ` : ''}
      </svg>
      <div style="position:absolute; inset:0; display:flex; flex-direction:column;
                  align-items:center; justify-content:center; gap:4px; pointer-events:none;">
        <span class="font-nums" style="font-size:2.1rem; line-height:1;
              color:${isOver ? '#ff4b4b' : '#2e2e2e'};">${formatPeso(Math.abs(remaining))}</span>
        <span class="font-display" style="font-size:13px; margin-top:4px; padding:3px 14px;
                     border-radius:9999px; color:${color}; background:${badgeBg};">${badge}</span>
      </div>
    </div>
    <div style="display:flex; gap:10px; margin-top:10px; width:100%; max-width:310px;">
      ${statPill('Spent', formatPeso(spent), '#ff4b4b', '#fff0f0')}
      ${statPill('Budget', formatPeso(total), '#1cb0f6', '#e8f6ff')}
      ${rollover > 0 ? statPill('Rollover', '+' + formatPeso(rollover), '#58cc02', '#e8ffe8') : ''}
    </div>`;

  const ring = container.querySelector('.ring-progress');
  if (ring) { ring.classList.remove('ring-animated'); void ring.offsetWidth; ring.classList.add('ring-animated'); }
}

function statPill(label, value, color, bg) {
  return `<div style="flex:1; border-radius:16px; padding:10px 12px; text-align:center;
                background:${bg}; border:1.5px solid ${color}22;">
      <div class="font-nums" style="font-size:14px; line-height:1.3; color:${color};">${value}</div>
      <div style="font-size:10px; font-weight:700; margin-top:2px; color:#7a7a7a;">${label}</div>
    </div>`;
}

/* ── Buffer Fund (rollover portion only) ── */
function renderBufferFund(buffer) {
  const el = document.getElementById('buffer-fund-container');
  if (!el) return;
  if (buffer <= 0) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="card-green-glow rounded-2xl p-4 relative overflow-hidden animate-fade-in">
      <div class="shimmer-bg" style="position:absolute; inset:0; pointer-events:none; border-radius:16px;"></div>
      <div style="position:relative; display:flex; align-items:center; justify-content:space-between;">
        <div style="display:flex; align-items:center; gap:12px;">
          <div class="animate-float" style="width:44px; height:44px; border-radius:16px; display:flex;
                 align-items:center; justify-content:center; font-size:24px;
                 background:rgba(88,204,2,0.15);">🐷</div>
          <div>
            <div class="font-display" style="font-size:15px; color:#2e2e2e;">Buffer Fund</div>
            <div style="font-size:11px; font-weight:700; color:#58cc02;">50% of your savings ✓</div>
          </div>
        </div>
        <div style="text-align:right;">
          <div class="font-nums" style="font-size:20px; color:#58cc02;">${formatPeso(buffer)}</div>
          <div style="font-size:10px; font-weight:700; color:#58cc02; opacity:0.7;">spendable</div>
        </div>
      </div>
    </div>`;
}

/* ── Emergency Vault (Tier 3 — locked savings) ── */
function renderEmergencyVault(vault) {
  const el = document.getElementById('emergency-vault-container');
  if (!el) return;
  if (vault <= 0) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="rounded-2xl p-4 relative overflow-hidden animate-fade-in"
         style="background:linear-gradient(145deg,#1a1040,#2d1b69,#3d2580);
                border:1px solid rgba(255,215,0,0.2); box-shadow:0 8px 32px rgba(45,27,105,0.4);">
      <div class="shimmer-bg" style="position:absolute; inset:0; pointer-events:none; border-radius:16px; opacity:0.3;"></div>
      <div style="position:relative; display:flex; align-items:center; justify-content:space-between;">
        <div style="display:flex; align-items:center; gap:12px;">
          <div style="width:44px; height:44px; border-radius:16px; display:flex;
                 align-items:center; justify-content:center; font-size:24px;
                 background:rgba(255,215,0,0.15);">🏦</div>
          <div>
            <div class="font-display" style="font-size:15px; color:#ffd700;">Emergency Vault</div>
            <div style="font-size:11px; font-weight:700; color:rgba(255,215,0,0.7);">Tier 3 • Locked & protected 🔒</div>
          </div>
        </div>
        <div style="text-align:right;">
          <div class="font-nums" style="font-size:20px; color:#ffd700;">${formatPeso(vault)}</div>
          <div style="font-size:10px; font-weight:700; color:rgba(255,215,0,0.6);">secured</div>
        </div>
      </div>
    </div>`;
}

/* ── Utang Status ── */
function renderUtangStatus() {
  const el = document.getElementById('utang-status-container');
  if (!el) return;
  const active = appState.utangLedger.filter(u => !u.isPaid);
  const paid = appState.utangLedger.filter(u => u.isPaid);
  if (active.length === 0 && paid.length === 0) { el.innerHTML = ''; return; }
  const totalOwed = active.reduce((s, u) => s + u.amount, 0);
  el.innerHTML = `
    <div class="rounded-2xl p-4 animate-fade-in"
         style="background:linear-gradient(135deg,#fff8f0,#fff0e0); border:2px solid #ffc80022;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="font-size:20px;">📝</span>
          <span class="font-display" style="font-size:15px; color:#2e2e2e;">Advances / Loans</span>
        </div>
        <span style="font-size:11px; font-weight:700; border-radius:9999px; padding:4px 12px;
               background:${active.length > 0 ? 'rgba(255,75,75,0.1)' : 'rgba(88,204,2,0.15)'};
               color:${active.length > 0 ? '#ff4b4b' : '#58cc02'}; border:1px solid ${active.length > 0 ? '#ff4b4b22' : '#58cc0222'};">
          ${active.length > 0 ? `${active.length} active` : '✓ All cleared!'}
        </span>
      </div>
      ${active.length > 0 ? `
        <div class="font-nums" style="font-size:20px; color:#ff4b4b; margin-bottom:4px;">${formatPeso(totalOwed)}</div>
        <div style="font-size:11px; font-weight:600; color:#7a7a7a;">Auto-deducts from your next income 🔄</div>
      ` : `<div style="font-size:12px; font-weight:600; color:#58cc02;">You cleared ${paid.length} loan${paid.length !== 1 ? 's' : ''}! 🎉</div>`}
    </div>`;
}

/* ── Health Debt Warning ── */
function renderHealthWarning(warning) {
  const el = document.getElementById('health-warning-container');
  if (!el) return;
  if (!warning) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="rounded-2xl p-4 animate-fade-in"
         style="background:linear-gradient(135deg,#fff5f0,#ffe8e0); border:2px solid #ff8c4222;">
      <div style="display:flex; align-items:center; gap:12px;">
        <div style="width:44px; height:44px; border-radius:16px; display:flex;
               align-items:center; justify-content:center; font-size:24px;
               background:rgba(255,140,66,0.12);">💪</div>
        <div>
          <div class="font-display" style="font-size:14px; color:#cc5500;">Nutrition Investment Alert</div>
          <div style="font-size:11px; font-weight:700; color:#7a7a7a; margin-top:2px;">
            Your last ${warning.meals} meals averaged <b>${warning.avgScore}/5</b> nutrition at
            <b>${formatPeso(warning.avgCost)}</b> each. Your body is your most expensive asset —
            cheap fuel now = costly repairs later. 🩺
          </div>
        </div>
      </div>
    </div>`;
}

/* ── Vault Status (Bills) ── */
function renderVaultStatus(bills, unpaidTotal, nextBillDays) {
  const el = document.getElementById('vault-status-container');
  if (!el) return;
  const paidCount = bills.filter(b => b.isPaid).length;
  const allPaid = bills.length > 0 && paidCount === bills.length;
  const badgeBg = allPaid ? 'rgba(88,204,2,0.2)' : 'rgba(255,255,255,0.1)';
  const badgeColor = allPaid ? '#58cc02' : '#7a7a7a';
  const badgeBdr = allPaid ? 'rgba(88,204,2,0.35)' : 'rgba(255,255,255,0.08)';
  const amtColor = unpaidTotal > 0 ? '#ff6b6b' : '#58cc02';
  el.innerHTML = `
    <div class="card-vault rounded-2xl p-5 animate-fade-in">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="font-size:20px;">${allPaid ? '🔓' : '🔒'}</span>
          <span class="font-display" style="font-size:15px; color:white;">Bills Vault</span>
        </div>
        <span style="font-size:11px; font-weight:700; border-radius:9999px; padding:4px 12px;
               background:${badgeBg}; color:${badgeColor}; border:1px solid ${badgeBdr};">
          ${paidCount}/${bills.length} paid
        </span>
      </div>
      <div class="font-nums" style="font-size:30px; color:${amtColor};">${formatPeso(unpaidTotal)}</div>
      <div style="font-size:12px; font-weight:600; margin-top:2px; margin-bottom:16px; color:#7a7a7a;">
        ${nextBillDays !== null ? `⏰ Next due in ${nextBillDays} day${nextBillDays !== 1 ? 's' : ''}` : '🎉 No upcoming bills'}
      </div>
      ${bills.length > 0 ? `<div style="display:flex; flex-direction:column; gap:8px;">
        ${bills.map(bill => {
    const pBg = bill.isPaid ? 'rgba(88,204,2,0.12)' : 'rgba(255,255,255,0.06)';
    const pBdr = bill.isPaid ? 'rgba(88,204,2,0.4)' : 'rgba(255,255,255,0.1)';
    const pClr = bill.isPaid ? '#58cc02' : '#e0e0e0';
    const dBg = bill.isPaid ? 'rgba(88,204,2,0.2)' : 'rgba(255,255,255,0.08)';
    const sk = bill.isPaid ? 'text-decoration:line-through; opacity:0.65;' : '';
    return `<button class="btn-squishy vault-bill-btn" data-bill-id="${bill.id}"
                  style="width:100%; display:flex; align-items:center; justify-content:space-between;
                         padding:12px 16px; min-height:52px; border-radius:12px; font-weight:600;
                         font-size:13px; text-align:left; cursor:pointer; background:${pBg};
                         border:1.5px solid ${pBdr}; color:${pClr};">
            <span style="display:flex; align-items:center; gap:10px;">
              <span style="width:24px; height:24px; border-radius:50%; display:flex;
                           align-items:center; justify-content:center; font-size:13px;
                           background:${dBg};">${bill.isPaid ? '✓' : '○'}</span>
              <span style="${sk}">${esc(bill.label)}</span>
            </span>
            <span style="display:flex; align-items:center; gap:10px;">
              <span class="font-nums" style="font-size:13px;">${formatPeso(bill.amount)}</span>
              <span style="font-size:10px; font-weight:700; border-radius:8px; padding:3px 8px;
                           background:rgba(255,255,255,0.08); color:#7a7a7a;">${formatDate(bill.dueDate)}</span>
            </span>
          </button>`;
  }).join('')}
      </div>` : ''}
    </div>`;
}


/* ════════════════════════════════════════════════════════════
   9. MODAL / FORM RENDERERS
   ════════════════════════════════════════════════════════════ */

let txSelectedCategory = '';
let txSelectedSatiety = 0;

function openQuickAdd() {
  document.getElementById('tx-amount').value = '';
  document.getElementById('tx-note').value = '';
  txSelectedCategory = appState.tier2Config.categories[0] || 'food';
  txSelectedSatiety = 0;
  hideEl('blocked-warning');
  renderCategoryBtns();
  renderSatietyBtns();
  updateNotePlaceholder();
  openModal('modal-quickadd');
  setTimeout(() => document.getElementById('tx-amount').focus(), 120);
}

function updateNotePlaceholder() {
  const noteEl = document.getElementById('tx-note');
  if (!noteEl) return;
  if (txSelectedCategory === 'food') {
    noteEl.placeholder = 'e.g. rice + egg \uD83C\uDF73';
  } else if (txSelectedCategory === 'transport') {
    noteEl.placeholder = 'e.g. Jeepney or LRT \uD83D\uDE8C';
  } else {
    noteEl.placeholder = 'e.g. describe your expense';
  }
}

function renderCategoryBtns() {
  const container = document.getElementById('category-btns');
  if (!container) return;
  container.innerHTML = appState.tier2Config.categories.map(cat => {
    const active = txSelectedCategory === cat;
    return `<button type="button" class="btn-squishy tx-cat-btn" data-cat="${cat}"
              style="flex:1; padding:12px 8px; font-size:14px; font-weight:700;
                     border-radius:16px; min-height:52px; text-transform:capitalize;
                     background:${active ? '#1cb0f6' : '#f7f4f0'};
                     color:${active ? '#ffffff' : '#7a7a7a'};
                     border:2px solid ${active ? '#1899d6' : '#ede8df'};
                     box-shadow:${active ? '0 4px 0 #1899d6' : 'none'};">
        ${CAT_ICONS[cat] || '📦'} ${cat}
      </button>`;
  }).join('');
}

function renderSatietyBtns() {
  const section = document.getElementById('nutrition-section');
  const container = document.getElementById('nutrition-btns');
  if (!section || !container) return;
  section.style.display = txSelectedCategory === 'food' ? 'block' : 'none';
  container.innerHTML = SATIETY_TAGS.map(tag => {
    const active = txSelectedSatiety === tag.value;
    return `<button type="button" class="btn-squishy tx-nut-btn" data-nut="${tag.value}"
              style="flex:1; padding:8px 4px; font-size:11px; font-weight:700;
                     border-radius:16px; min-height:52px; line-height:1.4;
                     background:${active ? '#ffc800' : '#f7f4f0'};
                     color:${active ? '#2e2e2e' : '#7a7a7a'};
                     border:2px solid ${active ? '#e0b000' : '#ede8df'};
                     box-shadow:${active ? '0 3px 0 #e0b000' : 'none'};">
        ${tag.emoji}<br>${tag.label}
      </button>`;
  }).join('');
}


/* ════════════════════════════════════════════════════════════
   10. EVENT LISTENERS
   ════════════════════════════════════════════════════════════ */

function setupEventListeners() {

  /* ── Welcome → Setup ── */
  document.getElementById('btn-get-started').addEventListener('click', () => {
    pendingSetupBills = [];
    showView('view-setup');
    showSetupStep(1);
    renderSetupBills();
  });

  /* ── Setup Step 1: funds + next date → step 2 ── */
  document.getElementById('step1-next').addEventListener('click', () => {
    const val = pesoToCentavos(document.getElementById('income-input').value);
    if (val <= 0) { shakeInput('income-input'); return; }
    const nextDate = document.getElementById('next-income-date').value;
    if (!nextDate) { shakeInput('next-income-date'); return; }
    showSetupStep(2);
    renderSetupBills();
  });
  document.getElementById('income-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('step1-next').click();
  });

  /* ── Setup Step 2: back/next/bills ── */
  document.getElementById('step2-back').addEventListener('click', () => showSetupStep(1));

  document.getElementById('add-bill-btn').addEventListener('click', () => {
    showEl('add-bill-form');
    document.getElementById('bill-label').focus();
    if (!document.getElementById('bill-due').value) document.getElementById('bill-due').value = todayISO();
  });

  document.getElementById('bill-cancel').addEventListener('click', () => { hideEl('add-bill-form'); clearBillForm(); });
  document.getElementById('bill-save').addEventListener('click', savePendingBill);
  document.getElementById('bill-due').addEventListener('keydown', e => { if (e.key === 'Enter') savePendingBill(); });

  document.getElementById('bills-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-remove-bill]');
    if (!btn) return;
    pendingSetupBills.splice(parseInt(btn.dataset.removeBill, 10), 1);
    renderSetupBills();
  });

  document.getElementById('step2-next').addEventListener('click', () => {
    hideEl('add-bill-form');
    showSetupStep(3);
    renderSetupSummary();
  });

  document.getElementById('step3-back').addEventListener('click', () => showSetupStep(2));

  /* ── Finish setup ── */
  document.getElementById('finish-setup').addEventListener('click', () => {
    const funds = pesoToCentavos(document.getElementById('income-input').value);
    const nextDate = document.getElementById('next-income-date').value || null;
    appState = {
      ...INITIAL_STATE,
      isSetupComplete: true,
      cashOnHand: funds,
      nextIncomeDate: nextDate,
      microIncomeLedger: [{ id: uid(), amount: funds, label: 'Initial funds', date: todayISO() }],
      tier1Bills: pendingSetupBills.map(b => ({ ...b })),
      tier2Config: { categories: ['food', 'transport'] },
      setupDate: todayISO(),
      lastProcessedDate: todayISO(),
    };
    saveState(appState);
    pendingSetupBills = [];
    showView('view-dashboard');
    renderDashboard();
  });

  /* ── FAB + Quick Add ── */
  document.getElementById('fab-add').addEventListener('click', openQuickAdd);
  document.getElementById('modal-close').addEventListener('click', () => closeModal('modal-quickadd'));
  document.getElementById('modal-quickadd').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-quickadd')) closeModal('modal-quickadd');
  });

  /* ── Category & Satiety buttons ── */
  document.getElementById('category-btns').addEventListener('click', e => {
    const btn = e.target.closest('.tx-cat-btn');
    if (!btn) return;
    txSelectedCategory = btn.dataset.cat;
    txSelectedSatiety = 0;
    renderCategoryBtns();
    renderSatietyBtns();
    updateNotePlaceholder();
  });

  document.getElementById('nutrition-btns').addEventListener('click', e => {
    const btn = e.target.closest('.tx-nut-btn');
    if (!btn) return;
    const val = parseInt(btn.dataset.nut, 10);
    txSelectedSatiety = txSelectedSatiety === val ? 0 : val;
    renderSatietyBtns();
  });

  /* ── Submit expense ── */
  document.getElementById('tx-submit').addEventListener('click', submitExpense);
  document.getElementById('tx-amount').addEventListener('keydown', e => { if (e.key === 'Enter') submitExpense(); });

  /* ── Vault bill toggle ── */
  document.getElementById('vault-status-container').addEventListener('click', e => {
    const btn = e.target.closest('.vault-bill-btn');
    if (!btn) return;
    const bill = appState.tier1Bills.find(b => b.id === btn.dataset.billId);
    const wasPaid = bill ? bill.isPaid : false;
    toggleBillPaid(btn.dataset.billId);
    if (!wasPaid) {
      SFX.play('chaching');
      haptic('heavy');
      launchConfetti();
    } else {
      haptic('light');
    }
    renderDashboard();
  });

  /* ── Settings ── */
  document.getElementById('settings-btn').addEventListener('click', () => openModal('modal-settings'));
  document.getElementById('settings-close').addEventListener('click', () => closeModal('modal-settings'));
  document.getElementById('modal-settings').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-settings')) closeModal('modal-settings');
  });
  document.getElementById('export-btn').addEventListener('click', () => {
    if (!AuthManager.isLoggedIn()) {
      AuthManager._pendingAction = 'export';
      closeModal('modal-settings');
      openAuthModal();
    } else {
      exportJSON();
      closeModal('modal-settings');
    }
  });
  document.getElementById('reset-app-btn').addEventListener('click', () => {
    if (!confirm('⚠️  This will permanently delete ALL your data. Are you sure?')) return;
    clearState(); closeModal('modal-settings'); showView('view-welcome');
  });

  /* ── Add Funds modal ── */
  document.getElementById('add-funds-btn').addEventListener('click', () => openModal('modal-addfunds'));
  document.getElementById('addfunds-close').addEventListener('click', () => closeModal('modal-addfunds'));
  document.getElementById('modal-addfunds').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-addfunds')) closeModal('modal-addfunds');
  });
  document.getElementById('addfunds-submit').addEventListener('click', submitAddFunds);

  /* ── Crisis / Utang modal ── */
  document.getElementById('crisis-close').addEventListener('click', () => closeModal('modal-crisis'));
  document.getElementById('modal-crisis').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-crisis')) closeModal('modal-crisis');
  });
  document.getElementById('utang-submit').addEventListener('click', submitUtang);

  /* ── Focus borders ── */
  addFocusBorder('income-input');
  addFocusBorder('next-income-date');
  addFocusBorder('bill-label');
  addFocusBorder('bill-amount');
  addFocusBorder('bill-due');
  addFocusBorder('tx-amount');
  addFocusBorder('tx-note');
  addFocusBorder('funds-amount');
  addFocusBorder('funds-label');
  addFocusBorder('utang-amount');
  addFocusBorder('utang-label');
}

/* ── Helpers ── */

function savePendingBill() {
  const label = document.getElementById('bill-label').value.trim();
  const amount = pesoToCentavos(document.getElementById('bill-amount').value);
  const due = document.getElementById('bill-due').value || todayISO();
  if (!label) { shakeInput('bill-label'); return; }
  if (amount <= 0) { shakeInput('bill-amount'); return; }
  pendingSetupBills.push({ id: uid(), label, amount, dueDate: due, isPaid: false });
  hideEl('add-bill-form');
  clearBillForm();
  renderSetupBills();
}

function clearBillForm() {
  document.getElementById('bill-label').value = '';
  document.getElementById('bill-amount').value = '';
  document.getElementById('bill-due').value = '';
}

function submitExpense() {
  const amount = pesoToCentavos(document.getElementById('tx-amount').value);
  if (amount <= 0) { shakeInput('tx-amount'); return; }
  const note = document.getElementById('tx-note').value.trim();
  const tx = {
    date: todayISO(), amount, tier: 2, category: txSelectedCategory,
    ...(txSelectedSatiety ? { satietyScore: txSelectedSatiety } : {}),
    ...(note ? { note } : {}),
  };
  const result = addTransaction(tx);
  if (result.blocked) {
    SFX.play('error');
    haptic('error');
    const warn = document.getElementById('blocked-warning');
    warn.style.display = 'block';
    warn.classList.remove('animate-shake'); void warn.offsetWidth; warn.classList.add('animate-shake');
    setTimeout(() => { warn.style.display = 'none'; }, 3000);
  } else {
    SFX.play('pop');
    haptic('light');
    closeModal('modal-quickadd');
    const fab = document.getElementById('fab-add');
    fab.classList.add('animate-pop'); setTimeout(() => fab.classList.remove('animate-pop'), 400);
    // Check if under budget → celebrate!
    const eng = computeEngine(appState);
    if (eng.todayState.spent <= eng.todayState.allowance * 0.5) {
      launchConfetti();
    }
    renderDashboard();
  }
}

function submitAddFunds() {
  const amount = pesoToCentavos(document.getElementById('funds-amount').value);
  if (amount <= 0) { shakeInput('funds-amount'); return; }
  const label = document.getElementById('funds-label').value.trim() || 'Funds added';
  const nextDate = document.getElementById('next-income-date-update').value;
  if (nextDate) appState.nextIncomeDate = nextDate;

  const result = addMicroIncome(amount, label);
  SFX.play('coin');
  haptic('medium');
  closeModal('modal-addfunds');
  document.getElementById('funds-amount').value = '';
  document.getElementById('funds-label').value = '';

  // Show feedback toast
  if (result.deducted > 0) {
    showToast(`💰 +${formatPeso(result.credited)} added • ${formatPeso(result.deducted)} auto-paid utang ✓`);
    launchConfetti();
  } else {
    showToast(`💰 +${formatPeso(result.credited)} added to your funds!`);
  }
  renderDashboard();
}

function submitUtang() {
  const amount = pesoToCentavos(document.getElementById('utang-amount').value);
  if (amount <= 0) { shakeInput('utang-amount'); return; }
  const label = document.getElementById('utang-label').value.trim() || 'Bridge loan';
  addUtang(amount, label);
  SFX.play('bridge');
  haptic('medium');
  closeModal('modal-crisis');
  document.getElementById('utang-amount').value = '';
  document.getElementById('utang-label').value = '';
  showToast(`🛡️ Bridge activated! ₱${(amount / 100).toFixed(0)} secured. Auto-pays on next income.`);
  renderDashboard();
}

/* ── Toast notification ── */
function showToast(msg) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.style.cssText = 'position:fixed; bottom:90px; left:50%; transform:translateX(-50%); z-index:999; ' +
      'background:linear-gradient(135deg,#2e2e2e,#1a1a2e); color:white; padding:12px 20px; border-radius:16px; ' +
      'font-size:13px; font-weight:700; box-shadow:0 8px 32px rgba(0,0,0,0.3); max-width:340px; text-align:center; ' +
      'opacity:0; transition:opacity 0.3s ease;';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}


/* ════════════════════════════════════════════════════════════
   11. SENSORY FEEDBACK ENGINE
   ── Sound · Confetti · Haptics (purely additive, no engine changes)
   ════════════════════════════════════════════════════════════ */

/** Web Audio synthesized sound effects — no external files needed */
const SFX = {
  ctx: null,
  _init() {
    if (this.ctx) return;
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { }
  },
  play(name) {
    this._init();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    try {
      switch (name) {
        case 'pop': {
          const o = this.ctx.createOscillator();
          const g = this.ctx.createGain();
          o.type = 'sine';
          o.frequency.setValueAtTime(600, t);
          o.frequency.exponentialRampToValueAtTime(1200, t + 0.08);
          o.frequency.exponentialRampToValueAtTime(800, t + 0.15);
          g.gain.setValueAtTime(0.15, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
          o.connect(g).connect(this.ctx.destination);
          o.start(t); o.stop(t + 0.2);
          break;
        }
        case 'chaching': {
          [0, 0.08, 0.16].forEach((d, i) => {
            const o = this.ctx.createOscillator();
            const g = this.ctx.createGain();
            o.type = 'triangle';
            o.frequency.setValueAtTime([1200, 1600, 2000][i], t + d);
            g.gain.setValueAtTime(0.12, t + d);
            g.gain.exponentialRampToValueAtTime(0.001, t + d + 0.15);
            o.connect(g).connect(this.ctx.destination);
            o.start(t + d); o.stop(t + d + 0.15);
          });
          break;
        }
        case 'error': {
          const o = this.ctx.createOscillator();
          const g = this.ctx.createGain();
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(150, t);
          o.frequency.linearRampToValueAtTime(80, t + 0.25);
          g.gain.setValueAtTime(0.08, t);
          g.gain.linearRampToValueAtTime(0, t + 0.3);
          o.connect(g).connect(this.ctx.destination);
          o.start(t); o.stop(t + 0.3);
          break;
        }
        case 'coin': {
          [0, 0.06].forEach((d, i) => {
            const o = this.ctx.createOscillator();
            const g = this.ctx.createGain();
            o.type = 'sine';
            o.frequency.setValueAtTime([1400, 1800][i], t + d);
            g.gain.setValueAtTime(0.1, t + d);
            g.gain.exponentialRampToValueAtTime(0.001, t + d + 0.12);
            o.connect(g).connect(this.ctx.destination);
            o.start(t + d); o.stop(t + d + 0.12);
          });
          break;
        }
        case 'bridge': {
          const o = this.ctx.createOscillator();
          const g = this.ctx.createGain();
          o.type = 'sine';
          o.frequency.setValueAtTime(300, t);
          o.frequency.linearRampToValueAtTime(500, t + 0.3);
          g.gain.setValueAtTime(0.1, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
          o.connect(g).connect(this.ctx.destination);
          o.start(t); o.stop(t + 0.35);
          break;
        }
      }
    } catch { }
  }
};

/** Haptic feedback — gracefully degrades on unsupported devices */
function haptic(intensity = 'light') {
  if (!navigator.vibrate) return;
  try {
    switch (intensity) {
      case 'light': navigator.vibrate(10); break;
      case 'medium': navigator.vibrate(25); break;
      case 'heavy': navigator.vibrate([15, 30, 15]); break;
      case 'error': navigator.vibrate([40, 20, 40]); break;
    }
  } catch { }
}

/** Canvas confetti particle system */
function launchConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  if (!canvas) return;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) return;

  const COLORS = ['#58cc02', '#ffc800', '#1cb0f6', '#ff4b4b', '#ff9600', '#ce82ff', '#78e820'];
  const particles = [];

  for (let i = 0; i < 80; i++) {
    particles.push({
      x: canvas.width / 2 + (Math.random() - 0.5) * 200,
      y: canvas.height * 0.4,
      vx: (Math.random() - 0.5) * 12,
      vy: -Math.random() * 14 - 4,
      w: Math.random() * 8 + 4,
      h: Math.random() * 6 + 2,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      rotation: Math.random() * 360,
      rotSpeed: (Math.random() - 0.5) * 12,
      gravity: 0.18 + Math.random() * 0.08,
      opacity: 1,
      decay: 0.008 + Math.random() * 0.008,
    });
  }

  let raf;
  function animate() {
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;

    for (const p of particles) {
      if (p.opacity <= 0) continue;
      alive = true;
      p.x += p.vx;
      p.vy += p.gravity;
      p.y += p.vy;
      p.vx *= 0.99;
      p.rotation += p.rotSpeed;
      p.opacity -= p.decay;

      ctx2d.save();
      ctx2d.translate(p.x, p.y);
      ctx2d.rotate((p.rotation * Math.PI) / 180);
      ctx2d.globalAlpha = Math.max(0, p.opacity);
      ctx2d.fillStyle = p.color;
      ctx2d.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx2d.restore();
    }

    if (alive) {
      raf = requestAnimationFrame(animate);
    } else {
      cancelAnimationFrame(raf);
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    }
  }
  animate();
}

/** Add haptic tap to all squishy buttons (generic global listener) */
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.btn-squishy')) {
    haptic('light');
  }
}, { passive: true });


/* ════════════════════════════════════════════════════════════
   11B. AUTHENTICATION MODULE — Progressive Disclosure
   ── AuthManager · OTP · OAuth · Captcha stubs · Nudge logic
   ════════════════════════════════════════════════════════════ */

const AUTH_STORAGE_KEY = 'pocket-auth-v1';

const AuthManager = {
  _state: null,
  _pendingAction: null,   // 'export' | 'sync' | null
  _otpTimer: null,
  _mockOTPCode: '123456', // demo code — replaced by real backend

  /* ── State management ── */
  _loadAuth() {
    if (this._state) return this._state;
    try {
      const raw = localStorage.getItem(AUTH_STORAGE_KEY);
      this._state = raw ? JSON.parse(raw) : { isLoggedIn: false, token: null, user: null, nudgeDismissed: false };
    } catch {
      this._state = { isLoggedIn: false, token: null, user: null, nudgeDismissed: false };
    }
    return this._state;
  },

  _saveAuth() {
    try { localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(this._state)); } catch { }
  },

  isLoggedIn() {
    return this._loadAuth().isLoggedIn === true;
  },

  getUser() {
    return this._loadAuth().user;
  },

  logout() {
    this._state = { isLoggedIn: false, token: null, user: null, nudgeDismissed: false };
    this._saveAuth();
  },

  /* ── Mock Backend Stubs (swap with Firebase/Supabase later) ── */

  /**
   * sendOTP(identifier) → Promise<{success, message}>
   * Mock: always succeeds. Real impl: calls your auth API.
   */
  sendOTP(identifier) {
    return new Promise(resolve => {
      setTimeout(() => {
        // Generate a mock OTP for demo
        this._mockOTPCode = String(Math.floor(100000 + Math.random() * 900000));
        console.log(`%c[Auth Mock] OTP code: ${this._mockOTPCode}`, 'color:#58cc02; font-weight:bold;');
        resolve({ success: true, message: `Code sent to ${identifier}` });
      }, 1200);
    });
  },

  /**
   * verifyOTP(code) → Promise<{success, token?, user?, message}>
   * Mock: checks against generated code. Real impl: validates with backend.
   */
  verifyOTP(code) {
    return new Promise(resolve => {
      setTimeout(() => {
        if (code === this._mockOTPCode) {
          const token = 'mock_token_' + Date.now();
          const user = {
            id: uid(),
            name: 'Pocket User',
            identifier: document.getElementById('auth-identifier')?.value || 'user@email.com',
            provider: 'otp',
            avatarEmoji: '👤',
          };
          this._state = { isLoggedIn: true, token, user, nudgeDismissed: true };
          this._saveAuth();
          resolve({ success: true, token, user });
        } else {
          resolve({ success: false, message: 'Invalid verification code' });
        }
      }, 800);
    });
  },

  /**
   * socialLogin(provider) → Promise<{success, token?, user?}>
   * Mock: simulates OAuth popup. Real impl: opens OAuth window.
   */
  socialLogin(provider) {
    return new Promise(resolve => {
      setTimeout(() => {
        const providerNames = { google: 'Google', apple: 'Apple', facebook: 'Facebook' };
        const token = `mock_${provider}_token_` + Date.now();
        const user = {
          id: uid(),
          name: `Pocket User`,
          identifier: `user@${provider}.com`,
          provider: provider,
          avatarEmoji: provider === 'google' ? '🔵' : provider === 'apple' ? '⚫' : '🔷',
        };
        this._state = { isLoggedIn: true, token, user, nudgeDismissed: true };
        this._saveAuth();
        console.log(`%c[Auth Mock] ${providerNames[provider]} login success`, 'color:#1cb0f6; font-weight:bold;');
        resolve({ success: true, token, user });
      }, 1500);
    });
  },

  /**
   * initCaptcha() — stub for reCAPTCHA v3 / Cloudflare Turnstile
   * Real impl: load captcha script and get invisible token before OTP/OAuth.
   */
  initCaptcha() {
    console.log('[Auth Mock] Captcha initialized (invisible — no user interaction needed)');
    return Promise.resolve({ token: 'captcha_mock_token' });
  },
};


/* ── Auth UI Controller ── */

let authCurrentStep = 1;

function openAuthModal() {
  authCurrentStep = 1;
  showAuthStep(1);
  document.getElementById('auth-identifier').value = '';
  clearOTPInputs();
  hideEl('otp-error');
  openModal('modal-auth');
  setTimeout(() => document.getElementById('auth-identifier')?.focus(), 200);
}

function showAuthStep(step) {
  authCurrentStep = step;
  [1, 2, 3].forEach(s => {
    const el = document.getElementById(`auth-step-${s}`);
    if (el) el.style.display = s === step ? 'block' : 'none';
  });
  document.querySelectorAll('.auth-step-dot').forEach((dot, i) => {
    const s = i + 1;
    dot.classList.toggle('active', s === step);
    dot.classList.toggle('done', s < step);
  });
}

function clearOTPInputs() {
  document.querySelectorAll('.auth-otp-digit').forEach(inp => {
    inp.value = '';
    inp.classList.remove('filled', 'error');
  });
}

function getOTPCode() {
  return Array.from(document.querySelectorAll('.auth-otp-digit')).map(i => i.value).join('');
}

function startOTPCountdown() {
  let secs = 60;
  const timerEl = document.getElementById('otp-timer');
  const countEl = document.getElementById('otp-countdown');
  const resendEl = document.getElementById('otp-resend');
  if (timerEl) timerEl.style.display = 'block';
  if (resendEl) resendEl.style.display = 'none';
  if (countEl) countEl.textContent = secs;

  if (AuthManager._otpTimer) clearInterval(AuthManager._otpTimer);

  AuthManager._otpTimer = setInterval(() => {
    secs--;
    if (countEl) countEl.textContent = secs;
    if (secs <= 0) {
      clearInterval(AuthManager._otpTimer);
      AuthManager._otpTimer = null;
      if (timerEl) timerEl.style.display = 'none';
      if (resendEl) resendEl.style.display = 'inline-block';
    }
  }, 1000);
}

async function handleSendOTP() {
  const identifier = document.getElementById('auth-identifier')?.value.trim();
  if (!identifier) {
    shakeInput('auth-identifier');
    return;
  }

  const btn = document.getElementById('auth-send-otp');
  const originalText = btn.innerHTML;
  btn.innerHTML = '<span class="auth-spinner"></span> Sending...';
  btn.disabled = true;

  try {
    await AuthManager.initCaptcha();
    const result = await AuthManager.sendOTP(identifier);

    if (result.success) {
      SFX.play('coin');
      haptic('medium');
      document.getElementById('auth-sent-to').textContent = identifier;
      showAuthStep(2);
      startOTPCountdown();
      clearOTPInputs();
      setTimeout(() => document.querySelector('.auth-otp-digit')?.focus(), 200);
    }
  } catch (err) {
    showToast('❌ Failed to send code. Please try again.');
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

async function handleVerifyOTP() {
  const code = getOTPCode();
  if (code.length < 6) {
    document.querySelectorAll('.auth-otp-digit').forEach(inp => {
      if (!inp.value) inp.classList.add('error');
    });
    SFX.play('error');
    haptic('error');
    return;
  }

  const btn = document.getElementById('auth-verify-otp');
  const originalText = btn.innerHTML;
  btn.innerHTML = '<span class="auth-spinner"></span> Verifying...';
  btn.disabled = true;

  try {
    const result = await AuthManager.verifyOTP(code);

    if (result.success) {
      SFX.play('chaching');
      haptic('heavy');
      launchConfetti();
      hideEl('otp-error');

      // Update success screen
      document.getElementById('auth-display-name').textContent = result.user.name;
      document.getElementById('auth-display-id').textContent = result.user.identifier;

      showAuthStep(3);

      // Clear the nudge
      hideEl('auth-nudge-banner');

      if (AuthManager._otpTimer) { clearInterval(AuthManager._otpTimer); AuthManager._otpTimer = null; }
    } else {
      showEl('otp-error');
      document.querySelectorAll('.auth-otp-digit').forEach(inp => inp.classList.add('error'));
      SFX.play('error');
      haptic('error');
      setTimeout(() => {
        document.querySelectorAll('.auth-otp-digit').forEach(inp => inp.classList.remove('error'));
        hideEl('otp-error');
      }, 2500);
    }
  } catch {
    showToast('❌ Verification failed. Try again.');
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

async function handleSocialAuth(provider) {
  const btn = document.querySelector(`[data-provider="${provider}"]`);
  if (!btn) return;

  const originalText = btn.innerHTML;
  btn.innerHTML = '<span class="auth-spinner"></span> Connecting...';
  btn.disabled = true;

  try {
    await AuthManager.initCaptcha();
    const result = await AuthManager.socialLogin(provider);

    if (result.success) {
      SFX.play('chaching');
      haptic('heavy');
      launchConfetti();

      document.getElementById('auth-display-name').textContent = result.user.name;
      document.getElementById('auth-display-id').textContent = result.user.identifier;

      showAuthStep(3);
      hideEl('auth-nudge-banner');
    }
  } catch {
    showToast('❌ Connection failed. Please try again.');
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}


/* ── Progressive Disclosure Logic ── */

function checkAuthNudge() {
  const auth = AuthManager._loadAuth();
  if (auth.isLoggedIn || auth.nudgeDismissed) return;
  if (!appState.setupDate) return;

  const setupMs = new Date(appState.setupDate + 'T00:00:00').getTime();
  const now = Date.now();
  const daysSinceSetup = (now - setupMs) / 86400000;

  if (daysSinceSetup >= 3) {
    showEl('auth-nudge-banner');
  }
}

function dismissNudge() {
  hideEl('auth-nudge-banner');
  const auth = AuthManager._loadAuth();
  auth.nudgeDismissed = true;
  AuthManager._saveAuth();
}


/* ── Auth Event Listeners ── */

function authEventListeners() {
  // Modal close
  document.getElementById('auth-close')?.addEventListener('click', () => {
    closeModal('modal-auth');
    if (AuthManager._otpTimer) { clearInterval(AuthManager._otpTimer); AuthManager._otpTimer = null; }
  });
  document.getElementById('modal-auth')?.addEventListener('click', e => {
    if (e.target === document.getElementById('modal-auth')) {
      closeModal('modal-auth');
      if (AuthManager._otpTimer) { clearInterval(AuthManager._otpTimer); AuthManager._otpTimer = null; }
    }
  });

  // Cloud Sync button in Settings
  document.getElementById('cloud-sync-btn')?.addEventListener('click', () => {
    closeModal('modal-settings');
    if (AuthManager.isLoggedIn()) {
      showToast('☁️ Already synced! Your data is backed up.');
    } else {
      AuthManager._pendingAction = 'sync';
      openAuthModal();
    }
  });

  // Nudge banner
  document.getElementById('nudge-dismiss')?.addEventListener('click', dismissNudge);
  document.getElementById('nudge-signin-btn')?.addEventListener('click', () => {
    hideEl('auth-nudge-banner');
    openAuthModal();
  });

  // Social OAuth
  document.querySelectorAll('.auth-social-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const provider = btn.dataset.provider;
      if (provider) handleSocialAuth(provider);
    });
  });

  // OTP send
  document.getElementById('auth-send-otp')?.addEventListener('click', handleSendOTP);
  document.getElementById('auth-identifier')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleSendOTP();
  });

  // OTP digit inputs — auto-advance, paste support, backspace
  document.querySelectorAll('.auth-otp-digit').forEach((inp, idx, all) => {
    inp.addEventListener('input', e => {
      const val = e.target.value.replace(/[^0-9]/g, '');
      e.target.value = val.slice(0, 1);

      if (val) {
        e.target.classList.add('filled');
        e.target.classList.remove('error');
        SFX.play('pop');
        // Auto-advance
        if (idx < all.length - 1) all[idx + 1].focus();
        // Auto-submit if all filled
        if (getOTPCode().length === 6) {
          setTimeout(() => handleVerifyOTP(), 200);
        }
      } else {
        e.target.classList.remove('filled');
      }
    });

    inp.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !e.target.value && idx > 0) {
        all[idx - 1].focus();
        all[idx - 1].value = '';
        all[idx - 1].classList.remove('filled');
      }
    });

    // Paste support — distribute digits across all boxes
    inp.addEventListener('paste', e => {
      e.preventDefault();
      const paste = (e.clipboardData?.getData('text') || '').replace(/[^0-9]/g, '').slice(0, 6);
      paste.split('').forEach((d, i) => {
        if (all[i]) {
          all[i].value = d;
          all[i].classList.add('filled');
        }
      });
      if (paste.length === 6) {
        all[5].focus();
        setTimeout(() => handleVerifyOTP(), 300);
      } else if (paste.length > 0) {
        (all[paste.length] || all[paste.length - 1]).focus();
      }
    });
  });

  // OTP verify & resend
  document.getElementById('auth-verify-otp')?.addEventListener('click', handleVerifyOTP);
  document.getElementById('otp-resend')?.addEventListener('click', () => {
    const identifier = document.getElementById('auth-sent-to')?.textContent;
    if (identifier) {
      AuthManager.sendOTP(identifier).then(() => {
        startOTPCountdown();
        clearOTPInputs();
        showToast('🔑 New code sent!');
        document.querySelector('.auth-otp-digit')?.focus();
      });
    }
  });

  // Back to step 1
  document.getElementById('auth-back-to-step1')?.addEventListener('click', () => {
    showAuthStep(1);
    if (AuthManager._otpTimer) { clearInterval(AuthManager._otpTimer); AuthManager._otpTimer = null; }
  });

  // Done — close auth and run pending action
  document.getElementById('auth-done')?.addEventListener('click', () => {
    closeModal('modal-auth');

    // Execute pending action if any
    if (AuthManager._pendingAction === 'export') {
      exportJSON();
      showToast('📤 Data exported successfully!');
    } else if (AuthManager._pendingAction === 'sync') {
      showToast('☁️ Cloud sync activated! Your data is safe.');
    }
    AuthManager._pendingAction = null;
  });

  // Focus borders for auth inputs
  addFocusBorder('auth-identifier');
}


/* ════════════════════════════════════════════════════════════
   12. BOOT
   ════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  appState = loadState();
  setupEventListeners();
  authEventListeners();

  // Prime the AudioContext on first user interaction (browser autoplay policy)
  const primeAudio = () => {
    SFX._init();
    if (SFX.ctx && SFX.ctx.state === 'suspended') SFX.ctx.resume();
    document.removeEventListener('pointerdown', primeAudio);
  };
  document.addEventListener('pointerdown', primeAudio, { once: true });

  setTimeout(() => {
    if (!appState.isSetupComplete) {
      showView('view-welcome');
    } else {
      showView('view-dashboard');
      renderDashboard();
      // Progressive disclosure: check if 3-day nudge should show
      checkAuthNudge();
    }
  }, 450);
});