"use strict";

// Read-only Budget viewer. Fetches an encrypted snapshot published by the
// macOS app, decrypts it in the browser with a shared passphrase, and renders
// the Overview (Snapshot + Evolution). All aggregation mirrors the Swift side
// (OverviewView / EvolutionData.build) so totals match the app exactly.

const STORAGE_KEY = "budget-view-passphrase";
const DATA_URL = "data.json";

const state = {
  data: null,          // decrypted payload
  tab: "snapshot",
  month: null,         // "YYYY-MM"
  range: "threeMonths",
  drill: {},           // { income: catId|null, expense: catId|null }
  evoSort: { col: "median", asc: false }, // heatmap default: Median, high→low
};

const fmt = new Intl.NumberFormat("nl-BE", { style: "currency", currency: "EUR" });
const money = (v) => fmt.format(v || 0);
const UNCAT_COLOR = "#8c8c8c";

// ---------------------------------------------------------------------------
// Crypto — mirrors SnapshotCrypto.swift (PBKDF2-SHA256 + AES-GCM).
// ---------------------------------------------------------------------------

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function decryptEnvelope(env, passphrase) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64ToBytes(env.salt), iterations: env.iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(env.nonce) },
    key,
    b64ToBytes(env.ct)
  );
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

// ---------------------------------------------------------------------------
// Load flow
// ---------------------------------------------------------------------------

async function tryUnlock(passphrase, remember) {
  const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not load data (${res.status}). Has it been published yet?`);
  const env = await res.json();
  const payload = await decryptEnvelope(env, passphrase); // throws on wrong passphrase
  if (remember) localStorage.setItem(STORAGE_KEY, passphrase);
  state.data = payload;
  startApp();
}

function lock() {
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
}

// ---------------------------------------------------------------------------
// Indexes & aggregation helpers (mirror the Swift store + views)
// ---------------------------------------------------------------------------

function catIndex() {
  const m = new Map();
  for (const c of state.data.categories) m.set(c.id, c);
  return m;
}

function budgetMonths() {
  const set = new Set(state.data.transactions.map((t) => t.budgetMonth));
  return [...set].sort(); // ascending
}

function groupBy(txs, keyFn) {
  const m = new Map();
  for (const t of txs) {
    const k = keyFn(t);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  return m;
}

// Group transactions by main category -> [{id,name,color,icon,total,txs}] desc.
function mainGroups(txs, cats) {
  const by = groupBy(txs, (t) => t.mainCategoryID || "uncategorized");
  const out = [];
  for (const [id, list] of by) {
    const cat = cats.get(id);
    const total = list.reduce((s, t) => s + t.amount, 0);
    if (total <= 0) continue;
    out.push({
      id,
      name: cat ? cat.name : "Uncategorized",
      color: cat ? cat.color : UNCAT_COLOR,
      iconPNG: cat ? cat.iconPNG : null,
      total,
      txs: list,
    });
  }
  return out.sort((a, b) => b.total - a.total);
}

// Sub-groups for a drilled category (mirrors BreakdownPanelView.subGroups).
function subGroups(parentTxs, cat) {
  const subIndex = new Map((cat?.subcategories || []).map((s) => [s.id, s]));
  const by = groupBy(parentTxs, (t) => t.subCategoryID || "no-sub");
  const out = [];
  for (const [id, list] of by) {
    const sub = subIndex.get(id);
    const total = list.reduce((s, t) => s + t.amount, 0);
    if (total <= 0) continue;
    out.push({
      id,
      name: sub ? sub.name : "(no subcategory)",
      color: cat ? cat.color : UNCAT_COLOR,
      iconPNG: sub ? sub.iconPNG : null,
      total,
      txs: list,
    });
  }
  return out.sort((a, b) => b.total - a.total);
}

// Grid cell distribution — mirrors CategoryGridView.distribute().
function distribute(groups, cellCount) {
  const total = groups.reduce((s, g) => s + g.total, 0);
  if (total <= 0 || cellCount <= 0) return groups.map((g) => ({ g, cells: 0 }));
  const raw = groups.map((g) => (g.total / total) * cellCount);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = cellCount - floors.reduce((s, f) => s + f, 0);
  const fracs = raw
    .map((r, i) => ({ i, frac: r - floors[i] }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < Math.min(remainder, fracs.length); k++) floors[fracs[k].i]++;
  return groups.map((g, i) => ({ g, cells: Math.max(floors[i], g.total > 0 ? 1 : 0) }));
}

function cellCountFor(total, globalMax) {
  if (globalMax <= 0 || total <= 0) return 0;
  return Math.max(1, Math.round((total / globalMax) * 100));
}

function pct(value, total) {
  if (total <= 0) return "—";
  const p = (value / total) * 100;
  if (p < 0.1) return "<0.1%";
  return p.toFixed(1) + "%";
}

// ---------------------------------------------------------------------------
// Rendering — Snapshot
// ---------------------------------------------------------------------------

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

// Icon badge (tinted PNG mask) if the category has one, else a colored dot.
function iconOrDot(g) {
  if (g.iconPNG) {
    const s = el("span", "icon");
    s.style.background = g.color;
    const url = `url("data:image/png;base64,${g.iconPNG}")`;
    s.style.webkitMaskImage = url;
    s.style.maskImage = url;
    return s;
  }
  const dot = el("span", "dot");
  dot.style.background = g.color;
  return dot;
}

function gridEl(groups, cellCount) {
  const grid = el("div", "grid");
  const dist = distribute(groups, cellCount);
  const cells = [];
  for (const { g, cells: n } of dist) for (let i = 0; i < n; i++) cells.push(g);
  for (const g of cells.slice(0, cellCount)) {
    const c = el("div", "cell");
    c.style.background = g.color;
    c.dataset.gid = g.id;
    grid.appendChild(c);
  }
  return grid;
}

function rowEl(g, total, onClick) {
  const r = el("button", "row" + (onClick ? " clickable" : ""));
  r.dataset.gid = g.id;
  r.appendChild(iconOrDot(g));
  r.appendChild(el("span", "name", g.name));
  if (total != null) r.appendChild(el("span", "pct", pct(g.total, total)));
  r.appendChild(el("span", "amt", money(g.total)));
  if (onClick) r.onclick = onClick;
  return r;
}

// Two-way hover between grid cells and rows, with the header reflecting the
// hovered group — mirrors BreakdownPanelView / SavingsPanelView.
function wireHover(panelEl, headEl, defaults, groups) {
  const labelEl = headEl.querySelector(".panel-label");
  const totalEl = headEl.querySelector(".panel-total");
  const apply = (gid) => {
    const g = gid ? groups.get(gid) : null;
    if (g) {
      labelEl.textContent = g.name.toUpperCase();
      labelEl.style.color = g.color;
      totalEl.innerHTML = money(g.total);
      totalEl.className = "panel-total";
    } else {
      labelEl.textContent = defaults.label;
      labelEl.style.color = "";
      totalEl.innerHTML = defaults.totalHTML;
      totalEl.className = defaults.totalClass;
    }
    panelEl.querySelectorAll(".cell").forEach((c) => c.classList.toggle("hot", !!gid && c.dataset.gid === gid));
    panelEl.querySelectorAll(".row").forEach((r) => {
      const hot = !!gid && r.dataset.gid === gid;
      r.classList.toggle("hot", hot);
      r.style.setProperty("--hot", hot && g ? g.color + "1a" : "");
    });
  };
  panelEl.querySelectorAll(".cell").forEach((c) => c.addEventListener("mouseenter", () => apply(c.dataset.gid)));
  panelEl.querySelectorAll(".row").forEach((r) => r.addEventListener("mouseenter", () => apply(r.dataset.gid)));
  panelEl.addEventListener("mouseleave", () => apply(null));
}

function breakdownPanel(kind, txs, cats, globalMax) {
  const panel = el("div", "panel");
  const label = kind === "income" ? "Income" : "Expenses";
  const total = txs.reduce((s, t) => s + t.amount, 0);
  const drillId = state.drill[kind];

  if (drillId) {
    const cat = cats.get(drillId);
    const parentTxs = txs.filter((t) => (t.mainCategoryID || "uncategorized") === drillId);
    const subs = subGroups(parentTxs, cat);
    const parentTotal = parentTxs.reduce((s, t) => s + t.amount, 0);
    const parentGroup = { id: drillId, name: cat ? cat.name : "Uncategorized", color: cat ? cat.color : UNCAT_COLOR, iconPNG: cat ? cat.iconPNG : null };

    const head = el("div", "drill-head");
    const back = el("button", "back", "‹");
    back.onclick = () => { state.drill[kind] = null; render(); };
    head.appendChild(back);
    const badge = iconOrDot(parentGroup);
    head.appendChild(badge);
    const nameEl = el("span", "name", parentGroup.name);
    head.appendChild(nameEl);
    const amt = el("span", "amt", money(parentTotal)); amt.style.marginLeft = "auto";
    head.appendChild(amt);
    panel.appendChild(head);

    panel.appendChild(gridEl(subs, cellCountFor(parentTotal, globalMax)));
    const hasRealSubs = (cat?.subcategories || []).length > 0;
    if (hasRealSubs) {
      const rows = el("div", "rows");
      for (const g of subs) rows.appendChild(rowEl(g, parentTotal, () => showTx(g)));
      panel.appendChild(rows);
      // Hover updates the drill header's name + amount (parent when idle).
      const subMap = new Map(subs.map((g) => [g.id, g]));
      const applyDrill = (gid) => {
        const g = gid ? subMap.get(gid) : null;
        nameEl.textContent = g ? g.name : parentGroup.name;
        amt.textContent = money(g ? g.total : parentTotal);
        panel.querySelectorAll(".cell").forEach((c) => c.classList.toggle("hot", !!gid && c.dataset.gid === gid));
        panel.querySelectorAll(".row").forEach((r) => {
          const hot = !!gid && r.dataset.gid === gid;
          r.classList.toggle("hot", hot);
          r.style.setProperty("--hot", hot && g ? g.color + "1a" : "");
        });
      };
      panel.querySelectorAll(".cell").forEach((c) => c.addEventListener("mouseenter", () => applyDrill(c.dataset.gid)));
      panel.querySelectorAll(".row").forEach((r) => r.addEventListener("mouseenter", () => applyDrill(r.dataset.gid)));
      panel.addEventListener("mouseleave", () => applyDrill(null));
    } else {
      const rows = el("div", "rows");
      panel.appendChild(txListEl(parentTxs, rows));
    }
    return panel;
  }

  const groups = mainGroups(txs, cats);
  const head = el("div", "panel-head");
  head.appendChild(el("div", "panel-label", label));
  head.appendChild(el("div", "panel-total", money(total)));
  panel.appendChild(head);

  if (groups.length === 0) { panel.appendChild(el("div", "empty", "No data")); return panel; }
  panel.appendChild(gridEl(groups, cellCountFor(total, globalMax)));
  const rows = el("div", "rows");
  for (const g of groups) rows.appendChild(rowEl(g, total, () => { state.drill[kind] = g.id; render(); }));
  panel.appendChild(rows);
  wireHover(panel, head, { label, totalHTML: money(total), totalClass: "panel-total" }, new Map(groups.map((g) => [g.id, g])));
  return panel;
}

function savingsPanel(txs, cats, globalMax) {
  const panel = el("div", "panel");
  const dirOf = (t) => cats.get(t.mainCategoryID)?.direction || null;
  const added = txs.filter((t) => dirOf(t) === "out");
  const withdrawn = txs.filter((t) => dirOf(t) === "in");
  const addedTotal = added.reduce((s, t) => s + t.amount, 0);
  const withdrawnTotal = withdrawn.reduce((s, t) => s + t.amount, 0);
  const net = addedTotal - withdrawnTotal;

  const netHTML = (net > 0 ? "+" : net < 0 ? "−" : "") + money(Math.abs(net)) +
    ' <span class="muted" style="font-size:13px">net</span>';
  const netClass = "panel-total " + (net >= 0 ? "pos" : "neg");
  const head = el("div", "panel-head");
  head.appendChild(el("div", "panel-label", "Savings"));
  head.appendChild(el("div", netClass, netHTML));
  panel.appendChild(head);

  if (added.length === 0 && withdrawn.length === 0) {
    panel.appendChild(el("div", "empty", "No savings"));
    return panel;
  }
  const addedGroups = mainGroups(added, cats);
  const withdrawnGroups = mainGroups(withdrawn, cats);
  const addSection = (groups, total) => {
    if (groups.length === 0) return;
    panel.appendChild(gridEl(groups, cellCountFor(total, globalMax)));
    if (groups.length > 1) {
      const rows = el("div", "rows");
      for (const g of groups) rows.appendChild(rowEl(g, null, () => showTx(g)));
      panel.appendChild(rows);
    }
  };
  addSection(addedGroups, addedTotal);
  addSection(withdrawnGroups, withdrawnTotal);
  wireHover(panel, head,
    { label: "Savings", totalHTML: netHTML, totalClass: netClass },
    new Map([...addedGroups, ...withdrawnGroups].map((g) => [g.id, g])));
  return panel;
}

function txListEl(txs, container) {
  const sorted = [...txs].sort((a, b) => (a.date < b.date ? 1 : -1));
  for (const t of sorted) {
    const row = el("div", "tx");
    row.appendChild(el("span", "date", t.date));
    row.appendChild(el("span", "desc", escapeHtml(t.description)));
    row.appendChild(el("span", "amt", money(t.amount)));
    container.appendChild(row);
  }
  if (sorted.length === 0) container.appendChild(el("div", "empty", "No transactions"));
  return container;
}

// Simple modal-less inline expansion: reuse the drill panel space by showing a
// transactions overlay.
function showTx(group) {
  const overlay = el("div", "");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.4);display:grid;place-items:center;z-index:20;padding:20px;";
  const card = el("div", "card");
  card.style.cssText = "width:min(560px,100%);max-height:80vh;overflow:auto;";
  const head = el("div", "drill-head");
  const back = el("button", "back", "✕"); back.onclick = () => overlay.remove();
  head.appendChild(back);
  head.appendChild(el("span", "name", group.name));
  const amt = el("span", "amt", money(group.total)); amt.style.marginLeft = "auto";
  head.appendChild(amt);
  card.appendChild(head);
  txListEl(group.txs, card);
  overlay.appendChild(card);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}

function renderSnapshot(root) {
  const cats = catIndex();
  const monthTxs = state.data.transactions.filter((t) => t.budgetMonth === state.month);
  const income = monthTxs.filter((t) => t.type === "income");
  const expense = monthTxs.filter((t) => t.type === "expense");
  const savings = monthTxs.filter((t) => t.type === "savings");
  const sum = (a) => a.reduce((s, t) => s + t.amount, 0);
  const globalMax = Math.max(sum(income), sum(expense), sum(savings));

  const panels = el("div", "panels");
  panels.appendChild(breakdownPanel("income", income, cats, globalMax));
  panels.appendChild(breakdownPanel("expense", expense, cats, globalMax));
  panels.appendChild(savingsPanel(savings, cats, globalMax));
  root.appendChild(panels);
}

// ---------------------------------------------------------------------------
// Rendering — Evolution (mirrors EvolutionData.build)
// ---------------------------------------------------------------------------

function buildEvolution() {
  const cats = catIndex();
  const all = budgetMonths();                 // ascending
  const completed = all.slice(0, -1);         // drop in-progress month
  let months;
  if (state.range === "threeMonths") months = completed.slice(-3);
  else if (state.range === "ytd") {
    const year = (all[all.length - 1] || completed[completed.length - 1] || "").slice(0, 4);
    months = completed.filter((m) => m.startsWith(year));
  } else months = completed.slice(-6);

  const shown = new Set(months);
  const windowTxs = state.data.transactions.filter((t) => shown.has(t.budgetMonth));
  const dirOf = (t) => cats.get(t.mainCategoryID)?.direction || null;

  const summaries = months.map((month) => {
    const mt = windowTxs.filter((t) => t.budgetMonth === month);
    const income = mt.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
    const expenses = mt.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
    const sav = mt.filter((t) => t.type === "savings");
    const added = sav.filter((t) => dirOf(t) === "out").reduce((s, t) => s + t.amount, 0);
    const withdrawn = sav.filter((t) => dirOf(t) === "in").reduce((s, t) => s + t.amount, 0);
    return { month, income, expenses, netSavings: added - withdrawn };
  });

  const idx = new Map(months.map((m, i) => [m, i]));
  const matrix = new Map();
  for (const t of windowTxs) {
    if (t.type !== "expense") continue;
    const key = t.mainCategoryID || "uncategorized";
    const i = idx.get(t.budgetMonth);
    if (i == null) continue;
    if (!matrix.has(key)) matrix.set(key, new Array(months.length).fill(0));
    matrix.get(key)[i] += t.amount;
  }
  const rows = [...matrix.entries()].map(([key, values]) => {
    const cat = cats.get(key);
    return {
      name: cat ? cat.name : "Uncategorized",
      color: cat ? cat.color : UNCAT_COLOR,
      iconPNG: cat ? cat.iconPNG : null,
      values,
      total: values.reduce((s, v) => s + v, 0),
      latest: values[values.length - 1] || 0,
    };
  }).filter((r) => r.total > 0).sort((a, b) => b.latest - a.latest);

  return { months, summaries, rows };
}

function shortMonth(ym) {
  const names = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const [y, m] = ym.split("-");
  return `${names[+m - 1]} '${y.slice(2)}`;
}

let charts = [];
function destroyCharts() { charts.forEach((c) => c.destroy()); charts = []; }

function renderEvolution(root) {
  const { months, summaries, rows } = buildEvolution();
  if (months.length === 0) {
    root.appendChild(el("div", "card", '<div class="empty">Not enough completed months yet. Evolution shows completed months only.</div>'));
    return;
  }
  const wrap = el("div", "evo");
  const top = el("div", "evo-top");

  const cashCard = el("div", "card");
  cashCard.appendChild(el("div", "card-title", "Monthly cash flow"));
  const cashBody = el("div", "card-body");
  const cashHead = el("div", "evo-head");
  cashHead.innerHTML =
    '<span class="lg"><i style="background:#10b981"></i>Income</span>' +
    '<span class="lg"><i style="background:#ef4444"></i>Expenses</span>' +
    '<span class="lg"><i style="background:#3b82f6"></i>Net savings</span>';
  cashBody.appendChild(cashHead);
  const cashWrap = el("div", "chart-wrap");
  const cashCanvas = document.createElement("canvas"); cashWrap.appendChild(cashCanvas);
  cashBody.appendChild(cashWrap); cashCard.appendChild(cashBody); top.appendChild(cashCard);

  const savCard = el("div", "card");
  savCard.appendChild(el("div", "card-title", "Savings"));
  const savBody = el("div", "card-body");
  const periodNet = summaries.reduce((s, m) => s + m.netSavings, 0);
  const signed = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + money(Math.abs(v));
  const savHead = el("div", "evo-head");
  savHead.innerHTML = `<span class="sav-net">${signed(periodNet)}</span> <span class="muted">net this period</span>`;
  savBody.appendChild(savHead);
  const savWrap = el("div", "chart-wrap");
  const savCanvas = document.createElement("canvas"); savWrap.appendChild(savCanvas);
  savBody.appendChild(savWrap); savCard.appendChild(savBody); top.appendChild(savCard);

  wrap.appendChild(top);

  const heatCard = el("div", "card");
  heatCard.appendChild(el("div", "card-title", "Expenses by category"));
  const heatBody = el("div", "card-body");
  heatBody.appendChild(heatTable(months, rows));
  heatCard.appendChild(heatBody);
  wrap.appendChild(heatCard);

  root.appendChild(wrap);

  const labels = months.map(shortMonth);
  destroyCharts();
  charts.push(new Chart(cashCanvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Income", data: summaries.map((s) => s.income), backgroundColor: "#10b981" },
        { label: "Expenses", data: summaries.map((s) => s.expenses), backgroundColor: "#ef4444" },
        { label: "Net savings", data: summaries.map((s) => s.netSavings), backgroundColor: "#3b82f6" },
      ],
    },
    options: chartOpts(),
  }));
  charts.push(new Chart(savCanvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Net savings",
        data: summaries.map((s) => s.netSavings),
        backgroundColor: summaries.map((s) => (s.netSavings >= 0 ? "#3b82f6" : "#ef4444")),
      }],
    },
    options: { ...chartOpts(), plugins: { ...chartOpts().plugins, legend: { display: false } } },
    plugins: [barLabelPlugin],
  }));
}

function signedMoney(v) { return (v > 0 ? "+" : v < 0 ? "−" : "") + money(Math.abs(v)); }

// Draws the signed net value above/below each savings bar (app parity).
const barLabelPlugin = {
  id: "barLabels",
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    const meta = chart.getDatasetMeta(0);
    const ds = chart.data.datasets[0];
    ctx.save();
    ctx.font = "10px Inter, -apple-system, sans-serif";
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--muted") || "#888";
    ctx.textAlign = "center";
    meta.data.forEach((bar, i) => {
      const v = ds.data[i];
      ctx.textBaseline = v >= 0 ? "bottom" : "top";
      ctx.fillText(signedMoney(v), bar.x, v >= 0 ? bar.y - 3 : bar.y + 3);
    });
    ctx.restore();
  },
};

function chartOpts() {
  const muted = getComputedStyle(document.body).getPropertyValue("--muted") || "#888";
  return {
    responsive: true, maintainAspectRatio: false,
    // Legends are rendered as HTML above each chart (in .evo-head) so both
    // charts keep a full-height, equal plot area → their x-axes line up.
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: muted }, grid: { display: false } },
      y: {
        ticks: { color: muted, callback: (v) => money(v) },
        grid: { color: "rgba(128,128,128,0.15)" },
        // Pin the y-axis (and therefore the plot area) to a fixed width so the
        // cash-flow and savings charts share the same left edge → their month
        // ticks line up vertically.
        afterFit: (s) => { s.width = 88; },
      },
    },
  };
}

function median(vals) {
  const s = [...vals].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function hexToRgba(hex, a) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function sparklineSVG(values, color) {
  const w = 180, h = 22, pad = 3;
  const max = Math.max(...values, 1), min = Math.min(...values, 0);
  const span = max - min || 1;
  const n = values.length;
  const pts = values.map((v, i) => {
    const x = n === 1 ? w / 2 : pad + (i / (n - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", w); svg.setAttribute("height", h);
  const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  poly.setAttribute("points", pts);
  poly.setAttribute("fill", "none");
  poly.setAttribute("stroke", color);
  poly.setAttribute("stroke-width", "1.5");
  poly.setAttribute("stroke-linejoin", "round");
  poly.setAttribute("stroke-linecap", "round");
  svg.appendChild(poly);
  return svg;
}

// Sort key per column: "cat", "m0..mN" (month index), "low", "median", "high".
function sortedHeatRows(rows) {
  const s = state.evoSort;
  if (!s) return rows;
  const dir = s.asc ? 1 : -1;
  const key = (r) => {
    if (s.col === "cat") return r.name.toLowerCase();
    if (s.col === "low") return Math.min(...r.values);
    if (s.col === "median") return median(r.values);
    if (s.col === "high") return Math.max(...r.values);
    if (s.col.startsWith("m")) return r.values[+s.col.slice(1)] || 0;
    return 0;
  };
  return [...rows].sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (ka < kb) return -1 * dir;
    if (ka > kb) return 1 * dir;
    return 0;
  });
}

function heatTable(months, rows) {
  const table = el("table", "heat");
  const thead = el("thead");
  const htr = el("tr");

  const th = (label, col, cls) => {
    const t = el("th", "sortable" + (cls ? " " + cls : ""));
    t.appendChild(document.createTextNode(label));
    if (state.evoSort && state.evoSort.col === col) {
      t.appendChild(el("span", "arrow", state.evoSort.asc ? " ▲" : " ▼"));
    }
    t.onclick = () => {
      const cur = state.evoSort;
      const asc = cur && cur.col === col ? !cur.asc : (col === "cat");
      state.evoSort = { col, asc };
      render();
    };
    return t;
  };

  htr.appendChild(th("Category", "cat", "cat"));
  months.forEach((m, i) => htr.appendChild(th(shortMonth(m), "m" + i)));
  htr.appendChild(el("th", "trend", "Trend"));
  htr.appendChild(th("Low", "low"));
  htr.appendChild(th("Median", "median"));
  htr.appendChild(th("High", "high"));
  thead.appendChild(htr); table.appendChild(thead);

  const tbody = el("tbody");
  for (const r of sortedHeatRows(rows)) {
    const rowMax = Math.max(...r.values, 1);
    const tr = el("tr");
    const cat = el("td", "cat");
    cat.appendChild(iconOrDot({ color: r.color, iconPNG: r.iconPNG }));
    cat.appendChild(document.createTextNode(r.name));
    tr.appendChild(cat);
    for (const v of r.values) {
      const td = el("td", "mon" + (v > 0 ? "" : " zero"));
      const span = el("span", null, v > 0 ? money(v) : "—");
      if (v > 0) span.style.background = hexToRgba(r.color, 0.12 + (v / rowMax) * 0.6);
      td.appendChild(span);
      tr.appendChild(td);
    }
    const trend = el("td", "trend");
    trend.appendChild(sparklineSVG(r.values, r.color));
    tr.appendChild(trend);
    tr.appendChild(el("td", "amt spread", money(Math.min(...r.values))));
    tr.appendChild(el("td", "amt median", money(median(r.values))));
    tr.appendChild(el("td", "amt spread", money(Math.max(...r.values))));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function render() {
  const root = document.getElementById("content");
  root.innerHTML = "";
  document.getElementById("month-picker").hidden = state.tab !== "snapshot";
  document.getElementById("range-picker").hidden = state.tab !== "evolution";
  if (state.tab === "snapshot") renderSnapshot(root);
  else renderEvolution(root);
}

function startApp() {
  document.getElementById("lock").hidden = true;
  document.getElementById("app").hidden = false;

  const months = budgetMonths().slice().reverse(); // newest first
  state.month = months[0] || null;
  const picker = document.getElementById("month-picker");
  picker.innerHTML = "";
  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  for (const m of months) {
    const opt = document.createElement("option");
    const [y, mm] = m.split("-");
    opt.value = m;
    opt.textContent = `${monthNames[+mm - 1]} ${y}`;
    picker.appendChild(opt);
  }
  picker.value = state.month;
  picker.onchange = () => { state.month = picker.value; state.drill = {}; render(); };

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.tab = btn.dataset.tab;
      render();
    };
  });
  document.querySelectorAll("#range-picker button").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll("#range-picker button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.range = btn.dataset.range;
      render();
    };
  });
  const gen = state.data.generatedAt ? new Date(state.data.generatedAt) : null;
  document.getElementById("meta").textContent = gen
    ? `Snapshot from ${gen.toLocaleString()}` : "";

  render();
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

window.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("lock-form");
  const errEl = document.getElementById("lock-error");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    const pass = document.getElementById("passphrase").value;
    const remember = document.getElementById("remember").checked;
    try {
      await tryUnlock(pass, remember);
    } catch (err) {
      errEl.textContent = err.name === "OperationError"
        ? "Wrong passphrase." : (err.message || "Could not unlock.");
      errEl.hidden = false;
    }
  });

  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    tryUnlock(saved, true).catch(() => {
      localStorage.removeItem(STORAGE_KEY); // stale/rotated passphrase → show lock
    });
  }
});
