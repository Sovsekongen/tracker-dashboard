/* Tracker dashboard — reads Sovsekongen/tracker (private) with a read-only token kept in this browser.
 * Overview numbers come from data/summary.json (built by scripts/summary.py), so they always
 * match the chats. Charts and tables only plot/list the raw CSVs; they never recompute summaries.
 */
'use strict';

const CFG = { owner: 'Sovsekongen', repo: 'tracker', branch: 'main' };
const TOKEN_KEY = 'tracker.ghToken';
const CSV_FILES = ['body_metrics', 'nutrition', 'workout_sets', 'garmin_daily', 'garmin_sessions',
  'recovery', 'batches', 'notes'];
const LONG_COLS = /notes|food|item|soreness|forefoot|biceps|evidence|source|recipe|activity/i;

const state = { token: null, tree: [], summary: null, csv: {}, loadedAt: null, overviewView: 'daily',
  chartRange: 30, charts: [], dataFile: 'nutrition', dataSort: { col: 'date', dir: -1 },
  planKind: 'daily', docCache: {} };

// ---------- small helpers ----------
const $ = (sel) => document.querySelector(sel);
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}
const store = {
  get() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set(v) { try { localStorage.setItem(TOKEN_KEY, v); return true; } catch { return false; } },
  clear() { try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
};
const num = (v) => { const x = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(x) ? x : null; };
const fmt = (v, d = 0) => (v == null ? '–' : Number(v).toLocaleString('en-GB', { maximumFractionDigits: d, minimumFractionDigits: d }));
const ddmm = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');
const hm = (min) => (min == null ? '–' : `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, '0')}m`);
const isoDay = (d) => d.toISOString().slice(0, 10);
function setStatus(t) { $('#status').textContent = t || ''; }
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// ---------- GitHub ----------
class AuthError extends Error {}
async function gh(path, { raw = false } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${state.token}`,
      Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    cache: 'no-store',
  });
  if (res.status === 401) throw new AuthError('The token was rejected (expired or revoked).');
  if (res.status === 403 || res.status === 404) {
    const err = new Error(res.status === 404 ? 'Not found or no access' : 'Forbidden / rate limited');
    err.status = res.status;
    throw err;
  }
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return raw ? res.text() : res.json();
}
const repoPath = (p) => `/repos/${CFG.owner}/${CFG.repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${CFG.branch}`;
const getFile = (p) => gh(repoPath(p), { raw: true });
async function getFileOrNull(p) {
  try { return await getFile(p); } catch (e) { if (e.status === 404) return null; throw e; }
}

// ---------- CSV ----------
function parseCSV(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return { cols: [], rows: [] };
  const cols = rows[0];
  return { cols, rows: rows.slice(1).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? '']))) };
}

// ---------- loading ----------
async function loadAll() {
  setStatus('Loading…');
  const treeP = gh(`/repos/${CFG.owner}/${CFG.repo}/git/trees/${CFG.branch}?recursive=1`);
  const sumP = getFileOrNull('data/summary.json');
  const csvP = CSV_FILES.map((n) => getFileOrNull(`data/${n}.csv`));
  const [tree, sum, ...csvs] = await Promise.all([treeP, sumP, ...csvP]);
  state.tree = (tree.tree || []).filter((t) => t.type === 'blob').map((t) => t.path);
  state.summary = sum ? JSON.parse(sum) : null;
  CSV_FILES.forEach((n, i) => { state.csv[n] = csvs[i] ? parseCSV(csvs[i]) : { cols: [], rows: [] }; });
  // Any other CSVs added later show up in the Data tab too (loaded on demand).
  state.docCache = {};
  state.loadedAt = new Date();
  setStatus(`Updated ${state.loadedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`);
}

// ---------- routing ----------
const VIEWS = { overview: renderOverview, charts: renderCharts, data: renderData, plans: renderPlans,
  recipes: renderRecipes, profile: renderProfile };
function currentView() { const v = location.hash.slice(1); return VIEWS[v] ? v : 'overview'; }
async function route() {
  const v = currentView();
  document.querySelectorAll('#nav a').forEach((a) => a.toggleAttribute('aria-current', a.dataset.view === v));
  document.querySelectorAll('#nav a[aria-current]').forEach((a) => a.setAttribute('aria-current', 'page'));
  destroyCharts();
  const main = $('#main');
  main.replaceChildren();
  try { await VIEWS[v](main); } catch (e) { handleError(e); }
  window.scrollTo(0, 0);
}

function handleError(e) {
  console.error(e);
  if (e instanceof AuthError) { store.clear(); state.token = null; showLogin(e.message); return; }
  const msg = e.status === 404
    ? 'GitHub says “not found”. Check that the token has access to Sovsekongen/tracker (Contents: Read-only).'
    : e.status === 403 ? 'GitHub refused the request (permissions or rate limit). Try again in a few minutes.'
      : `Something went wrong: ${e.message}`;
  $('#main').prepend(el('div', { class: 'banner error' }, msg));
  setStatus('');
}

// ---------- login ----------
function showLogin(message) {
  $('#nav').hidden = true; $('#refresh').hidden = true; $('#signout').hidden = true;
  const input = el('input', { type: 'password', id: 'token', placeholder: 'github_pat_…', autocomplete: 'off', required: true });
  const err = el('div', { class: 'banner error', hidden: !message }, message || '');
  const form = el('form', {
    onsubmit: async (ev) => {
      ev.preventDefault();
      const t = input.value.trim();
      if (!t) return;
      state.token = t;
      try {
        await gh(`/repos/${CFG.owner}/${CFG.repo}`);
        if (!store.set(t)) err.textContent = 'Note: this browser blocks storage — you will need to paste the token again next time.';
        start();
      } catch (e) {
        state.token = null;
        err.hidden = false;
        err.textContent = e instanceof AuthError ? 'That token was rejected. Check that you copied all of it.'
          : e.status === 404 ? 'The token works, but has no access to Sovsekongen/tracker. Edit the token’s repository access.'
            : `Could not reach GitHub: ${e.message}`;
      }
    },
  }, input, el('button', { class: 'btn', type: 'submit' }, 'Save on this device'));
  $('#main').replaceChildren(el('section', { class: 'login card' },
    el('h1', {}, 'Connect to your tracker'),
    el('p', { class: 'muted' }, 'Your data lives in a private GitHub repo. This page reads it with a read-only token that is stored only in this browser.'),
    el('ol', {},
      el('li', {}, 'Open ', el('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener' }, 'GitHub → new fine-grained token'), ' (logged in as Sovsekongen).'),
      el('li', {}, 'Resource owner: Sovsekongen. Expiration: e.g. 1 year.'),
      el('li', {}, 'Repository access: Only select repositories → tracker.'),
      el('li', {}, 'Permissions → Repository → Contents: Read-only. Nothing else.'),
      el('li', {}, 'Generate, copy, and paste it below.')),
    err, form,
    el('p', { class: 'small muted' }, 'Use “Log out” at the top to forget the token on this device.')));
  setStatus('');
}

// ---------- overview ----------
function deltaText(cur, prev, d, lowerIsGood) {
  if (cur == null || prev == null) return null;
  const diff = cur - prev;
  if (Math.abs(diff) < 10 ** -d / 2) return el('span', {}, '±0');
  const good = lowerIsGood == null ? null : (diff < 0) === lowerIsGood;
  return el('span', { class: good == null ? '' : good ? 'delta-good' : 'delta-bad' }, `${diff > 0 ? '+' : '−'}${fmt(Math.abs(diff), d)}`);
}
function kpi({ label, value, unit, sub, meter, wide }) {
  return el('div', { class: `card${wide ? ' wide' : ''}` },
    el('div', { class: 'kpi-label' }, label),
    el('div', { class: 'kpi-value' }, value, unit ? el('span', { class: 'unit' }, unit) : null),
    sub ? el('div', { class: 'kpi-sub' }, sub) : null,
    meter || null);
}
function meter(value, target) {
  if (value == null || !target) return null;
  const pct = Math.min(100, (value / target) * 100);
  return el('div', { class: `meter${value > target * 1.05 ? ' over' : ''}` }, el('span', { style: `width:${pct}%` }));
}

async function renderOverview(main) {
  const S = state.summary;
  if (!S) { main.append(el('div', { class: 'banner' }, 'data/summary.json not found yet — it is created by the “Summary JSON” workflow.')); return; }
  const V = S[state.overviewView];
  const T = S.targets || {};
  const c = V.current; const p = V.prev; const e = V.extras;

  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Summary view' },
    ['daily', 'weekly'].map((k) => el('button', {
      type: 'button', 'aria-pressed': String(state.overviewView === k),
      onclick: () => { state.overviewView = k; route(); },
    }, k === 'daily' ? 'Last 7 days' : 'Last week (Mon–Sun)')));
  main.append(el('div', { class: 'row spread' }, seg,
    el('span', { class: 'small muted' }, `${ddmm(V.window.start)}–${ddmm(V.window.end)} vs ${ddmm(V.previous.start)}–${ddmm(V.previous.end)}`)));

  if (e.incomplete_days?.length) {
    main.append(el('div', { class: 'banner mt' }, `⚠️ Likely incomplete food logs: ${e.incomplete_days.map(ddmm).join(', ')} — kcal/protein averages include them.`));
  }

  const proteinMid = T.protein_min && T.protein_max ? (T.protein_min + T.protein_max) / 2 : null;
  const grid = el('div', { class: 'grid mt' },
    kpi({ label: 'Weight (morning avg)', value: fmt(c.weight, 1), unit: 'kg',
      sub: el('span', {}, c.weight_n ? `n=${c.weight_n} · ` : 'no readings · ', 'prev ', fmt(p.weight, 1), ' ', deltaText(c.weight, p.weight, 1, true) || '',
        T.weight_min ? ` · goal ${T.weight_min}–${T.weight_max}` : '') }),
    kpi({ label: 'Calories / day', value: fmt(c.kcal), unit: 'kcal',
      sub: `target ${fmt(T.kcal)} · ${c.logged_days}/${c.window_days} days logged`, meter: meter(c.kcal, T.kcal) }),
    kpi({ label: 'Protein / day', value: fmt(c.protein), unit: 'g',
      sub: `target ${T.protein_min ?? '–'}–${T.protein_max ?? '–'} g · prev ${fmt(p.protein)}`, meter: meter(c.protein, proteinMid) }),
    kpi({ label: 'Training', value: String(c.strength), unit: 'sessions',
      sub: `${c.sets} sets · ${fmt(c.rowing)} min rowing · prev ${p.strength} sessions` }),
    kpi({ label: 'Sleep', value: hm(c.sleep_min),
      sub: el('span', {}, `score ${fmt(c.sleep_score)} · prev ${hm(p.sleep_min)}`) }),
    kpi({ label: 'HRV (last night avg)', value: fmt(c.hrv), unit: 'ms',
      sub: el('span', {}, 'prev ', fmt(p.hrv), ' ', deltaText(c.hrv, p.hrv, 0, false) || '') }),
    kpi({ label: 'Resting HR', value: fmt(c.rhr), unit: 'bpm',
      sub: el('span', {}, 'prev ', fmt(p.rhr), ' ', deltaText(c.rhr, p.rhr, 0, true) || '') }),
    kpi({ label: 'Steps / stress', value: fmt(c.steps), unit: 'steps',
      sub: `stress ${fmt(c.stress)} · alcohol ${fmt(c.alcohol)} kcal` }),
  );
  main.append(grid);

  const r = e.recovery;
  const side = el('div', { class: 'grid mt' },
    el('div', { class: 'card wide' },
      el('div', { class: 'kpi-label' }, `Foot & biceps${r ? ` · ${ddmm(r.date)}` : ''}`),
      r ? el('ul', { class: 'list' },
        el('li', {}, el('strong', {}, 'Left forefoot: '), r.forefoot || '–'),
        el('li', {}, el('strong', {}, 'Left biceps: '), r.biceps || '–')) : el('p', { class: 'muted' }, 'No checks logged.')),
    el('div', { class: 'card wide' },
      el('div', { class: 'kpi-label' }, 'Batch portions left'),
      e.batches?.length ? el('ul', { class: 'list' }, e.batches.map((b) => el('li', { class: 'row spread' },
        el('span', {}, b.recipe), el('span', { class: 'muted' }, `×${b.portions}${b.use_by ? ` · use by ${ddmm(b.use_by)}` : ''}`))))
        : el('p', { class: 'muted' }, 'None.')),
    el('div', { class: 'card wide' },
      el('div', { class: 'kpi-label' }, 'Body composition'),
      el('ul', { class: 'list' },
        el('li', {}, el('strong', {}, 'Latest Tanita: '), e.tanita ? `${e.tanita.date} · ${fmt(e.tanita.weight_kg, 1)} kg · ${e.tanita.body_fat_pct ?? '–'}% fat` : '–'),
        el('li', {}, el('strong', {}, 'Latest waist: '), e.waist ? `${e.waist.date} · ${e.waist.cm} cm` : '–'))),
  );
  main.append(side);

  main.append(el('h2', {}, 'Full summary (same as the chat)'),
    el('div', { class: 'card md' }, mdNode(V.markdown, { breaks: true })),
    el('p', { class: 'small muted' }, `Generated ${S.generated_at} by scripts/summary.py`));
}

// ---------- charts ----------
function destroyCharts() { state.charts.forEach((c) => c.destroy()); state.charts = []; }
function dayRange(days) {
  const all = [];
  for (const n of ['body_metrics', 'nutrition', 'garmin_daily', 'workout_sets']) {
    for (const r of state.csv[n]?.rows || []) if (/^\d{4}-\d{2}-\d{2}/.test(r.date)) all.push(r.date.slice(0, 10));
  }
  if (!all.length) return [];
  all.sort();
  const end = new Date(`${all[all.length - 1]}T12:00:00Z`);
  let start = new Date(`${all[0]}T12:00:00Z`);
  if (days) { const s = new Date(end); s.setUTCDate(s.getUTCDate() - days + 1); if (s > start) start = s; }
  const out = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) out.push(isoDay(d));
  return out;
}
function baseOptions(extra = {}) {
  const grid = cssVar('--chart-grid'); const muted = cssVar('--muted');
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: muted, boxWidth: 12, font: { size: 11 } } } },
    scales: {
      x: { ticks: { color: muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 7, callback(v) { return ddmm(this.getLabelForValue(v)); } }, grid: { display: false } },
      y: { ticks: { color: muted }, grid: { color: grid } },
    },
    ...extra,
  };
}
function chartCard(title, note) {
  const canvas = el('canvas');
  const card = el('div', { class: 'card chart-card' }, el('h3', {}, title), note ? el('p', { class: 'small muted', style: 'margin:-4px 0 8px' }, note) : null, el('div', { class: 'chart-box' }, canvas));
  return { card, canvas };
}
function makeChart(canvas, cfg) { state.charts.push(new Chart(canvas, cfg)); }
const line = (label, data, color, extra = {}) => ({ type: 'line', label, data, borderColor: color, backgroundColor: color, pointRadius: 2, borderWidth: 2, spanGaps: true, tension: 0.25, ...extra });
const flat = (label, value, n, color) => line(label, Array(n).fill(value), color, { borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5, tension: 0 });

async function renderCharts(main) {
  const S = state.summary; const T = S?.targets || {};
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Range' },
    [[14, '14 d'], [30, '30 d'], [90, '90 d'], [0, 'All']].map(([d, l]) => el('button', {
      type: 'button', 'aria-pressed': String(state.chartRange === d), onclick: () => { state.chartRange = d; route(); },
    }, l)));
  main.append(el('div', { class: 'row spread' }, seg, el('span', { class: 'small muted' }, 'Raw data; partial Garmin days left out')));
  const days = dayRange(state.chartRange);
  if (!days.length) { main.append(el('p', { class: 'muted' }, 'No data yet.')); return; }
  const idx = Object.fromEntries(days.map((d, i) => [d, i]));
  const blank = () => Array(days.length).fill(null);
  const C = [cssVar('--chart-1'), cssVar('--chart-2'), cssVar('--chart-3'), cssVar('--chart-4'), cssVar('--muted')];
  const wrap = el('div', { class: 'charts mt' });
  main.append(wrap);

  // Weight: morning home-scale readings (same filter as summary.py) + rolling 7-day mean + Tanita.
  const wDay = blank(); const tanita = blank(); const roll = blank();
  for (const r of state.csv.body_metrics.rows) {
    const i = idx[r.date?.slice(0, 10)]; const w = num(r.weight_kg);
    if (i == null || w == null) continue;
    if (/home|morning/i.test(r.measurement_source)) wDay[i] = w;
    else if (/tanita/i.test(r.measurement_source)) tanita[i] = w;
  }
  const allW = state.csv.body_metrics.rows.filter((r) => /home|morning/i.test(r.measurement_source) && num(r.weight_kg) != null);
  days.forEach((d, i) => {
    const start = new Date(`${d}T12:00:00Z`); start.setUTCDate(start.getUTCDate() - 6);
    const xs = allW.filter((r) => r.date >= isoDay(start) && r.date <= d).map((r) => num(r.weight_kg));
    roll[i] = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  });
  let ch = chartCard('Weight (kg)', 'Dots = morning readings, line = 7-day average, squares = Tanita');
  wrap.append(ch.card);
  const wSets = [line('Morning', wDay, C[0], { showLine: false, pointRadius: 3 }), line('7-day avg', roll, C[0], { pointRadius: 0 }),
    line('Tanita', tanita, C[1], { showLine: false, pointStyle: 'rectRot', pointRadius: 5 })];
  if (T.weight_min) wSets.push(flat(`Goal ${T.weight_min}–${T.weight_max}`, T.weight_min, days.length, C[4]), flat('', T.weight_max, days.length, C[4]));
  makeChart(ch.canvas, { type: 'line', data: { labels: days, datasets: wSets },
    options: baseOptions({ plugins: { legend: { labels: { color: cssVar('--muted'), boxWidth: 12, filter: (it) => it.text !== '' } } } }) });

  // kcal & protein per day (sum of logged rows; alcohol stacked separately).
  const food = blank(); const alc = blank(); const prot = blank();
  for (const r of state.csv.nutrition.rows) {
    const i = idx[r.date?.slice(0, 10)]; if (i == null) continue;
    const k = num(r.energy_kcal) || 0; const p = num(r.protein_g) || 0;
    if (/^alcohol$/i.test(r.meal)) alc[i] = (alc[i] || 0) + k; else food[i] = (food[i] || 0) + k;
    prot[i] = (prot[i] || 0) + p;
  }
  ch = chartCard('Calories per day (kcal)', 'Logged intake. Days under 1,500 kcal of food are probably incomplete.');
  wrap.append(ch.card);
  makeChart(ch.canvas, { type: 'bar', data: { labels: days, datasets: [
    { type: 'bar', label: 'Food', data: food, backgroundColor: food.map((v) => (v != null && v < 1500 ? `${C[0]}66` : C[0])), stack: 'k' },
    { type: 'bar', label: 'Alcohol', data: alc, backgroundColor: C[1], stack: 'k' },
    ...(T.kcal ? [flat(`Target ${T.kcal}`, T.kcal, days.length, C[4])] : [])] },
  options: baseOptions({ scales: { ...baseOptions().scales, x: { ...baseOptions().scales.x, stacked: true }, y: { ...baseOptions().scales.y, stacked: true } } }) });

  ch = chartCard('Protein per day (g)');
  wrap.append(ch.card);
  makeChart(ch.canvas, { type: 'bar', data: { labels: days, datasets: [
    { type: 'bar', label: 'Protein', data: prot, backgroundColor: C[2] },
    ...(T.protein_min ? [flat(`Target ${T.protein_min}–${T.protein_max}`, T.protein_min, days.length, C[4]), flat('', T.protein_max, days.length, C[4])] : [])] },
  options: baseOptions({ plugins: { legend: { labels: { color: cssVar('--muted'), boxWidth: 12, filter: (it) => it.text !== '' } } } }) });

  // Garmin (exclude PARTIAL days, like summary.py)
  const sleepH = blank(); const score = blank(); const hrv = blank(); const rhr = blank();
  for (const r of state.csv.garmin_daily.rows) {
    const i = idx[r.date?.slice(0, 10)];
    if (i == null || /PARTIAL/.test(r.confidence || '')) continue;
    const m = num(r.sleep_min); sleepH[i] = m == null ? null : +(m / 60).toFixed(2);
    score[i] = num(r.sleep_score); hrv[i] = num(r.hrv_last_night_ms); rhr[i] = num(r.resting_hr_bpm);
  }
  ch = chartCard('Sleep', 'Bars = hours (left axis), line = sleep score (right axis)');
  wrap.append(ch.card);
  const so = baseOptions();
  so.scales.y1 = { position: 'right', min: 0, max: 100, ticks: { color: cssVar('--muted') }, grid: { display: false } };
  makeChart(ch.canvas, { type: 'bar', data: { labels: days, datasets: [
    { type: 'bar', label: 'Hours', data: sleepH, backgroundColor: `${C[2]}aa`, yAxisID: 'y' },
    line('Score', score, C[1], { yAxisID: 'y1' })] }, options: so });

  ch = chartCard('HRV & resting heart rate', 'HRV ms (left), resting HR bpm (right)');
  wrap.append(ch.card);
  const ho = baseOptions();
  ho.scales.y1 = { position: 'right', ticks: { color: cssVar('--muted') }, grid: { display: false } };
  makeChart(ch.canvas, { type: 'line', data: { labels: days, datasets: [
    line('HRV', hrv, C[0], { yAxisID: 'y' }), line('Resting HR', rhr, C[1], { yAxisID: 'y1' })] }, options: ho });

  // Lifts (from summary.json → same "best set" definition as the chat)
  const lifts = S?.lifts || [];
  if (lifts.length) {
    const sel = el('select', { 'aria-label': 'Exercise' }, lifts.map((l, i) => el('option', { value: i }, l.exercise)));
    const { card, canvas } = chartCard('Lift progress — best set per session (kg)');
    card.insertBefore(el('div', { class: 'row', style: 'margin-bottom:8px' }, sel), card.querySelector('.chart-box'));
    wrap.append(card);
    let liftChart = null;
    const draw = () => {
      const l = lifts[sel.value];
      if (liftChart) { liftChart.destroy(); state.charts = state.charts.filter((x) => x !== liftChart); }
      const o = baseOptions();
      o.plugins.tooltip = { callbacks: { label: (ctx) => `${ctx.parsed.y} kg × ${l.history[ctx.dataIndex].reps}` } };
      liftChart = new Chart(canvas, { type: 'line', data: { labels: l.history.map((h) => h.date),
        datasets: [line(l.exercise, l.history.map((h) => h.kg), C[0], { pointRadius: 4 })] }, options: o });
      state.charts.push(liftChart);
    };
    sel.addEventListener('change', draw);
    draw();
  }
}

// ---------- data tables ----------
async function loadCsv(name) {
  if (!state.csv[name]) {
    const t = await getFileOrNull(`data/${name}.csv`);
    state.csv[name] = t ? parseCSV(t) : { cols: [], rows: [] };
  }
  return state.csv[name];
}
async function renderData(main) {
  const files = state.tree.filter((p) => /^data\/[^/]+\.csv$/.test(p)).map((p) => p.slice(5, -4)).sort();
  if (!files.includes(state.dataFile)) state.dataFile = files[0];
  if (!state.dataFile) { main.append(el('p', { class: 'muted' }, 'No CSV files.')); return; }
  const data = await loadCsv(state.dataFile);

  const fileSel = el('select', { onchange: (ev) => { state.dataFile = ev.target.value; state.dataSort = { col: 'date', dir: -1 }; route(); } },
    files.map((f) => el('option', { value: f, selected: f === state.dataFile }, f)));
  const from = el('input', { type: 'date' }); const to = el('input', { type: 'date' });
  const q = el('input', { type: 'search', placeholder: 'Search…' });
  const count = el('span', { class: 'small muted' });
  main.append(el('div', { class: 'filters' },
    el('label', { class: 'full' }, 'File', fileSel), el('label', {}, 'From', from), el('label', {}, 'To', to),
    el('label', { class: 'full' }, 'Search', q)));
  const wrap = el('div', { class: 'table-wrap' });
  main.append(el('div', { class: 'row spread', style: 'margin-bottom:6px' }, count, el('span', { class: 'small muted' }, 'Tap a row to expand')), wrap);

  const hasDate = data.cols.includes('date');
  const draw = () => {
    const { col, dir } = state.dataSort;
    const needle = q.value.trim().toLowerCase();
    let rows = data.rows.filter((r) => {
      if (hasDate && from.value && r.date < from.value) return false;
      if (hasDate && to.value && r.date.slice(0, 10) > to.value) return false;
      return !needle || Object.values(r).some((v) => v.toLowerCase().includes(needle));
    });
    if (data.cols.includes(col)) {
      rows = [...rows].sort((a, b) => {
        const x = num(a[col]); const y = num(b[col]);
        const cmp = x != null && y != null && !/date/.test(col) ? x - y : String(a[col]).localeCompare(String(b[col]));
        return cmp * dir;
      });
    }
    count.textContent = `${rows.length} of ${data.rows.length} rows`;
    const head = el('tr', {}, data.cols.map((c) => el('th', {
      onclick: () => { state.dataSort = { col: c, dir: state.dataSort.col === c ? -state.dataSort.dir : 1 }; draw(); },
    }, c, el('span', { class: 'sort' }, state.dataSort.col === c ? (state.dataSort.dir > 0 ? '▲' : '▼') : ''))));
    const body = rows.map((r) => el('tr', { onclick: (ev) => ev.currentTarget.classList.toggle('open') },
      data.cols.map((c) => (LONG_COLS.test(c) && (r[c] || '').length > 30
        ? el('td', { class: 'long' }, el('div', { class: 'clamp' }, r[c]))
        : el('td', {}, r[c])))));
    wrap.replaceChildren(el('table', {}, el('thead', {}, head), el('tbody', {}, body)));
  };
  [from, to].forEach((i) => i.addEventListener('change', draw));
  q.addEventListener('input', draw);
  draw();
}

// ---------- markdown documents ----------
function mdNode(text, { breaks = false } = {}) {
  const html = DOMPurify.sanitize(marked.parse(text || '', { gfm: true, breaks }));
  const div = el('div', { class: 'md' });
  div.innerHTML = html; // sanitized above
  div.querySelectorAll('a[href]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  return div;
}
async function getDoc(path) {
  if (!(path in state.docCache)) state.docCache[path] = await getFileOrNull(path);
  return state.docCache[path];
}
function docBrowser(main, paths, labelFn, emptyText) {
  if (!paths.length) { main.append(el('p', { class: 'muted' }, emptyText)); return; }
  const list = el('div', { class: 'doc-list' });
  const view = el('div', { class: 'card md' }, el('div', { class: 'loading' }, 'Loading…'));
  const open = async (p) => {
    list.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.path === p)));
    view.replaceChildren(el('div', { class: 'loading' }, 'Loading…'));
    try {
      const t = await getDoc(p);
      view.replaceChildren(t == null ? el('p', { class: 'muted' }, 'File not found.') : mdNode(t));
    } catch (e) { handleError(e); }
    if (window.innerWidth < 900) view.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  paths.forEach((p) => list.append(el('button', { type: 'button', 'data-path': p, onclick: () => open(p) }, labelFn(p))));
  main.append(el('div', { class: 'docs-layout' }, list, view));
  open(paths[0]);
}
async function renderPlans(main) {
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Plan type' },
    [['daily', 'Daily'], ['weekly', 'Weekly']].map(([k, l]) => el('button', {
      type: 'button', 'aria-pressed': String(state.planKind === k), onclick: () => { state.planKind = k; route(); },
    }, l)));
  main.append(el('div', { class: 'row', style: 'margin-bottom:10px' }, seg));
  const paths = state.tree.filter((p) => p.startsWith(`plans/${state.planKind}/`) && p.endsWith('.md')).sort().reverse();
  const label = (p) => {
    const n = p.split('/').pop().replace('.md', '');
    if (state.planKind === 'weekly') return n.replace('-W', ' · week ');
    const d = new Date(`${n}T12:00:00Z`);
    return Number.isNaN(+d) ? n : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  };
  docBrowser(main, paths, label, state.planKind === 'weekly' ? 'No weekly plans yet — the first arrives Sunday evening.' : 'No daily plans yet.');
}
async function renderRecipes(main) {
  const paths = state.tree.filter((p) => p.startsWith('recipes/') && p.endsWith('.md')).sort();
  const label = (p) => p.split('/').pop().replace('.md', '').replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  docBrowser(main, paths, label, 'No recipes yet.');
}
async function renderProfile(main) {
  docBrowser(main, ['profile.md', 'AGENT.md'].filter((p) => state.tree.includes(p)),
    (p) => (p === 'profile.md' ? 'Profile & targets' : 'Coach rules & changelog'), 'profile.md not found.');
}

// ---------- start ----------
async function start() {
  $('#nav').hidden = false; $('#refresh').hidden = false; $('#signout').hidden = false;
  $('#main').replaceChildren(el('div', { class: 'loading' }, 'Loading your data…'));
  try { await loadAll(); } catch (e) { handleError(e); return; }
  route();
}

window.addEventListener('hashchange', () => { if (state.token) route(); });
$('#refresh').addEventListener('click', async () => {
  try { await loadAll(); route(); } catch (e) { handleError(e); }
});
$('#signout').addEventListener('click', () => {
  if (!confirm('Forget the GitHub token on this device?')) return;
  store.clear(); state.token = null; state.csv = {}; state.summary = null; destroyCharts(); showLogin();
});

state.token = store.get();
if (state.token) start(); else showLogin();
