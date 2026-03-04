/* ============================================================
   POCKET APP — script.js
   ₱50/day rollover budget tracker  |  Vanilla JS
   ============================================================

   STRUCTURE
   ─────────
   1.  Constants & initial state
   2.  Storage helpers
   3.  Formatting utilities
   4.  Budget Engine  ← all maths live here, untouched
   5.  Transaction & bill helpers
   6.  View / modal helpers
   7.  Setup renderers
   8.  Dashboard renderers
   9.  Modal form renderers
   10. Event listeners
   11. Boot (DOMContentLoaded)

   ============================================================ */


/* ════════════════════════════════════════════════════════════
   1. CONSTANTS & INITIAL STATE
   ════════════════════════════════════════════════════════════ */

const STORAGE_KEY  = 'pocket-app-v1';
const DAYS_IN_MON  = 30;

/** Shape that mirrors the original TypeScript AppState */
const INITIAL_STATE = {
  isSetupComplete : false,
  monthlyIncome   : 0,          // centavos
  tier1Bills      : [],         // [{ id, label, amount(¢), dueDate(ISO), isPaid }]
  tier2Config     : { categories: ['food', 'transport'] },
  transactions    : [],         // [{ id, date(ISO), amount(¢), tier, category, nutritionTag?, note? }]
  setupDate       : null,       // ISO string — first day of tracking
};

const NUTRITION_TAGS = [
  { value: 'high-low', label: 'Great Deal', emoji: '🔥' },
  { value: 'mid-mid',  label: 'Fair',       emoji: '👌' },
  { value: 'low-high', label: 'Pricey',     emoji: '💸' },
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
    // Merge so new keys added to INITIAL_STATE always exist
    return { ...INITIAL_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...INITIAL_STATE };
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* silent — storage full or private mode */ }
}

function clearState() {
  localStorage.removeItem(STORAGE_KEY);
  appState = { ...INITIAL_STATE };
}

function exportJSON() {
  const blob = new Blob([JSON.stringify(appState, null, 2)], { type: 'application/json' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `pocket-app-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}


/* ════════════════════════════════════════════════════════════
   3. FORMATTING UTILITIES
   ════════════════════════════════════════════════════════════ */

/** centavos → "₱120.50" */
function formatPeso(centavos) {
  return '₱' + (centavos / 100).toFixed(2);
}

/** peso string (user input) → centavos integer */
function pesoToCentavos(str) {
  const n = parseFloat(String(str).replace(/[^0-9.]/g, ''));
  if (!n || n <= 0 || isNaN(n)) return 0;
  return Math.round(n * 100);
}

/** Returns "YYYY-MM-DD" in LOCAL time — avoids UTC off-by-one */
function todayISO() {
  const d = new Date();
  return localISO(d);
}

function localISO(date) {
  const y  = date.getFullYear();
  const m  = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** "YYYY-MM-DD" → "Jan 5" */
function formatDate(isoStr) {
  if (!isoStr) return '';
  const [y, m, d] = isoStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-PH', {
    month: 'short',
    day  : 'numeric',
  });
}

/** tiny unique id */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Escape HTML to prevent XSS when rendering user strings */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


/* ════════════════════════════════════════════════════════════
   4. BUDGET ENGINE
   ── All ₱50/day rollover & vault maths live here.
   ── This section is a direct port of useBudgetEngine.
   ════════════════════════════════════════════════════════════ */

/**
 * computeEngine(state) → {
 *   dailyAllowance, isDeficit,
 *   todayState: { allowance, spent, rollover },
 *   unpaidBillsTotal, nextBillDays, buffer
 * }
 *
 * NOTE: all money values are in centavos (float or int).
 */
function computeEngine(state) {
  const today = todayISO();

  /* ── Monthly / daily allowance ── */
  const billsTotal     = state.tier1Bills.reduce((s, b) => s + b.amount, 0);
  const monthlyNet     = state.monthlyIncome - billsTotal;
  const dailyAllowance = monthlyNet / DAYS_IN_MON;   // can be negative (deficit)
  const isDeficit      = dailyAllowance <= 0;

  /* ── Today's tier-2 spending ── */
  const todaySpent = state.transactions
    .filter(t => t.date === today && t.tier === 2)
    .reduce((s, t) => s + t.amount, 0);

  /* ── Buffer: accumulated unspent from all past days since setup ──
     Walk every day from setupDate (exclusive) up to (not including) today.
     Each day's leftover (allowance − spent) adds to the buffer.
     Days where you overspent do NOT reduce the buffer — past debts
     are already reflected in the lower remaining balance. */
  let buffer = 0;
  if (!isDeficit && state.setupDate && state.setupDate < today) {
    const start = new Date(state.setupDate + 'T00:00:00'); // local midnight
    const end   = new Date(today         + 'T00:00:00');

    for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
      const ds       = localISO(d);
      const daySpent = state.transactions
        .filter(t => t.date === ds && t.tier === 2)
        .reduce((s, t) => s + t.amount, 0);
      const remainder = dailyAllowance - daySpent;
      if (remainder > 0) buffer += remainder;
    }
  }

  /* todayState mirrors the shape expected by DailyBudgetRing */
  const todayState = {
    allowance : Math.max(0, dailyAllowance), // never negative for ring display
    spent     : todaySpent,
    rollover  : buffer,
  };

  /* ── Vault: unpaid bills ── */
  const unpaidBills     = state.tier1Bills.filter(b => !b.isPaid);
  const unpaidBillsTotal = unpaidBills.reduce((s, b) => s + b.amount, 0);

  /* ── Next bill due (days from today) ── */
  let nextBillDays = null;
  const todayMs   = new Date(today + 'T00:00:00').getTime();

  for (const bill of unpaidBills) {
    if (!bill.dueDate) continue;
    const daysUntil = Math.ceil(
      (new Date(bill.dueDate + 'T00:00:00').getTime() - todayMs) / 86400000
    );
    if (daysUntil >= 0 && (nextBillDays === null || daysUntil < nextBillDays)) {
      nextBillDays = daysUntil;
    }
  }

  return { dailyAllowance, isDeficit, todayState, unpaidBillsTotal, nextBillDays, buffer };
}


/* ════════════════════════════════════════════════════════════
   5. TRANSACTION & BILL HELPERS
   ════════════════════════════════════════════════════════════ */

/**
 * addTransaction(tx) → { blocked: boolean }
 * Mirrors the hook's addTransaction — blocks if projected spend
 * would exceed today's full pool (daily allowance + buffer).
 */
function addTransaction(tx) {
  const engine    = computeEngine(appState);
  const pool      = engine.todayState.allowance + engine.buffer;
  const projected = engine.todayState.spent + tx.amount;

  if (projected > pool) return { blocked: true };

  appState.transactions.push({ ...tx, id: uid() });
  saveState(appState);
  return { blocked: false };
}

/** Toggle a Tier-1 bill's isPaid flag */
function toggleBillPaid(id) {
  const bill = appState.tier1Bills.find(b => b.id === id);
  if (bill) {
    bill.isPaid = !bill.isPaid;
    saveState(appState);
  }
}


/* ════════════════════════════════════════════════════════════
   6. VIEW / MODAL HELPERS
   ════════════════════════════════════════════════════════════ */

const VIEWS = ['view-loading', 'view-welcome', 'view-setup', 'view-dashboard'];

/**
 * showView(id, displayType?)
 * Hides all views, then shows the requested one.
 * displayType defaults differ: loading/welcome are flex, others are block.
 */
function showView(id, displayType) {
  VIEWS.forEach(v => {
    const el = document.getElementById(v);
    if (el) el.style.display = 'none';
  });
  const target = document.getElementById(id);
  if (!target) return;
  target.style.display = displayType
    || (id === 'view-loading' || id === 'view-welcome' ? 'flex' : 'block');
}

function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'flex';
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

function showEl(id, type = 'block') {
  const el = document.getElementById(id);
  if (el) el.style.display = type;
}

function hideEl(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

/** Shake + red-border feedback for bad inputs */
function shakeInput(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('animate-shake');
  void el.offsetWidth; // reflow
  el.classList.add('animate-shake');
  el.style.borderColor = '#ff4b4b';
  setTimeout(() => {
    el.classList.remove('animate-shake');
    el.style.borderColor = '#ede8df';
  }, 650);
}

/** Wire focus/blur border colour to a text input */
function addFocusBorder(id, focusColor = '#1cb0f6', blurColor = '#ede8df') {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('focus', () => el.style.borderColor = focusColor);
  el.addEventListener('blur',  () => el.style.borderColor = blurColor);
}


/* ════════════════════════════════════════════════════════════
   7. SETUP RENDERERS
   ════════════════════════════════════════════════════════════ */

/** In-memory staging area for bills during setup */
let pendingSetupBills = [];
let currentSetupStep  = 1;

function showSetupStep(step) {
  currentSetupStep = step;
  [1, 2, 3].forEach(s => {
    const el = document.getElementById(`setup-step-${s}`);
    if (el) el.style.display = s === step ? 'block' : 'none';
  });
  // Update progress dots
  document.querySelectorAll('.setup-step-dot').forEach((dot, i) => {
    const s = i + 1;
    dot.classList.toggle('active', s === step);
    dot.classList.toggle('done',   s < step);
  });
}

function renderSetupBills() {
  const list = document.getElementById('bills-list');
  if (!list) return;

  if (pendingSetupBills.length === 0) {
    list.innerHTML = `<p class="text-center text-sm py-3" style="color:#9a9a9a">No bills added yet — tap below to add one</p>`;
    return;
  }

  list.innerHTML = pendingSetupBills.map((b, i) => `
    <div class="flex items-center justify-between rounded-xl px-4 py-3 animate-fade-in"
         style="background:#f7f4f0; border:2px solid #ede8df;">
      <div>
        <div class="text-sm font-bold" style="color:#2e2e2e">${esc(b.label)}</div>
        <div style="font-size:11px; font-weight:600; color:#9a9a9a">${formatDate(b.dueDate)}</div>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span class="font-nums text-sm" style="color:#ff4b4b;">${formatPeso(b.amount)}</span>
        <button class="btn-squishy w-8 h-8 rounded-full flex items-center justify-center text-sm"
                style="background:#fff0f0; color:#ff4b4b;"
                data-remove-bill="${i}" aria-label="Remove bill">✕</button>
      </div>
    </div>
  `).join('');
}

function renderSetupSummary() {
  const income     = pesoToCentavos(document.getElementById('income-input').value);
  const billsTotal = pendingSetupBills.reduce((s, b) => s + b.amount, 0);
  const net        = income - billsTotal;
  const daily      = net / DAYS_IN_MON;
  const isDeficit  = daily <= 0;

  const el = document.getElementById('setup-summary');
  if (!el) return;

  el.innerHTML = `
    <div class="space-y-3">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span class="text-sm font-bold" style="color:#9a9a9a;">Monthly Income</span>
        <span class="font-nums text-sm" style="color:#1cb0f6;">${formatPeso(income)}</span>
      </div>
      ${pendingSetupBills.length > 0 ? `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span class="text-sm font-bold" style="color:#9a9a9a;">Total Bills</span>
        <span class="font-nums text-sm" style="color:#ff4b4b;">−${formatPeso(billsTotal)}</span>
      </div>` : ''}
      <div style="height:1px; background:#ede8df;"></div>
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span class="font-bold" style="font-size:13px; color:#9a9a9a;">Daily Budget</span>
        <span class="font-nums" style="font-size:22px; font-weight:900; color:${isDeficit ? '#ff4b4b' : '#58cc02'};">
          ${isDeficit ? '😟 Deficit!' : formatPeso(Math.max(0, daily))}
        </span>
      </div>
      <div class="text-xs font-semibold text-center" style="color:#9a9a9a;">
        ${pendingSetupBills.length} bill${pendingSetupBills.length !== 1 ? 's' : ''} tracked in vault •
        ${isDeficit
          ? 'Reduce bills or increase income'
          : `${formatPeso(Math.max(0, daily))}/day after bills`}
      </div>
    </div>
  `;
}


/* ════════════════════════════════════════════════════════════
   8. DASHBOARD RENDERERS
   ════════════════════════════════════════════════════════════ */

/** Master render — calls each sub-renderer */
function renderDashboard() {
  const engine = computeEngine(appState);
  renderDeficitAlert(engine.isDeficit, engine.dailyAllowance);
  renderBudgetRing(engine.todayState);
  renderBufferFund(engine.buffer);
  renderVaultStatus(appState.tier1Bills, engine.unpaidBillsTotal, engine.nextBillDays);
}

/* ── DeficitAlert ────────────────────────────────────────── */
function renderDeficitAlert(isDeficit, dailyAllowance) {
  const el = document.getElementById('deficit-alert');
  if (!el) return;

  if (!isDeficit) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = `
    <div class="rounded-2xl p-4 relative overflow-hidden animate-shake"
         style="background:linear-gradient(135deg,#fff0f0,#ffe4e4);
                border:2px solid #ff4b4b;
                box-shadow:0 6px 20px rgba(255,75,75,0.2);">
      <!-- Decorative circle -->
      <div style="position:absolute; top:-24px; right:-24px; width:80px; height:80px;
                  border-radius:50%; background:#ff4b4b; opacity:0.1;"></div>
      <div style="position:relative; display:flex; align-items:center; gap:12px;">
        <div class="flex-shrink-0 w-12 h-12 rounded-2xl flex items-center justify-center text-2xl"
             style="background:rgba(255,75,75,0.12);">😟</div>
        <div>
          <div class="font-display" style="font-size:14px; color:#cc1c1c;">Deficit Mode Active</div>
          <div class="font-nums" style="font-size:20px; color:#ff4b4b;">${formatPeso(dailyAllowance)}/day</div>
          <div style="font-size:11px; font-weight:700; color:#9a9a9a; margin-top:2px;">
            Bills exceed income — reduce bills or add income
          </div>
        </div>
      </div>
    </div>`;
}

/* ── DailyBudgetRing ─────────────────────────────────────── */
function renderBudgetRing({ allowance, spent, rollover }) {
  const total     = allowance + rollover;
  const remaining = total - spent;
  const pct       = total > 0 ? Math.min(spent / total, 1) : 0;
  const isOver    = remaining < 0;
  const isWarn    = !isOver && pct > 0.8;

  const r = 74;
  const C = 2 * Math.PI * r; // ≈ 464.96 — full circumference
  const dashOffset = C * (1 - pct);

  const color   = isOver ? '#ff4b4b' : isWarn ? '#ffc800' : '#58cc02';
  const gradId  = isOver ? 'gradRed'  : isWarn ? 'gradYellow' : 'gradGreen';
  const badgeBg = isOver ? '#fff0f0'  : isWarn ? '#fff8e0'    : '#e8ffe8';
  const badge   = isOver ? '😰 over budget' : isWarn ? '⚠️ almost gone' : '✨ left today';

  const container = document.getElementById('budget-ring-container');
  if (!container) return;

  container.innerHTML = `
    <div style="position:relative; filter:drop-shadow(0 8px 24px ${color}44);">
      <svg width="210" height="210" viewBox="0 0 210 210" aria-hidden="true">
        <defs>
          <linearGradient id="gradGreen" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%"   stop-color="#78e820"/>
            <stop offset="100%" stop-color="#46a302"/>
          </linearGradient>
          <linearGradient id="gradYellow" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%"   stop-color="#ffd940"/>
            <stop offset="100%" stop-color="#e0a000"/>
          </linearGradient>
          <linearGradient id="gradRed" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%"   stop-color="#ff7070"/>
            <stop offset="100%" stop-color="#cc1c1c"/>
          </linearGradient>
        </defs>

        <!-- Track (background ring) -->
        <circle cx="105" cy="105" r="${r}" fill="none" stroke="#ede8df"
                stroke-width="16" stroke-linecap="round"/>

        ${pct > 0 ? `
          <!-- Soft glow layer -->
          <circle cx="105" cy="105" r="${r}" fill="none" stroke="${color}"
                  stroke-width="16" stroke-linecap="round"
                  stroke-dasharray="${C.toFixed(4)}"
                  stroke-dashoffset="${dashOffset.toFixed(4)}"
                  transform="rotate(-90 105 105)" opacity="0.15"/>

          <!-- Main progress arc — animated by .ring-animated class -->
          <circle class="ring-progress" cx="105" cy="105" r="${r}"
                  fill="none" stroke="url(#${gradId})"
                  stroke-width="16" stroke-linecap="round"
                  stroke-dasharray="${C.toFixed(4)}"
                  stroke-dashoffset="${dashOffset.toFixed(4)}"
                  transform="rotate(-90 105 105)"/>

          <!-- Percentage label above ring -->
          <text x="105" y="21" text-anchor="middle"
                font-size="11" font-weight="800" font-family="Nunito"
                fill="${color}" opacity="0.85">
            ${Math.round(pct * 100)}% used
          </text>
        ` : ''}
      </svg>

      <!-- Center text (absolutely positioned over SVG) -->
      <div style="position:absolute; inset:0; display:flex; flex-direction:column;
                  align-items:center; justify-content:center; gap:4px; pointer-events:none;">
        <span class="font-nums" style="font-size:2.1rem; line-height:1;
              color:${isOver ? '#ff4b4b' : '#2e2e2e'};">
          ${formatPeso(Math.abs(remaining))}
        </span>
        <span class="font-display"
              style="font-size:13px; margin-top:4px; padding:3px 14px;
                     border-radius:9999px; color:${color}; background:${badgeBg};">
          ${badge}
        </span>
      </div>
    </div>

    <!-- Stat pills row -->
    <div style="display:flex; gap:10px; margin-top:10px; width:100%; max-width:310px;">
      ${statPill('Spent',  formatPeso(spent),   '#ff4b4b', '#fff0f0')}
      ${statPill('Budget', formatPeso(total),   '#1cb0f6', '#e8f6ff')}
      ${rollover > 0 ? statPill('Rollover', '+' + formatPeso(rollover), '#58cc02', '#e8ffe8') : ''}
    </div>`;

  // Trigger the ring-draw entrance animation (reflow trick)
  const ring = container.querySelector('.ring-progress');
  if (ring) {
    ring.classList.remove('ring-animated');
    void ring.offsetWidth; // force reflow → restart animation
    ring.classList.add('ring-animated');
  }
}

/** Helper: small coloured stat pill */
function statPill(label, value, color, bg) {
  return `
    <div style="flex:1; border-radius:16px; padding:10px 12px; text-align:center;
                background:${bg}; border:1.5px solid ${color}22;">
      <div class="font-nums" style="font-size:14px; line-height:1.3; color:${color};">${value}</div>
      <div style="font-size:10px; font-weight:700; margin-top:2px; color:#9a9a9a;">${label}</div>
    </div>`;
}

/* ── BufferFund ──────────────────────────────────────────── */
function renderBufferFund(buffer) {
  const el = document.getElementById('buffer-fund-container');
  if (!el) return;

  if (buffer <= 0) { el.innerHTML = ''; return; }

  el.innerHTML = `
    <div class="card-green-glow rounded-2xl p-4 relative overflow-hidden animate-fade-in">
      <!-- Shimmer sweep overlay -->
      <div class="shimmer-bg" style="position:absolute; inset:0; pointer-events:none; border-radius:16px;"></div>

      <div style="position:relative; display:flex; align-items:center; justify-content:space-between;">
        <div style="display:flex; align-items:center; gap:12px;">
          <div class="animate-float"
               style="width:44px; height:44px; border-radius:16px; display:flex;
                      align-items:center; justify-content:center; font-size:24px;
                      background:rgba(88,204,2,0.15);">🐷</div>
          <div>
            <div class="font-display" style="font-size:15px; color:#2e2e2e;">Buffer Fund</div>
            <div style="font-size:11px; font-weight:700; color:#58cc02;">Saved from past days ✓</div>
          </div>
        </div>
        <div style="text-align:right;">
          <div class="font-nums" style="font-size:20px; color:#58cc02;">${formatPeso(buffer)}</div>
          <div style="font-size:10px; font-weight:700; color:#58cc02; opacity:0.7;">available</div>
        </div>
      </div>
    </div>`;
}

/* ── VaultStatus ─────────────────────────────────────────── */
function renderVaultStatus(bills, unpaidTotal, nextBillDays) {
  const el = document.getElementById('vault-status-container');
  if (!el) return;

  const paidCount = bills.filter(b => b.isPaid).length;
  const allPaid   = bills.length > 0 && paidCount === bills.length;

  const badgeBg    = allPaid ? 'rgba(88,204,2,0.2)'        : 'rgba(255,255,255,0.1)';
  const badgeColor = allPaid ? '#58cc02'                    : '#9a9a9a';
  const badgeBdr   = allPaid ? 'rgba(88,204,2,0.35)'        : 'rgba(255,255,255,0.08)';
  const amtColor   = unpaidTotal > 0 ? '#ff6b6b'            : '#58cc02';

  el.innerHTML = `
    <div class="card-vault rounded-2xl p-5 animate-fade-in">

      <!-- Vault header -->
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

      <!-- Unpaid total -->
      <div class="font-nums" style="font-size:30px; color:${amtColor};">${formatPeso(unpaidTotal)}</div>
      <div style="font-size:12px; font-weight:600; margin-top:2px; margin-bottom:16px; color:#9a9a9a;">
        ${nextBillDays !== null
          ? `⏰ Next due in ${nextBillDays} day${nextBillDays !== 1 ? 's' : ''}`
          : '🎉 No upcoming bills'}
      </div>

      <!-- Bill rows (tap to toggle paid) -->
      ${bills.length > 0 ? `
        <div style="display:flex; flex-direction:column; gap:8px;">
          ${bills.map(bill => {
            const paidBg  = bill.isPaid ? 'rgba(88,204,2,0.12)' : 'rgba(255,255,255,0.06)';
            const paidBdr = bill.isPaid ? 'rgba(88,204,2,0.4)'  : 'rgba(255,255,255,0.1)';
            const paidClr = bill.isPaid ? '#58cc02'              : '#e0e0e0';
            const dotBg   = bill.isPaid ? 'rgba(88,204,2,0.2)'  : 'rgba(255,255,255,0.08)';
            const striked = bill.isPaid ? 'text-decoration:line-through; opacity:0.65;' : '';
            return `
              <button class="btn-squishy vault-bill-btn" data-bill-id="${bill.id}"
                      style="width:100%; display:flex; align-items:center; justify-content:space-between;
                             padding:12px 16px; min-height:52px; border-radius:12px;
                             font-weight:600; font-size:13px; text-align:left; cursor:pointer;
                             background:${paidBg}; border:1.5px solid ${paidBdr}; color:${paidClr};">
                <span style="display:flex; align-items:center; gap:10px;">
                  <span style="width:24px; height:24px; border-radius:50%; display:flex;
                               align-items:center; justify-content:center; font-size:13px;
                               background:${dotBg};">${bill.isPaid ? '✓' : '○'}</span>
                  <span style="${striked}">${esc(bill.label)}</span>
                </span>
                <span style="display:flex; align-items:center; gap:10px;">
                  <span class="font-nums" style="font-size:13px;">${formatPeso(bill.amount)}</span>
                  <span style="font-size:10px; font-weight:700; border-radius:8px; padding:3px 8px;
                               background:rgba(255,255,255,0.08); color:#9a9a9a;">
                    ${formatDate(bill.dueDate)}
                  </span>
                </span>
              </button>`;
          }).join('')}
        </div>
      ` : ''}
    </div>`;
}


/* ════════════════════════════════════════════════════════════
   9. MODAL / FORM RENDERERS
   ════════════════════════════════════════════════════════════ */

let txSelectedCategory     = '';
let txSelectedNutritionTag = '';

function openQuickAdd() {
  // Reset form state
  document.getElementById('tx-amount').value = '';
  document.getElementById('tx-note').value   = '';
  txSelectedCategory     = appState.tier2Config.categories[0] || 'food';
  txSelectedNutritionTag = '';
  hideEl('blocked-warning');

  renderCategoryBtns();
  renderNutritionBtns();
  openModal('modal-quickadd');

  // Auto-focus amount after slide animation
  setTimeout(() => document.getElementById('tx-amount').focus(), 120);
}

function renderCategoryBtns() {
  const container = document.getElementById('category-btns');
  if (!container) return;

  container.innerHTML = appState.tier2Config.categories.map(cat => {
    const active = txSelectedCategory === cat;
    return `
      <button type="button" class="btn-squishy tx-cat-btn" data-cat="${cat}"
              style="flex:1; padding:12px 8px; font-size:14px; font-weight:700;
                     border-radius:16px; min-height:52px; text-transform:capitalize;
                     background:${active ? '#1cb0f6'  : '#f7f4f0'};
                     color:      ${active ? '#ffffff'  : '#9a9a9a'};
                     border:     2px solid ${active ? '#1899d6' : '#ede8df'};
                     box-shadow: ${active ? '0 4px 0 #1899d6' : 'none'};">
        ${CAT_ICONS[cat] || '📦'} ${cat}
      </button>`;
  }).join('');
}

function renderNutritionBtns() {
  const section   = document.getElementById('nutrition-section');
  const container = document.getElementById('nutrition-btns');
  if (!section || !container) return;

  // Show only when category === food
  section.style.display = txSelectedCategory === 'food' ? 'block' : 'none';

  container.innerHTML = NUTRITION_TAGS.map(tag => {
    const active = txSelectedNutritionTag === tag.value;
    return `
      <button type="button" class="btn-squishy tx-nut-btn" data-nut="${tag.value}"
              style="flex:1; padding:10px 6px; font-size:12px; font-weight:700;
                     border-radius:16px; min-height:52px; line-height:1.5;
                     background:${active ? '#ffc800' : '#f7f4f0'};
                     color:      ${active ? '#2e2e2e' : '#9a9a9a'};
                     border:     2px solid ${active ? '#e0b000' : '#ede8df'};
                     box-shadow: ${active ? '0 3px 0 #e0b000' : 'none'};">
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

  /* ── Setup Step 1: income → step 2 ── */
  document.getElementById('step1-next').addEventListener('click', () => {
    const val = pesoToCentavos(document.getElementById('income-input').value);
    if (val <= 0) { shakeInput('income-input'); return; }
    showSetupStep(2);
    renderSetupBills();
  });
  // Allow Enter key to advance
  document.getElementById('income-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('step1-next').click();
  });

  /* ── Setup Step 2: back ── */
  document.getElementById('step2-back').addEventListener('click', () => showSetupStep(1));

  /* ── Setup Step 2: show inline add-bill form ── */
  document.getElementById('add-bill-btn').addEventListener('click', () => {
    showEl('add-bill-form');
    document.getElementById('bill-label').focus();
    // Pre-fill due date to today
    if (!document.getElementById('bill-due').value) {
      document.getElementById('bill-due').value = todayISO();
    }
  });

  /* ── Setup Step 2: cancel bill form ── */
  document.getElementById('bill-cancel').addEventListener('click', () => {
    hideEl('add-bill-form');
    clearBillForm();
  });

  /* ── Setup Step 2: save a new bill ── */
  document.getElementById('bill-save').addEventListener('click', savePendingBill);
  document.getElementById('bill-due').addEventListener('keydown', e => {
    if (e.key === 'Enter') savePendingBill();
  });

  /* ── Setup Step 2: remove bill (event delegation on list) ── */
  document.getElementById('bills-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-remove-bill]');
    if (!btn) return;
    pendingSetupBills.splice(parseInt(btn.dataset.removeBill, 10), 1);
    renderSetupBills();
  });

  /* ── Setup Step 2: next → step 3 ── */
  document.getElementById('step2-next').addEventListener('click', () => {
    // Hide inline form if still open
    hideEl('add-bill-form');
    showSetupStep(3);
    renderSetupSummary();
  });

  /* ── Setup Step 3: back ── */
  document.getElementById('step3-back').addEventListener('click', () => showSetupStep(2));

  /* ── Setup Step 3: finish setup ── */
  document.getElementById('finish-setup').addEventListener('click', () => {
    const income = pesoToCentavos(document.getElementById('income-input').value);
    appState = {
      ...INITIAL_STATE,
      isSetupComplete : true,
      monthlyIncome   : income,
      tier1Bills      : pendingSetupBills.map(b => ({ ...b })), // copy
      tier2Config     : { categories: ['food', 'transport'] },
      setupDate       : todayISO(),
    };
    saveState(appState);
    pendingSetupBills = [];
    showView('view-dashboard');
    renderDashboard();
  });

  /* ── FAB → open Quick Add modal ── */
  document.getElementById('fab-add').addEventListener('click', openQuickAdd);

  /* ── Close Quick Add modal ── */
  document.getElementById('modal-close').addEventListener('click', () => closeModal('modal-quickadd'));
  // Tap backdrop to close
  document.getElementById('modal-quickadd').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-quickadd')) closeModal('modal-quickadd');
  });

  /* ── Category button selection (event delegation) ── */
  document.getElementById('category-btns').addEventListener('click', e => {
    const btn = e.target.closest('.tx-cat-btn');
    if (!btn) return;
    txSelectedCategory     = btn.dataset.cat;
    txSelectedNutritionTag = ''; // reset tag when category changes
    renderCategoryBtns();
    renderNutritionBtns();
  });

  /* ── Nutrition tag toggle (event delegation) ── */
  document.getElementById('nutrition-btns').addEventListener('click', e => {
    const btn = e.target.closest('.tx-nut-btn');
    if (!btn) return;
    // Toggle: click same tag again to deselect
    txSelectedNutritionTag = txSelectedNutritionTag === btn.dataset.nut ? '' : btn.dataset.nut;
    renderNutritionBtns();
  });

  /* ── Submit expense ── */
  document.getElementById('tx-submit').addEventListener('click', submitExpense);
  document.getElementById('tx-amount').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitExpense();
  });

  /* ── Vault bill toggle (event delegation) ── */
  document.getElementById('vault-status-container').addEventListener('click', e => {
    const btn = e.target.closest('.vault-bill-btn');
    if (!btn) return;
    toggleBillPaid(btn.dataset.billId);
    renderDashboard();
  });

  /* ── Settings modal ── */
  document.getElementById('settings-btn').addEventListener('click', () => openModal('modal-settings'));
  document.getElementById('settings-close').addEventListener('click', () => closeModal('modal-settings'));
  document.getElementById('modal-settings').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-settings')) closeModal('modal-settings');
  });

  /* ── Export ── */
  document.getElementById('export-btn').addEventListener('click', () => {
    exportJSON();
    closeModal('modal-settings');
  });

  /* ── Reset app ── */
  document.getElementById('reset-app-btn').addEventListener('click', () => {
    if (!confirm('⚠️  This will permanently delete ALL your data. Are you sure?')) return;
    clearState();
    closeModal('modal-settings');
    showView('view-welcome');
  });

  /* ── Input focus border styling ── */
  addFocusBorder('income-input');
  addFocusBorder('bill-label');
  addFocusBorder('bill-amount');
  addFocusBorder('bill-due');
  addFocusBorder('tx-amount');
  addFocusBorder('tx-note');
}

/* ── Helpers used by event listeners ────────────────────── */

function savePendingBill() {
  const label  = document.getElementById('bill-label').value.trim();
  const amount = pesoToCentavos(document.getElementById('bill-amount').value);
  const due    = document.getElementById('bill-due').value || todayISO();

  if (!label)    { shakeInput('bill-label');  return; }
  if (amount <= 0) { shakeInput('bill-amount'); return; }

  pendingSetupBills.push({ id: uid(), label, amount, dueDate: due, isPaid: false });
  hideEl('add-bill-form');
  clearBillForm();
  renderSetupBills();
}

function clearBillForm() {
  document.getElementById('bill-label').value  = '';
  document.getElementById('bill-amount').value = '';
  document.getElementById('bill-due').value    = '';
}

function submitExpense() {
  const amount = pesoToCentavos(document.getElementById('tx-amount').value);
  if (amount <= 0) { shakeInput('tx-amount'); return; }

  const note = document.getElementById('tx-note').value.trim();
  const tx   = {
    date    : todayISO(),
    amount,
    tier    : 2,
    category: txSelectedCategory,
    ...(txSelectedNutritionTag ? { nutritionTag: txSelectedNutritionTag } : {}),
    ...(note                   ? { note }                                 : {}),
  };

  const result = addTransaction(tx);

  if (result.blocked) {
    const warn = document.getElementById('blocked-warning');
    warn.style.display = 'block';
    warn.classList.remove('animate-shake');
    void warn.offsetWidth; // reflow
    warn.classList.add('animate-shake');
    setTimeout(() => { warn.style.display = 'none'; }, 3000);
  } else {
    closeModal('modal-quickadd');
    // Brief bounce animation on FAB as confirmation
    const fab = document.getElementById('fab-add');
    fab.classList.add('animate-pop');
    setTimeout(() => fab.classList.remove('animate-pop'), 400);
    renderDashboard();
  }
}


/* ════════════════════════════════════════════════════════════
   11. BOOT
   ════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  // Load persisted state
  appState = loadState();

  // Wire up all event listeners
  setupEventListeners();

  // Brief loading screen, then route to correct view
  setTimeout(() => {
    if (!appState.isSetupComplete) {
      showView('view-welcome');
    } else {
      showView('view-dashboard');
      renderDashboard();
    }
  }, 450); // loading screen visible ~450ms
});