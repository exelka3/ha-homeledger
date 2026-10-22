/* Home Budget — frontend (vanilla JS, no build step).
 * All requests use relative URLs so the app works behind Home Assistant Ingress.
 * UI text comes from locales/<lang>.json through t() (see i18n.js). */

const COLORS = ["#4353ff", "#e0566b", "#1f9e74", "#e08a3c", "#8a5cf6", "#2a9fb8", "#a07655", "#6b7686"];
// Labels are looked up at render time (the locale loads after this file is evaluated).
const KINDS = {
  home: { color: "#5b6cff" },
  groceries: { color: "#1f9e74" },
  car: { color: "#e08a3c" },
  bills: { color: "#b9548c" },
};
const kindName = (k) => t("kind." + k);
const kindDot = (k) => `<span class="dot" style="background:${KINDS[k].color}"></span>`;
const KIND_COLORS = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.color]));
const CAR_DOCS = ["osago_until", "kasko_until", "inspection_until", "next_service_date"];
const carDocName = (k) => t("car_doc." + k);
const PLAN_STATUS = ["idea", "planned", "in_progress", "done"];
const planStatusName = (s) => (PLAN_STATUS.includes(s) ? t("plan_status." + s) : "");
const PRIORITY = ["high", "medium", "low"];
// [code, symbol, symbol goes before the number]; a null symbol is localized (currency_symbol.<code>).
const CURRENCIES = [
  ["RUB", "₽"], ["USD", "$", true], ["EUR", "€"],
  ["KZT", "₸"], ["BYN", "Br"], ["UAH", "₴"],
  ["UZS", null], ["KGS", null], ["AMD", "֏"],
  ["GEL", "₾"], ["AZN", "₼"], ["TRY", "₺"],
  ["CNY", "¥"], ["GBP", "£", true], ["PLN", "zł"],
  ["CZK", "Kč"], ["AED", "AED"], ["THB", "฿"],
];
const currencySymbol = ([code, sym]) => sym ?? t("currency_symbol." + code);

let db = null;
let view = localStorage.getItem("hb.view") || "overview";
const ui = {
  planFilter: { room: "", status: "", payer: "" },
  statsPeriod: "month",
  statsPayer: "",
  me: null,
  haServices: [],
  carsExpanded: new Set(),
  shopping: JSON.parse(localStorage.getItem("hb.shopping") || "null"), // {checked: [ids]}
};

// --- utils ---------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Local calendar date (toISOString would give the UTC date, wrong around midnight).
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const num = (v) => (Number.isFinite(+v) ? +v : 0);
function money(v, settings = db?.settings || {}) {
  const cents = Math.round(num(v) * 100) / 100; // money is exact to the cent; drops float noise from averages
  const decimals = settings.currency_decimals === false ? 0 : cents % 1 ? 2 : 0;
  const n = fmtNumber(cents, decimals);
  const sym = settings.currency || "₽";
  return settings.currency_position === "before" ? sym + n : n + " " + sym;
}
// Compact amount for tight spots (chart labels, month table): one decimal, e.g. 1,3k / 143,3k / 1,2M.
// The exact amount is always in the tooltip.
function compactMoney(v) {
  const abs = Math.abs(num(v));
  const [div, suffix] = abs >= 1e6 ? [1e6, "M"] : abs >= 1e3 ? [1e3, "k"] : [1, ""];
  const value = new Intl.NumberFormat(locale(), { maximumFractionDigits: div === 1 ? 2 : 1 }).format(num(v) / div);
  return value + suffix;
}
const monthKey = (d) => String(d || "").slice(0, 7);
// "YYYY-MM" -> short month name, optionally with the year.
const monthLabel = (k, withYear = false) => monthShort(+k.slice(5) - 1) + (withYear ? " " + k.slice(0, 4) : "");
const resident = (id) => db.residents.find((r) => r.id === id);
// Avatar from the HA profile when the resident is linked to a person, otherwise a coloured initial.
const avatar = (r, cls = "avatar") => r.picture
  ? `<img class="${cls}" src="api/ha/avatar/${r.id}" alt="" style="background:${r.color}" onerror="this.removeAttribute('src')">`
  : `<span class="${cls}" style="background:${r.color}">${esc((r.name || "?")[0].toUpperCase())}</span>`;
const residentChip = (id) => {
  const r = resident(id);
  return r ? `<span class="chip">${r.picture ? avatar(r, "mini-ava") : `<span class="dot" style="background:${r.color}"></span>`}${esc(r.name)}</span>` : `<span class="muted small">—</span>`;
};
// The resident who opened the app (known inside HA Ingress); used as the default payer.
const meId = () => ui.me?.resident_id || "";
const itemTotal = (i) => num(i.price) * (num(i.qty) || 1);

async function api(method, path, body) {
  const res = await fetch("api/" + path, {
    method,
    headers: { "X-Homeledger-Lang": I18N.lang, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function reload() {
  db = await api("GET", "state");
  render();
}

async function mutate(method, path, body, okMsg) {
  try {
    const result = await api(method, path, body);
    await reload();
    if (okMsg) toast(okMsg);
    return result;
  } catch (e) {
    toast(e.message, true);
    throw e;
  }
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (isError ? " error" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2800);
}

// --- modal form ------------------------------------------------------------
function openForm({ title, fields, submitLabel = t("common.save"), onSubmit, onDelete, note = "", onChange = null }) {
  $("#modal-title").textContent = title;
  $("#modal-submit").textContent = submitLabel;
  $("#modal-body").innerHTML = fields
    .map((f) => {
      if (f.type === "row") return `<div class="fields-2">${f.fields.map(fieldHtml).join("")}</div>`;
      return fieldHtml(f);
    })
    .join("");
  if (note) $("#modal-body").insertAdjacentHTML("beforeend", `<div class="muted small" style="margin-bottom:10px">${esc(note)}</div>`);
  const del = $("#modal-delete");
  del.hidden = !onDelete;
  del.onclick = async () => {
    if (!(await askConfirm(t("common.delete_confirm"), t("common.delete"), true))) return;
    closeModal();
    await onDelete();
  };
  $("#modal-form").onclick = (e) => {
    const name = e.target.closest("[data-clear-date]")?.dataset.clearDate;
    if (!name) return;
    const input = e.currentTarget.elements[name];
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  $("#modal-form").onchange = onChange ? (e) => onChange(e.currentTarget, e) : null;
  $("#modal-form").onsubmit = async (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.target).entries());
    fields.flatMap((f) => (f.type === "row" ? f.fields : [f])).forEach((f) => {
      if (f.type === "number") values[f.name] = values[f.name] === "" ? "" : num(values[f.name]);
    });
    try {
      await onSubmit(values);
      closeModal();
    } catch { /* toast already shown */ }
  };
  $("#modal").hidden = false;
  setTimeout(() => $("#modal-body input, #modal-body select")?.focus(), 30);
}

function fieldHtml(f) {
  const v = f.value ?? "";
  const req = f.required ? "required" : "";
  let input;
  if (f.type === "select") {
    input = `<select name="${f.name}" ${req}>${f.options
      .map(([val, lbl]) => `<option value="${esc(val)}" ${String(val) === String(v) ? "selected" : ""}>${esc(lbl)}</option>`)
      .join("")}</select>`;
  } else if (f.type === "textarea") {
    input = `<textarea name="${f.name}" rows="3">${esc(v)}</textarea>`;
  } else {
    const extra = f.type === "number" ? `step="${f.step || "any"}" min="0" inputmode="decimal"` : "";
    const list = f.datalist ? `list="dl-${f.name}"` : "";
    input = `<input type="${f.type || "text"}" name="${f.name}" value="${esc(v)}" ${req} ${extra} ${list} placeholder="${esc(f.placeholder || "")}">`;
    if (f.datalist) input += `<datalist id="dl-${f.name}">${f.datalist.map((o) => `<option value="${esc(o)}">`).join("")}</datalist>`;
    // Mobile date pickers (iOS in particular) can't erase a date, so optional dates get a clear button.
    if (f.type === "date" && !f.required) {
      input = `<div class="date-wrap">${input}<button type="button" class="icon-btn" data-clear-date="${f.name}" title="${esc(t("common.clear"))}" aria-label="${esc(t("common.clear"))}">✕</button></div>`;
    }
  }
  return `<label class="field" data-field="${f.name}" ${f.hidden ? "hidden" : ""}><span>${esc(f.label)}</span>${input}</label>`;
}

function closeModal() {
  $("#modal").hidden = true;
}
$("#modal-cancel").onclick = closeModal;
$("#modal").addEventListener("click", (e) => e.target.id === "modal" && closeModal());
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("#dialog").hidden) $("#dialog").cancel(); // the dialog sits on top of the form
  else closeModal();
});

// In-app replacement for confirm()/prompt(): the HA companion apps silently answer "no" to native dialogs.
// Resolves to true/false for a question, or to the entered text (null when cancelled) for an input.
function askDialog({ text, input = null, okLabel, danger = false }) {
  return new Promise((resolve) => {
    const dlg = $("#dialog");
    const form = $("#dialog-form");
    const field = $("#dialog-input");
    const ok = $("#dialog-ok");
    $("#dialog-text").textContent = text;
    field.hidden = input === null;
    field.value = input ?? "";
    ok.textContent = okLabel || (input === null ? t("common.yes") : t("common.save"));
    ok.classList.toggle("danger-fill", danger);
    const done = (value) => {
      dlg.hidden = true;
      form.onsubmit = dlg.onclick = $("#dialog-cancel").onclick = null;
      resolve(value);
    };
    const cancel = () => done(input === null ? false : null);
    dlg.cancel = cancel;
    form.onsubmit = (e) => { e.preventDefault(); done(input === null ? true : field.value); };
    $("#dialog-cancel").onclick = cancel;
    // Block body on purpose: an onclick handler that returns false cancels the click (and the OK submit).
    dlg.onclick = (e) => { if (e.target === dlg) cancel(); };
    dlg.hidden = false;
    setTimeout(() => (input === null ? ok : field).focus(), 30);
  });
}
const askConfirm = (text, okLabel, danger = false) => askDialog({ text, okLabel, danger });
const askText = (text, value = "") => askDialog({ text, input: value });

const residentOptions = (withEmpty = true) => [...(withEmpty ? [["", t("common.not_set")]] : []), ...db.residents.map((r) => [r.id, r.name])];
const methodOptions = () => [["", t("common.not_set")], ...db.settings.payment_methods.map((m) => [m, m])];

// --- expense model ---------------------------------------------------------
function expenses() {
  const plans = Object.fromEntries(db.plans.map((p) => [p.id, p]));
  const home = db.plan_items
    .filter((i) => i.status === "bought")
    .map((i) => ({
      kind: "home",
      date: i.bought_at || (i.updated_at || i.created_at || "").slice(0, 10),
      amount: itemTotal(i),
      payer_id: i.payer_id,
      method: i.payment_method,
      category: plans[i.plan_id]?.room || t("plans.no_room"),
      title: i.name,
    }));
  const groceries = db.trips.map((tr) => ({
    kind: "groceries",
    date: tr.date,
    amount: num(tr.total),
    payer_id: tr.payer_id,
    method: tr.payment_method,
    category: kindName("groceries"),
    store: tr.store || t("groceries.no_store"),
    title: tr.store ? t("groceries.trip_title", { store: tr.store }) : kindName("groceries"),
  }));
  const cars = Object.fromEntries(db.cars.map((c) => [c.id, c]));
  const car = db.car_expenses.map((x) => ({
    kind: "car",
    date: x.date,
    amount: num(x.amount),
    payer_id: x.payer_id,
    method: x.payment_method,
    category: x.category || t("common.other"),
    car_id: x.car_id,
    title: `${x.category || kindName("car")} — ${carName(cars[x.car_id])}`,
  }));
  const bills = db.payments.map((p) => ({
    kind: "bills",
    date: p.date,
    amount: num(p.amount),
    payer_id: p.payer_id,
    method: p.payment_method,
    category: p.category || t("common.other"),
    title: p.name,
  }));
  return [...home, ...groceries, ...car, ...bills].sort((a, b) => (a.date < b.date ? 1 : -1));
}

const carName = (c) => (c ? c.name + (c.plate ? ` (${c.plate})` : "") : t("cars.unnamed"));
const sumAmount = (list) => list.reduce((s, e) => s + e.amount, 0);

function docStatus(date) {
  if (!date) return null;
  const days = Math.round((new Date(date) - new Date(today())) / 86400000);
  return { days, cls: days < 0 ? "expired" : days <= 30 ? "soon" : "ok" };
}

function carReminders() {
  const out = [];
  for (const c of db.cars) for (const key of CAR_DOCS) {
    const st = docStatus(c[key]);
    if (st && st.cls !== "ok") out.push({ car: c, label: carDocName(key), date: c[key], ...st });
  }
  return out.sort((a, b) => a.days - b.days);
}

function periodStart(period) {
  const d = new Date();
  if (period === "month") return new Date(d.getFullYear(), d.getMonth(), 1);
  if (period === "3m") return new Date(d.getFullYear(), d.getMonth() - 2, 1);
  if (period === "year") return new Date(d.getFullYear(), d.getMonth() - 11, 1);
  return null;
}
const inPeriod = (date, period) => {
  const start = periodStart(period);
  return !start || date >= start.toISOString().slice(0, 10);
};

function sumBy(list, keyFn) {
  const map = new Map();
  for (const x of list) {
    const k = keyFn(x) || "—";
    map.set(k, (map.get(k) || 0) + x.amount);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

// Rankings without their own colour code use the single accent: colour only where it means something.
function barsHtml(entries, colorFn = () => "var(--accent)", labelFn = (k) => esc(k)) {
  if (!entries.length) return `<div class="empty small">${t("common.no_data")}</div>`;
  const max = Math.max(...entries.map((e) => e[1])) || 1;
  const total = entries.reduce((s, e) => s + e[1], 0) || 1;
  return `<div class="bars">${entries
    .map(([k, v], i) => {
      const c = colorFn(k, i);
      return `<div class="bar-row"><div class="lbl" title="${esc(k)}">${labelFn(k, c)}</div>
        <div class="bar-track"><div style="width:${(v / max) * 100}%;background:${c}"></div></div>
        <div class="num small">${money(v)} <span class="muted">${Math.round((v / total) * 100)}%</span></div></div>`;
    })
    .join("")}</div>`;
}

function monthlyColumns(list, months = 12) {
  const keys = lastMonths(months);
  const kinds = Object.keys(KINDS);
  const data = keys.map((k) => {
    const items = list.filter((e) => monthKey(e.date) === k);
    const byKind = Object.fromEntries(kinds.map((kind) => [kind, sumAmount(items.filter((e) => e.kind === kind))]));
    return { k, byKind, tot: sumAmount(items) };
  });
  const max = Math.max(...data.map((d) => d.tot)) || 1;
  return `<div class="cols">${data
    .map((d) => {
      const tip = `${monthLabel(d.k, true)}: ${money(d.tot)}\n` +
        kinds.filter((k) => d.byKind[k]).map((k) => `${kindName(k)}: ${money(d.byKind[k])}`).join("\n");
      return `<div class="col" title="${esc(tip)}">
        <div class="val">${d.tot ? compactMoney(d.tot) : ""}</div>
        <div class="stack" style="height:${(d.tot / max) * 140}px">
          ${kinds.map((k) => `<div style="height:${d.tot ? (d.byKind[k] / d.tot) * 100 : 0}%;background:${KINDS[k].color}"></div>`).join("")}
        </div>
        <div class="cap">${monthLabel(d.k)}</div></div>`;
    })
    .join("")}</div>
    <div class="legend">${kinds.map((k) => `<span><i class="dot" style="background:${KINDS[k].color}"></i>${kindName(k)}</span>`).join("")}</div>`;
}


function lastMonths(n) {
  const now = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (n - 1 - i), 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
}

function budgetBar(spent, budget) {
  if (!budget) return `<div class="sub">${t("budget.not_set")}</div>`;
  const pct = (spent / budget) * 100;
  return `<div class="progress ${pct > 100 ? "over" : ""}" style="margin-top:8px"><div style="width:${Math.min(pct, 100)}%"></div></div>
    <div class="sub">${t("budget.of", { pct: Math.round(pct), total: money(budget) })} · ${pct > 100 ? t("budget.over", { amount: money(spent - budget) }) : t("budget.left", { amount: money(budget - spent) })}</div>`;
}

// --- views -----------------------------------------------------------------
const views = { overview, plans, groceries, cars, bills, expenses: expensesView, stats, settings };

function render() {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  const root = $("#view");
  root.onclick = root.onchange = null;
  root.innerHTML = views[view]();
  bind[view]?.();
  const me = meId() && resident(meId());
  $("#me").innerHTML = me ? `${avatar(me, "mini-ava")}<span>${esc(me.name)}</span>` : "";
}

$("#tabs").addEventListener("click", (e) => {
  const v = e.target.closest("button")?.dataset.view;
  if (!v) return;
  view = v;
  localStorage.setItem("hb.view", v);
  render();
  window.scrollTo(0, 0);
});

// Overview ------------------------------------------------------------------
function overview() {
  const ex = expenses();
  const month = ex.filter((e) => inPeriod(e.date, "month"));
  const home = sumAmount(month.filter((e) => e.kind === "home"));
  const groc = sumAmount(month.filter((e) => e.kind === "groceries"));
  const car = sumAmount(month.filter((e) => e.kind === "car"));
  const billsSum = sumAmount(month.filter((e) => e.kind === "bills"));
  const reminders = carReminders();
  const dueSoon = db.recurring.filter((r) => r.next_due && !r.auto && daysUntil(r.next_due) <= 7)
    .sort((a, b) => (a.next_due < b.next_due ? -1 : 1));
  const planned = db.plan_items.filter((i) => i.status !== "bought");
  const plannedSum = planned.reduce((s, i) => s + itemTotal(i), 0);
  const activePlans = db.plans.filter((p) => p.status !== "done");

  const noResidents = !db.residents.length
    ? `<div class="card row"><div class="grow">${t("overview.no_residents")}</div><span class="spacer"></span>
       <button class="btn primary" data-goto="settings">${t("overview.add_residents")}</button></div>`
    : "";
  const kpi = (kind, value, budget) => `<div class="card kpi"><div class="label">${kindDot(kind)}${t("overview.kind_month", { kind: kindName(kind) })}</div><div class="value num">${money(value)}</div>
        ${budgetBar(value, budget)}</div>`;

  return `
    ${noResidents}
    ${reminders.length ? `<div class="card callout warn" style="margin-bottom:12px"><div class="row"><h3>${t("overview.car_docs")}</h3><span class="spacer"></span>
        <button class="btn sm" data-goto="cars">${t("common.open")}</button></div>
      <ul class="list">${reminders.map((r) => `<li><div class="grow">${esc(r.label)} — ${esc(carName(r.car))}</div>
        <span class="doc ${r.cls}">${r.days < 0 ? t("due.overdue") : r.days === 0 ? t("due.today") : t("due.in_days", { n: r.days })} · ${fmtDate(r.date)}</span></li>`).join("")}</ul></div>` : ""}
    ${dueSoon.length ? `<div class="card callout" style="margin-bottom:12px"><div class="row"><h3>${t("overview.bills_this_week")}</h3><span class="spacer"></span>
        <button class="btn sm" data-goto="bills">${t("bills.all")}</button></div>
      <ul class="list due-list">${dueSoon.map(dueRow).join("")}</ul></div>` : ""}
    <div class="grid kpi" style="margin-top:${noResidents ? 12 : 0}px">
      <div class="card kpi"><div class="label">${t("overview.month_total")}</div><div class="value num">${money(home + groc + car + billsSum)}</div>
        <div class="sub">${t("common.transactions", { n: month.length })}</div></div>
      ${kpi("groceries", groc, db.settings.budget_groceries)}
      ${kpi("home", home, db.settings.budget_home)}
      ${kpi("car", car, db.settings.budget_car)}
      ${kpi("bills", billsSum, db.settings.budget_bills)}
    </div>

    <div class="grid two" style="margin-top:12px">
      <div class="card">
        <div class="row"><h3>${t("groceries.list_title")}</h3><span class="spacer"></span><button class="btn sm" data-goto="groceries">${t("common.open")}</button></div>
        ${db.groceries.length
          ? `<div class="row">${db.groceries.slice(0, 18).map((g) => `<span class="chip">${esc(g.name)}${g.qty ? ` · ${esc(g.qty)}` : ""}</span>`).join("")}
             ${db.groceries.length > 18 ? `<span class="muted small">${t("common.and_more", { n: db.groceries.length - 18 })}</span>` : ""}</div>`
          : `<div class="empty small">${t("groceries.list_empty")}</div>`}
      </div>
      <div class="card">
        <div class="row"><h3>${t("overview.active_plans")}</h3><span class="spacer"></span><button class="btn sm" data-goto="plans">${t("overview.all_plans")}</button></div>
        <div class="muted small" style="margin:-4px 0 10px">${t("plans.left_to_buy")}: <b class="num" style="color:var(--text)">${money(plannedSum)}</b> · ${t("common.items", { n: planned.length })}</div>
        ${activePlans.length
          ? `<ul class="list">${activePlans.slice(0, 6).map((p) => {
              const items = db.plan_items.filter((i) => i.plan_id === p.id);
              const total = items.reduce((s, i) => s + itemTotal(i), 0);
              const done = items.filter((i) => i.status === "bought").reduce((s, i) => s + itemTotal(i), 0);
              return `<li><div class="grow"><div class="title">${esc(p.title)}</div>
                <div class="progress" style="margin-top:4px"><div style="width:${total ? (done / total) * 100 : 0}%"></div></div></div>
                <span class="badge ${p.status}">${planStatusName(p.status)}</span><span class="num small">${money(total)}</span></li>`;
            }).join("")}</ul>`
          : `<div class="empty small">${t("overview.no_active_plans")}</div>`}
      </div>
    </div>

    <div class="card" style="margin-top:12px">
      <h3>${t("overview.recent")}</h3>
      ${ex.length
        ? `<ul class="list">${ex.slice(0, 8).map((e) => `<li><span class="dot" style="background:${KIND_COLORS[e.kind]}"></span>
            <div class="grow"><div class="title">${esc(e.title)}</div><div class="muted small">${fmtDate(e.date)} · ${esc(e.method || t("common.method_not_set"))}</div></div>
            ${residentChip(e.payer_id)}<span class="num">${money(e.amount)}</span></li>`).join("")}</ul>`
        : `<div class="empty small">${t("overview.no_expenses")}</div>`}
    </div>`;
}

// Plans ---------------------------------------------------------------------
function plans() {
  const f = ui.planFilter;
  const list = db.plans
    .filter((p) => (!f.room || p.room === f.room) && (!f.status || p.status === f.status))
    .sort((a, b) => (a.status === "done") - (b.status === "done") || PRIORITY.indexOf(a.priority) - PRIORITY.indexOf(b.priority));

  const allItems = db.plan_items;
  const planned = allItems.filter((i) => i.status !== "bought").reduce((s, i) => s + itemTotal(i), 0);
  const bought = allItems.filter((i) => i.status === "bought").reduce((s, i) => s + itemTotal(i), 0);
  const rooms = [...new Set([...db.settings.rooms, ...db.plans.map((p) => p.room).filter(Boolean)])];

  return `
    <div class="row"><h2>${t("plans.title")}</h2><span class="spacer"></span>
      <button class="btn primary" id="add-plan">＋ ${t("plans.new")}</button></div>
    <div class="grid kpi" style="margin-bottom:12px">
      <div class="card kpi"><div class="label">${t("plans.left_to_buy")}</div><div class="value num">${money(planned)}</div></div>
      <div class="card kpi"><div class="label">${t("plans.bought_total")}</div><div class="value num">${money(bought)}</div></div>
      <div class="card kpi wide"><div class="label">${t("plans.who_pays")}</div>
        <div style="margin-top:6px">${sumBy(allItems.filter((i) => i.status !== "bought").map((i) => ({ ...i, amount: itemTotal(i) })), (i) => i.payer_id)
          .map(([id, v]) => `<div class="row small" style="flex-wrap:nowrap">${id === "—" ? `<span class="muted">${t("common.unassigned")}</span>` : residentChip(id)}<span class="spacer"></span><span class="num">${money(v)}</span></div>`).join("") || '<span class="muted small">—</span>'}</div></div>
    </div>
    <div class="row filters">
      <select id="f-room"><option value="">${t("plans.all_rooms")}</option>${rooms.map((r) => `<option ${r === f.room ? "selected" : ""}>${esc(r)}</option>`).join("")}</select>
      <select id="f-status"><option value="">${t("plans.all_statuses")}</option>${PLAN_STATUS.map((k) => `<option value="${k}" ${k === f.status ? "selected" : ""}>${planStatusName(k)}</option>`).join("")}</select>
    </div>
    ${list.length ? list.map(planCard).join("") : `<div class="card empty">${t("plans.empty")}</div>`}`;
}

function planCard(p) {
  const items = db.plan_items.filter((i) => i.plan_id === p.id);
  const total = items.reduce((s, i) => s + itemTotal(i), 0);
  const done = items.filter((i) => i.status === "bought").reduce((s, i) => s + itemTotal(i), 0);
  return `<div class="card" data-plan="${p.id}">
    <div class="plan-head">
      <div class="grow">
        <div class="row"><h3>${esc(p.title)}</h3><span class="badge ${p.status}">${planStatusName(p.status)}</span>
          ${p.priority === "high" ? `<span class="badge urgent">${t("plans.important")}</span>` : ""}</div>
        <div class="muted small">${[p.room, p.deadline ? t("plans.deadline", { date: fmtDate(p.deadline) }) : "", p.note].filter(Boolean).map(esc).join(" · ")}</div>
      </div>
      <div class="plan-sum"><div class="big num">${money(total)}</div><div class="muted small num">${t("plans.bought_amount", { amount: money(done) })}</div></div>
      <button class="icon-btn" data-edit-plan="${p.id}" title="${esc(t("common.edit"))}">✎</button>
    </div>
    <div class="progress" style="margin:10px 0"><div style="width:${total ? (done / total) * 100 : 0}%"></div></div>
    ${items.length ? `<table class="items"><thead><tr><th></th><th>${t("plans.item_name")}</th><th class="r">${t("plans.price")}</th><th>${t("plans.payer_method")}</th><th></th></tr></thead><tbody>
      ${items.map((i) => `<tr class="${i.status === "bought" ? "bought" : ""}">
        <td><input type="checkbox" data-toggle-item="${i.id}" ${i.status === "bought" ? "checked" : ""} title="${esc(t("plans.bought"))}"></td>
        <td class="name">${i.link ? `<a href="${esc(i.link)}" target="_blank" rel="noopener">${esc(i.name)}</a>` : esc(i.name)}
          ${num(i.qty) > 1 ? `<span class="muted small">× ${i.qty}</span>` : ""}</td>
        <td class="r num price">${money(itemTotal(i))}</td>
        <td class="meta"><div class="row">${residentChip(i.payer_id)}${i.payment_method ? `<span class="muted small">${esc(i.payment_method)}</span>` : ""}
          ${i.status === "bought" && i.bought_at ? `<span class="muted small">· ${fmtDate(i.bought_at)}</span>` : ""}</div></td>
        <td class="r act"><button class="icon-btn" data-edit-item="${i.id}" title="${esc(t("common.edit"))}">✎</button></td></tr>`).join("")}
      </tbody></table>` : `<div class="muted small">${t("plans.no_items")}</div>`}
    <div style="margin-top:8px"><button class="btn sm ghost" data-add-item="${p.id}">＋ ${t("plans.add_item")}</button></div>
  </div>`;
}

function planForm(p = {}) {
  openForm({
    title: p.id ? t("plans.edit") : t("plans.new"),
    fields: [
      { name: "title", label: t("form.name"), value: p.title, required: true, placeholder: t("plans.title_placeholder") },
      { type: "row", fields: [
        { name: "room", label: t("plans.room"), value: p.room, datalist: db.settings.rooms },
        { name: "status", label: t("form.status"), type: "select", value: p.status || "planned", options: PLAN_STATUS.map((s) => [s, planStatusName(s)]) },
      ] },
      { type: "row", fields: [
        { name: "priority", label: t("plans.priority"), type: "select", value: p.priority || "medium", options: PRIORITY.map((k) => [k, t("priority." + k)]) },
        { name: "deadline", label: t("plans.deadline_label"), type: "date", value: p.deadline },
      ] },
      { name: "note", label: t("form.note"), type: "textarea", value: p.note },
    ],
    onSubmit: (v) => (p.id ? mutate("PUT", `plans/${p.id}`, v) : mutate("POST", "plans", v, t("plans.created"))),
    onDelete: p.id ? () => mutate("DELETE", `plans/${p.id}`, null, t("plans.deleted")) : null,
  });
}

function itemForm(planId, i = {}) {
  openForm({
    title: i.id ? t("plans.edit_item") : t("plans.add_item"),
    fields: [
      { name: "name", label: t("plans.item_name"), value: i.name, required: true, placeholder: t("plans.item_placeholder") },
      { type: "row", fields: [
        { name: "price", label: t("plans.unit_price", { currency: db.settings.currency }), type: "number", value: i.price, required: true },
        { name: "qty", label: t("form.qty"), type: "number", step: "1", value: i.qty || 1 },
      ] },
      { type: "row", fields: [
        { name: "payer_id", label: t("plans.payer"), type: "select", value: i.id ? i.payer_id : meId(), options: residentOptions() },
        { name: "payment_method", label: t("form.payment_method"), type: "select", value: i.payment_method, options: methodOptions() },
      ] },
      { type: "row", fields: [
        { name: "status", label: t("form.status"), type: "select", value: i.status || "planned", options: [["planned", t("plans.item_planned")], ["bought", t("plans.bought")]] },
        { name: "bought_at", label: t("plans.bought_at"), type: "date", value: i.bought_at },
      ] },
      { name: "link", label: t("plans.link"), type: "url", value: i.link, placeholder: "https://…" },
    ],
    onSubmit: (v) => {
      if (v.status === "bought" && !v.bought_at) v.bought_at = today();
      if (v.status !== "bought") v.bought_at = "";
      return i.id ? mutate("PUT", `plan_items/${i.id}`, v) : mutate("POST", "plan_items", { ...v, plan_id: planId }, t("common.added"));
    },
    onDelete: i.id ? () => mutate("DELETE", `plan_items/${i.id}`) : null,
  });
}

// Groceries -----------------------------------------------------------------
function groceryCategories() {
  return [...new Set([...db.settings.grocery_categories, ...db.groceries.map((g) => g.category).filter(Boolean)])];
}

function groupByCategory(list) {
  const cats = groceryCategories();
  const groups = new Map();
  for (const g of list) {
    const c = g.category || t("common.other");
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(g);
  }
  return [...groups.entries()].sort((a, b) => cats.indexOf(a[0]) - cats.indexOf(b[0]));
}

// Favourites first, then the most frequently bought products that weren't hidden.
function suggestions() {
  const lower = (x) => x.trim().toLowerCase();
  const inList = new Set(db.groceries.map((g) => lower(g.name)));
  const hidden = new Set(db.settings.hidden_products.map(lower));
  const favs = db.settings.favorite_products.filter((n) => !inList.has(lower(n)));
  const favSet = new Set(favs.map(lower));
  const freq = new Map();
  for (const tr of db.trips) for (const it of tr.items) {
    const k = it.name.trim();
    if (inList.has(lower(k)) || hidden.has(lower(k)) || favSet.has(lower(k))) continue;
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  const auto = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  return [...favs.map((name) => ({ name, fav: true })), ...auto.slice(0, Math.max(0, 14 - favs.length)).map((name) => ({ name }))]
    .map((s) => ({ ...s, category: lastCategory(s.name) }));
}

function lastCategory(name) {
  const n = name.trim().toLowerCase();
  return db.trips.flatMap((tr) => tr.items).reverse().find((i) => i.name.trim().toLowerCase() === n)?.category || t("common.other");
}

const storesDatalist = () => `<datalist id="dl-stores">${db.settings.stores.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>`;

function groceries() {
  if (ui.shopping) return shoppingMode();
  const groups = groupByCategory(db.groceries);
  const sug = suggestions();
  const trips = [...db.trips].sort((a, b) => (a.date < b.date ? 1 : -1));
  const s = db.settings;
  const alice = t("todo.alice");
  return `
    <div class="row"><h2>${t("groceries.list_title")}</h2><span class="spacer"></span>
      ${s.todo_entity
        ? `<button class="btn big" id="todo-sync" title="${esc(t(s.yandex_station ? "groceries.synced_with_alice" : "groceries.synced_with", { entity: s.todo_entity }))}">⇄ ${esc(s.yandex_station ? t("groceries.sync_alice") : t("todo.sync_now"))}</button>` : ""}
      <button class="btn primary big" id="start-shop" ${db.groceries.length ? "" : "disabled"}>${t("groceries.start_shopping")}</button></div>
    <div class="card">
      <form class="add-bar" id="add-grocery">
        <input name="name" placeholder="${esc(t("groceries.add_placeholder"))}" required list="dl-gnames">
        <input name="qty" placeholder="${esc(t("groceries.qty_short"))}">
        <select name="category"><option value="">${t("groceries.category_auto")}</option>${groceryCategories().map((c) => `<option>${esc(c)}</option>`).join("")}</select>
        <button class="btn primary">${t("common.add")}</button>
        <datalist id="dl-gnames">${[...new Set(db.trips.flatMap((tr) => tr.items.map((i) => i.name)))].map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
      </form>
      ${sug.length ? `<div class="suggest"><span class="muted small">${t("groceries.frequent")}</span>${sug.map((x) => `<span class="sug ${x.fav ? "fav" : ""}">
          <button data-sug="${esc(x.name)}" data-cat="${esc(x.category)}">${x.fav ? "★" : "＋"} ${esc(x.name)}</button><button class="x" data-hide-sug="${esc(x.name)}" data-fav="${x.fav ? 1 : ""}" title="${esc(x.fav ? t("groceries.unfavorite") : t("groceries.hide_suggestion"))}">✕</button></span>`).join("")}
          <button class="link" data-goto="settings">${t("groceries.customize")}</button></div>` : ""}
      ${groups.length
        ? groups.map(([cat, items]) => `<div class="cat-title">${esc(cat)}</div><ul class="list">${items.map((g) => `<li>
            <div class="grow"><span class="title">${esc(g.name)}</span>${g.qty ? ` <span class="muted small">· ${esc(g.qty)}</span>` : ""}</div>
            ${g.added_by ? residentChip(g.added_by) : g.source === "todo" ? `<span class="badge">${s.yandex_station ? esc(alice) : "HA"}</span>` : ""}
            <button class="icon-btn" data-edit-grocery="${g.id}" title="${esc(t("common.change"))}">✎</button>
            <button class="icon-btn" data-del-grocery="${g.id}" title="${esc(t("common.remove"))}">✕</button></li>`).join("")}</ul>`).join("")
        : `<div class="empty">${t("groceries.empty")}</div>`}
    </div>

    <div class="card">
      <h3>${t("groceries.history")}</h3>
      ${trips.length ? `<ul class="list">${trips.slice(0, 30).map((tr) => `<li style="align-items:flex-start">
          <div class="grow"><div class="title">${fmtDate(tr.date)}${tr.store ? " · " + esc(tr.store) : ""}</div>
          <div class="muted small">${tr.items.map((i) => esc(i.name)).join(", ")}${tr.skipped ? ` · <i>${t("groceries.skipped", { n: tr.skipped })}</i>` : ""}</div></div>
          <div style="text-align:right"><div class="num"><b>${money(tr.total)}</b></div><div class="row" style="justify-content:flex-end">${residentChip(tr.payer_id)}</div>
          <div class="muted small">${esc(tr.payment_method || "")}</div></div>
          <button class="icon-btn" data-edit-trip="${tr.id}" title="${esc(t("common.change"))}">✎</button></li>`).join("")}</ul>`
        : `<div class="empty small">${t("groceries.no_trips")}</div>`}
    </div>`;
}

function shoppingMode() {
  const checked = new Set(ui.shopping.checked);
  const groups = groupByCategory(db.groceries);
  const n = db.groceries.filter((g) => checked.has(g.id)).length;
  const s = ui.shopping;
  return `
    <div class="row"><h2>${t("shop.title")}</h2><span class="spacer"></span>
      <button class="btn ghost" id="cancel-shop">${t("shop.exit")}</button></div>
    <div class="card">
      <div class="muted small">${t("shop.hint")}</div>
      ${groups.map(([cat, items]) => `<div class="cat-title">${esc(cat)}</div><ul class="list shop">${items.map((g) => `
        <li data-check="${g.id}" class="${checked.has(g.id) ? "on" : ""}"><span class="check">✓</span>
          <div class="grow"><span class="title">${esc(g.name)}</span>${g.qty ? ` <span class="muted small">· ${esc(g.qty)}</span>` : ""}</div></li>`).join("")}</ul>`).join("")}
      <form class="shop-footer" id="checkout">
        <div class="fields">
          <label class="field"><span>${esc(t("shop.receipt_total_currency", { currency: db.settings.currency }))}</span><input name="total" type="number" step="any" min="0" inputmode="decimal" required value="${esc(s.total || "")}"></label>
          <label class="field"><span>${t("shop.store")}</span><input name="store" list="dl-stores" value="${esc(s.store || "")}">${storesDatalist()}</label>
          <label class="field"><span>${t("form.paid_by")}</span><select name="payer_id">${residentOptions().map(([v, l]) => `<option value="${v}" ${v === (s.payer_id ?? (meId() || lastTrip()?.payer_id)) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
          <label class="field"><span>${t("form.payment_method")}</span><select name="payment_method">${methodOptions().map(([v, l]) => `<option value="${esc(v)}" ${v === (s.payment_method ?? lastTrip()?.payment_method) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
        </div>
        <button class="btn primary big" style="width:100%" ${n ? "" : "disabled"}>${t("shop.finish", { n, total: db.groceries.length })}</button>
      </form>
    </div>`;
}

const lastTrip = () => [...db.trips].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
const saveShopping = () => localStorage.setItem("hb.shopping", JSON.stringify(ui.shopping));

function tripForm(tr) {
  openForm({
    title: t("groceries.trip_form_title", { date: fmtDate(tr.date) }),
    fields: [
      { type: "row", fields: [
        { name: "date", label: t("form.date"), type: "date", value: tr.date, required: true },
        { name: "total", label: t("shop.receipt_total"), type: "number", value: tr.total, required: true },
      ] },
      { name: "store", label: t("shop.store"), value: tr.store, datalist: db.settings.stores },
      { type: "row", fields: [
        { name: "payer_id", label: t("form.paid_by"), type: "select", value: tr.payer_id, options: residentOptions() },
        { name: "payment_method", label: t("form.payment_method"), type: "select", value: tr.payment_method, options: methodOptions() },
      ] },
    ],
    onSubmit: (v) => mutate("PUT", `trips/${tr.id}`, v),
    onDelete: () => mutate("DELETE", `trips/${tr.id}`, null, t("groceries.trip_deleted")),
  });
}

// Cars ----------------------------------------------------------------------
function cars() {
  const carEx = expenses().filter((e) => e.kind === "car");
  const month = carEx.filter((e) => inPeriod(e.date, "month"));
  const year = carEx.filter((e) => inPeriod(e.date, "year"));
  return `
    <div class="row"><h2>${t("cars.title")}</h2><span class="spacer"></span>
      <button class="btn" id="add-car-expense" ${db.cars.length ? "" : "disabled"}>＋ ${t("cars.add_expense_short")}</button>
      <button class="btn primary" id="add-car">＋ ${t("cars.add_car")}</button></div>
    <div class="grid kpi" style="margin-bottom:12px">
      <div class="card kpi"><div class="label">${t("overview.kind_month", { kind: kindName("car") })}</div><div class="value num">${money(sumAmount(month))}</div>
        ${budgetBar(sumAmount(month), db.settings.budget_car)}</div>
      <div class="card kpi"><div class="label">${t("cars.last_12m")}</div><div class="value num">${money(sumAmount(year))}</div>
        <div class="sub">${t("cars.per_month", { amount: money(sumAmount(year) / 12) })}</div></div>
      <div class="card kpi wide"><div class="label">${t("cars.month_by_category")}</div>
        <div style="margin-top:6px">${sumBy(month, (e) => e.category).slice(0, 4)
          .map(([k, v]) => `<div class="row small" style="flex-wrap:nowrap"><span>${esc(k)}</span><span class="spacer"></span><span class="num">${money(v)}</span></div>`).join("") || '<span class="muted small">—</span>'}</div></div>
    </div>
    ${db.cars.length ? db.cars.map((c) => carCard(c, carEx)).join("") : `<div class="card empty">${t("cars.empty")}</div>`}`;
}

function carCard(c, carEx) {
  const list = db.car_expenses.filter((x) => x.car_id === c.id).sort((a, b) => (a.date < b.date ? 1 : -1));
  const mine = carEx.filter((e) => e.car_id === c.id);
  const expanded = ui.carsExpanded.has(c.id);
  const shown = expanded ? list : list.slice(0, 5);
  const docs = CAR_DOCS.filter((k) => c[k]).map((k) => {
    const st = docStatus(c[k]);
    return `<span class="doc ${st.cls}" title="${esc(st.days < 0 ? t("due.expired") : t("due.days_left", { n: st.days }))}">${t("cars.doc_until", { doc: carDocName(k), date: fmtDate(c[k]) })}</span>`;
  });
  const reg = [
    c.vin && `VIN ${esc(c.vin)}`,
    c.sts && esc(t("cars.sts_value", { v: c.sts })),
    c.registered_at && esc(t("cars.registered_since", { date: fmtDate(c.registered_at) })),
    c.mileage && esc(t("cars.mileage_value", { km: fmtNumber(c.mileage) })),
  ].filter(Boolean);
  return `<div class="card">
    <div class="plan-head">
      <div class="avatar" style="background:${c.color || "#6b7686"}"><svg viewBox="0 0 24 24"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/></svg></div>
      <div class="grow">
        <div class="row"><h3>${esc(c.name)}${c.year ? ` <span class="muted small">${esc(c.year)}</span>` : ""}</h3>
          ${c.plate ? `<span class="plate">${esc(c.plate)}</span>` : ""}${c.owner_id ? residentChip(c.owner_id) : ""}</div>
        <div class="muted small">${reg.join(" · ")}</div>
      </div>
      <div class="plan-sum"><div class="big num">${money(sumAmount(mine.filter((e) => inPeriod(e.date, "month"))))}</div>
        <div class="muted small num">${t("cars.month_total", { amount: money(sumAmount(mine)) })}</div></div>
      <button class="icon-btn" data-edit-car="${c.id}" title="${esc(t("common.edit"))}">✎</button>
    </div>
    ${docs.length ? `<div class="row" style="margin-top:10px">${docs.join("")}</div>` : ""}
    ${list.length ? `<ul class="list" style="margin-top:8px">${shown.map((x) => `<li>
        <div class="grow"><div class="title">${esc(x.category || t("common.other"))}${x.note ? ` <span class="muted small">· ${esc(x.note)}</span>` : ""}</div>
        <div class="muted small">${fmtDate(x.date)}${x.mileage ? ` · ${t("unit.km", { v: fmtNumber(x.mileage) })}` : ""}${x.liters ? ` · ${t("unit.liters", { v: x.liters })}` : ""}${x.payment_method ? " · " + esc(x.payment_method) : ""}</div></div>
        ${residentChip(x.payer_id)}<span class="num">${money(x.amount)}</span>
        <button class="icon-btn" data-edit-cexp="${x.id}" title="${esc(t("common.change"))}">✎</button></li>`).join("")}</ul>
      ${list.length > 5 ? `<button class="btn sm ghost" data-expand-car="${c.id}">${expanded ? t("common.collapse") : t("common.show_all", { n: list.length })}</button>` : ""}`
      : `<div class="muted small" style="margin-top:8px">${t("cars.no_expenses")}</div>`}
    <div style="margin-top:8px"><button class="btn sm ghost" data-add-cexp="${c.id}">＋ ${t("cars.add_expense")}</button></div>
  </div>`;
}

function carForm(c = {}) {
  openForm({
    title: c.id ? t("cars.car") : t("cars.new"),
    fields: [
      { type: "row", fields: [
        { name: "name", label: t("cars.make_model"), value: c.name, required: true, placeholder: "Kia Rio" },
        { name: "year", label: t("cars.year"), type: "number", step: "1", value: c.year },
      ] },
      { type: "row", fields: [
        { name: "plate", label: t("cars.plate"), value: c.plate, placeholder: t("cars.plate_placeholder") },
        { name: "owner_id", label: t("cars.owner"), type: "select", value: c.owner_id, options: residentOptions() },
      ] },
      { name: "vin", label: "VIN", value: c.vin },
      { type: "row", fields: [
        { name: "sts", label: t("cars.sts"), value: c.sts },
        { name: "registered_at", label: t("cars.registered_at"), type: "date", value: c.registered_at },
      ] },
      { type: "row", fields: [
        { name: "osago_until", label: t("cars.osago_until"), type: "date", value: c.osago_until },
        { name: "kasko_until", label: t("cars.kasko_until"), type: "date", value: c.kasko_until },
      ] },
      { type: "row", fields: [
        { name: "inspection_until", label: t("cars.inspection_until"), type: "date", value: c.inspection_until },
        { name: "next_service_date", label: t("cars.next_service_date"), type: "date", value: c.next_service_date },
      ] },
      { type: "row", fields: [
        { name: "mileage", label: t("cars.mileage"), type: "number", step: "1", value: c.mileage },
        { name: "color", label: t("form.color"), type: "color", value: c.color || "#607d8b" },
      ] },
      { name: "note", label: t("form.note"), type: "textarea", value: c.note },
    ],
    onSubmit: (v) => (c.id ? mutate("PUT", `cars/${c.id}`, v) : mutate("POST", "cars", v, t("cars.added"))),
    onDelete: c.id ? () => mutate("DELETE", `cars/${c.id}`, null, t("cars.deleted")) : null,
  });
}

function carExpenseForm(x = {}) {
  const car = db.cars.find((c) => c.id === x.car_id);
  openForm({
    title: x.id ? t("cars.expense") : t("cars.new_expense"),
    fields: [
      { type: "row", fields: [
        { name: "car_id", label: t("cars.car"), type: "select", value: x.car_id, options: db.cars.map((c) => [c.id, carName(c)]) },
        { name: "category", label: t("form.category"), type: "select", value: x.category || db.settings.car_categories[0], options: db.settings.car_categories.map((k) => [k, k]) },
      ] },
      { type: "row", fields: [
        { name: "amount", label: t("form.amount_currency", { currency: db.settings.currency }), type: "number", value: x.amount, required: true },
        { name: "date", label: t("form.date"), type: "date", value: x.date || today(), required: true },
      ] },
      { type: "row", fields: [
        { name: "payer_id", label: t("form.paid_by"), type: "select", value: x.payer_id ?? (meId() || car?.owner_id), options: residentOptions() },
        { name: "payment_method", label: t("form.payment_method"), type: "select", value: x.payment_method, options: methodOptions() },
      ] },
      { type: "row", fields: [
        { name: "mileage", label: t("cars.mileage"), type: "number", step: "1", value: x.mileage },
        { name: "liters", label: t("cars.liters"), type: "number", value: x.liters },
      ] },
      { name: "note", label: t("form.comment"), value: x.note, placeholder: t("cars.expense_placeholder") },
    ],
    onSubmit: async (v) => {
      await (x.id ? mutate("PUT", `car_expenses/${x.id}`, v) : mutate("POST", "car_expenses", v, t("cars.expense_added")));
      // Keep the car's odometer at the highest mileage seen in its expenses.
      const target = db.cars.find((c) => c.id === v.car_id);
      if (target && num(v.mileage) > num(target.mileage)) await mutate("PUT", `cars/${target.id}`, { mileage: v.mileage });
    },
    onDelete: x.id ? () => mutate("DELETE", `car_expenses/${x.id}`) : null,
  });
}

// Bills (recurring payments) ------------------------------------------------
const FREQUENCIES = ["daily", "weekly", "monthly", "quarterly", "halfyear", "yearly", "once"];
const freqName = (f) => (FREQUENCIES.includes(f) ? t("freq." + f) : "");
// Share of a monthly budget; a one-time payment isn't a recurring cost.
const PER_MONTH = { daily: 365 / 12, weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, halfyear: 1 / 6, yearly: 1 / 12, once: 0 };

const daysUntil = (d) => Math.round((new Date(d) - new Date(today())) / 86400000);
const recurringById = (id) => db.recurring.find((r) => r.id === id);

function dueChip(date) {
  const days = daysUntil(date);
  const cls = days < 0 ? "expired" : days <= 3 ? "soon" : "ok";
  const text = days < 0 ? t("due.overdue_days", { n: -days }) : days === 0 ? t("due.today") : days === 1 ? t("due.tomorrow") : t("due.in_days", { n: days });
  return `<span class="doc ${cls}" title="${fmtDate(date)}">${text} · ${fmtDate(date)}</span>`;
}

// Without a first payment date there's no due date: show whether this calendar period is paid.
function periodChip(r) {
  const f = FREQUENCIES.includes(r.frequency) ? r.frequency : "monthly";
  return r.paid_this_period
    ? `<span class="doc ok">${t("bills.paid_period." + f)}</span>`
    : `<span class="doc">${t("bills.unpaid_period." + f)}</span>`;
}

// One row of an upcoming payment with its actions; shared by Overview and Bills.
// "Paid" works once per calendar period, so it's disabled until the next period starts.
function dueRow(r) {
  const f = FREQUENCIES.includes(r.frequency) ? r.frequency : "monthly";
  const pay = r.can_pay
    ? `<button class="btn sm primary" data-pay="${r.id}">${t("bills.mark_paid")}</button>`
    : `<button class="btn sm" disabled title="${esc(t("bills.paid_period." + f))}">${t("bills.mark_paid")}</button>`;
  const skip = r.scheduled && r.can_pay
    ? `<button class="btn sm ghost" data-skip="${r.id}" title="${esc(t("bills.skip_hint"))}">${t("bills.skip")}</button>` : "";
  const actions = r.auto
    ? `<span class="badge" title="${esc(t("bills.auto_hint"))}">${t("bills.auto_badge")}</span>`
    : pay + skip;
  return `<li><div class="grow"><div class="title">${esc(r.name)}</div>
      <div class="muted small">${esc(r.category || "")}${r.payer_id ? "" : " · " + t("bills.no_payer")}</div></div>
    ${r.payer_id ? residentChip(r.payer_id) : ""}
    <span class="num">${r.variable ? "≈ " : ""}${money(r.amount)}</span>${r.scheduled ? dueChip(r.next_due) : periodChip(r)}
    <span class="row" style="flex-wrap:nowrap">${actions}</span></li>`;
}

function bills() {
  const nowMonth = today().slice(0, 7);
  const active = db.recurring.filter((r) => !r.finished);
  const finished = db.recurring.filter((r) => r.finished);
  // Scheduled payments by due date, then unscheduled ones (unpaid first).
  const due = [...active].sort((a, b) =>
    (b.scheduled - a.scheduled) || (a.scheduled ? (a.next_due < b.next_due ? -1 : 1) : (a.paid_this_period - b.paid_this_period)));
  const leftThisMonth = active.filter((r) => r.scheduled
    ? r.next_due.slice(0, 7) <= nowMonth
    : ["daily", "weekly", "monthly"].includes(r.frequency || "monthly") && !r.paid_this_period);
  const paidThisMonth = db.payments.filter((p) => monthKey(p.date) === nowMonth);
  const perMonth = active.reduce((s, r) => s + num(r.amount) * (PER_MONTH[r.frequency] ?? 1), 0);
  const history = [...db.payments].sort((a, b) => (a.date < b.date ? 1 : -1));
  const groups = new Map(db.settings.bill_categories.map((c) => [c, []]));
  for (const r of active) {
    const c = r.category || t("common.other");
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(r);
  }
  const autoBadge = ` <span class="badge">${t("bills.auto_badge")}</span>`;
  const perMonthOf = (list) => list.reduce((sum, r) => sum + num(r.amount) * (PER_MONTH[r.frequency] ?? 1), 0);
  const filled = [...groups.entries()].filter(([, list]) => list.length);
  const empty = [...groups.entries()].filter(([, list]) => !list.length);

  return `
    <div class="row"><h2>${t("bills.title")}</h2><span class="spacer"></span>
      <button class="btn primary" id="add-recurring">＋ ${t("bills.add_short")}</button></div>
    <div class="grid kpi" style="margin-bottom:12px">
      <div class="card kpi"><div class="label">${t("bills.paid_this_month")}</div><div class="value num">${money(sumAmount(paidThisMonth.map((p) => ({ amount: num(p.amount) }))))}</div>
        ${budgetBar(sumAmount(paidThisMonth.map((p) => ({ amount: num(p.amount) }))), db.settings.budget_bills)}</div>
      <div class="card kpi"><div class="label">${t("bills.left_this_month")}</div><div class="value num">${money(leftThisMonth.reduce((s, r) => s + num(r.amount), 0))}</div>
        <div class="sub">${t("bills.count", { n: leftThisMonth.length })}${leftThisMonth.some((r) => r.scheduled && daysUntil(r.next_due) < 0) ? ` · <span style="color:var(--danger)">${t("bills.has_overdue")}</span>` : ""}</div></div>
      <div class="card kpi wide"><div class="label">${t("bills.fixed_per_month")}</div><div class="value num">${money(perMonth)}</div>
        <div class="sub">${t("bills.active_count", { n: active.length })}</div></div>
    </div>

    <div class="card"><h3>${t("bills.upcoming")}</h3>
      ${due.length ? `<ul class="list due-list">${due.slice(0, 12).map(dueRow).join("")}</ul>` : `<div class="empty">${t("bills.empty")}</div>`}
    </div>

    <div class="row" style="margin:24px 0 12px"><h3 style="margin:0">${t("bills.categories_title")}</h3><span class="spacer"></span>
      <button class="btn sm" id="add-bill-category">＋ ${t("bills.add_category")}</button>
      <button class="btn sm ghost" data-goto="settings">${t("bills.manage_categories")}</button></div>
    ${filled.length ? `<div class="grid cat-grid">${filled.map(([cat, list]) => `<div class="card">
      <div class="row"><h3>${esc(cat)}</h3><span class="spacer"></span>
        <button class="icon-btn" data-add-in="${esc(cat)}" title="${esc(t("bills.add_in", { category: cat }))}">＋</button></div>
      <div class="muted small" style="margin:-6px 0 6px">${perMonthOf(list) ? t("bills.category_summary", { n: list.length, amount: money(perMonthOf(list)) }) : t("bills.count", { n: list.length })}</div>
      <ul class="list">${list.map((r) => `<li>
        <div class="grow"><div class="title">${esc(r.name)}${r.auto ? autoBadge : ""}</div>
          <div class="muted small">${freqName(r.frequency)}${r.payment_method ? " · " + esc(r.payment_method) : ""}${r.end_date ? " · " + t("common.until", { date: fmtDate(r.end_date) }) : ""}${r.note ? " · " + esc(r.note) : ""}</div></div>
        ${residentChip(r.payer_id)}<span class="num">${r.variable ? "≈ " : ""}${money(r.amount)}</span>
        <button class="icon-btn" data-edit-recurring="${r.id}" title="${esc(t("common.edit"))}">✎</button></li>`).join("")}</ul></div>`).join("")}</div>` : ""}
    ${empty.length ? `<div class="suggest" style="margin:12px 0"><span class="muted small">${t("bills.empty_categories")}</span>
      ${empty.map(([cat]) => `<button data-add-in="${esc(cat)}" title="${esc(t("bills.add_in", { category: cat }))}">＋ ${esc(cat)}</button>`).join("")}</div>` : ""}
    ${finished.length ? `<div class="card" style="margin-top:12px"><div class="cat-title">${t("bills.finished")}</div><ul class="list">${finished.map((r) => `<li class="muted">
        <div class="grow">${esc(r.name)}</div><span class="num">${money(r.amount)}</span>
        <button class="icon-btn" data-edit-recurring="${r.id}" title="${esc(t("common.edit"))}">✎</button></li>`).join("")}</ul></div>` : ""}

    <div class="card"><h3>${t("bills.history")}</h3>
      ${history.length ? `<ul class="list">${history.slice(0, 30).map((p) => `<li>
        <div class="grow"><div class="title">${esc(p.name)}${p.auto ? autoBadge : ""}</div>
          <div class="muted small">${fmtDate(p.date)}${p.period && p.period !== p.date ? ` · ${t("bills.for_period", { date: fmtDate(p.period) })}` : ""}${p.payment_method ? " · " + esc(p.payment_method) : ""}${p.note ? " · " + esc(p.note) : ""}</div></div>
        ${residentChip(p.payer_id)}<span class="num">${money(p.amount)}</span>
        <button class="icon-btn" data-edit-payment="${p.id}" title="${esc(t("common.change"))}">✎</button></li>`).join("")}</ul>`
        : `<div class="empty small">${t("bills.no_payments")}</div>`}
    </div>`;
}

function recurringForm(r = {}) {
  openForm({
    title: r.id ? t("bills.recurring") : t("bills.new_recurring"),
    fields: [
      { name: "name", label: t("form.name"), value: r.name, required: true, placeholder: t("bills.name_placeholder") },
      { type: "row", fields: [
        { name: "category", label: t("form.category"), type: "select", value: r.category || db.settings.bill_categories[0],
          options: [...db.settings.bill_categories.map((c) => [c, c]), ["__new__", t("bills.new_category_option")]] },
        { name: "frequency", label: t("bills.frequency"), type: "select", value: r.frequency || "monthly", options: FREQUENCIES.map((f) => [f, freqName(f)]) },
      ] },
      { name: "category_new", label: t("bills.new_category_name"), hidden: true, placeholder: t("bills.category_placeholder") },
      { type: "row", fields: [
        { name: "amount", label: t("form.amount_currency", { currency: db.settings.currency }), type: "number", value: r.amount, required: true },
        { name: "variable", label: t("form.amount"), type: "select", value: r.variable ? "1" : "", options: [["", t("bills.amount_fixed")], ["1", t("bills.amount_variable")]] },
      ] },
      { type: "row", fields: [
        { name: "start_date", label: t("bills.start_date_optional"), type: "date", value: r.start_date || "" },
        { name: "end_date", label: t("bills.end_date"), type: "date", value: r.end_date, hidden: r.frequency === "once" },
      ] },
      { type: "row", fields: [
        { name: "payer_id", label: t("form.who_pays"), type: "select", value: r.id ? r.payer_id : meId(), options: residentOptions() },
        { name: "payment_method", label: t("form.payment_method"), type: "select", value: r.payment_method, options: methodOptions() },
      ] },
      { type: "row", fields: [
        { name: "auto", label: t("bills.marking"), type: "select", value: r.auto ? "1" : "", options: [["", t("bills.manual")], ["1", t("bills.automatic")]] },
        { name: "active", label: t("form.status"), type: "select", value: r.active === false ? "0" : "1", options: [["1", t("bills.active")], ["0", t("bills.disabled")]] },
      ] },
      { name: "note", label: t("form.note"), value: r.note, placeholder: t("bills.note_placeholder") },
    ],
    note: t("bills.no_schedule_hint"),
    onChange: (form, e) => {
      if (e.target.name === "frequency") {
        form.querySelector('[data-field="end_date"]').hidden = form.frequency.value === "once"; // nothing comes after a one-time payment
        return;
      }
      if (e.target.name !== "category") return;
      const box = form.querySelector('[data-field="category_new"]');
      box.hidden = form.category.value !== "__new__";
      if (!box.hidden) form.category_new.focus();
    },
    onSubmit: async (v) => {
      if (v.category === "__new__") {
        v.category = (v.category_new || "").trim();
        if (!v.category) {
          toast(t("bills.category_required"), true);
          throw new Error("category required"); // keeps the form open
        }
        await addBillCategory(v.category);
      }
      delete v.category_new;
      if (v.frequency === "once") v.end_date = "";
      if (v.auto === "1" && !v.start_date) {
        toast(t("bills.auto_needs_date"), true);
        throw new Error("auto needs a start date"); // keeps the form open
      }
      v.auto = v.auto === "1";
      v.variable = v.variable === "1";
      v.active = v.active !== "0";
      return r.id ? mutate("PUT", `recurring/${r.id}`, v) : mutate("POST", "recurring", v, t("bills.added"));
    },
    onDelete: r.id ? () => mutate("DELETE", `recurring/${r.id}`, null, t("bills.deleted")) : null,
  });
}

// Adds a category to the bill categories list (no-op when it already exists, case-insensitive).
async function addBillCategory(name) {
  const list = db.settings.bill_categories;
  if (list.some((c) => c.toLowerCase() === name.toLowerCase())) return false;
  db.settings = await api("PUT", "settings", { bill_categories: [...list, name] });
  return true;
}

function payForm(r) {
  openForm({
    title: r.scheduled ? t("bills.pay_title", { name: r.name, date: fmtDate(r.next_due) }) : t("bills.pay_title_simple", { name: r.name }),
    submitLabel: t("bills.mark_payment"),
    fields: [
      { type: "row", fields: [
        { name: "amount", label: r.variable ? t("bills.amount_billed") : t("form.amount"), type: "number", value: r.variable ? "" : r.amount, required: true, placeholder: r.variable ? t("bills.usually", { amount: r.amount }) : "" },
        { name: "date", label: t("bills.paid_date"), type: "date", value: today(), required: true },
      ] },
      { type: "row", fields: [
        { name: "payer_id", label: t("form.paid_by"), type: "select", value: r.payer_id, options: residentOptions() },
        { name: "payment_method", label: t("form.payment_method"), type: "select", value: r.payment_method, options: methodOptions() },
      ] },
      { name: "note", label: t("form.comment"), placeholder: t("bills.pay_note_placeholder") },
    ],
    onSubmit: (v) => mutate("POST", `recurring/${r.id}/pay`, v, t("bills.paid")),
  });
}

function paymentForm(p) {
  openForm({
    title: t("bills.payment_title", { name: p.name }),
    fields: [
      { type: "row", fields: [
        { name: "amount", label: t("form.amount"), type: "number", value: p.amount, required: true },
        { name: "date", label: t("bills.paid_date"), type: "date", value: p.date, required: true },
      ] },
      { type: "row", fields: [
        { name: "payer_id", label: t("form.paid_by"), type: "select", value: p.payer_id, options: residentOptions() },
        { name: "payment_method", label: t("form.payment_method"), type: "select", value: p.payment_method, options: methodOptions() },
      ] },
      { name: "note", label: t("form.comment"), value: p.note },
    ],
    onSubmit: (v) => mutate("PUT", `payments/${p.id}`, v),
    onDelete: () => mutate("DELETE", `payments/${p.id}`, null, t("bills.payment_deleted")),
  });
}

// Pay / skip buttons work the same on every screen that lists upcoming payments.
async function handleDueAction(el) {
  if (el.dataset.pay) payForm(recurringById(el.dataset.pay));
  if (el.dataset.skip) {
    const r = recurringById(el.dataset.skip);
    if (await askConfirm(t("bills.skip_confirm", { name: r.name, date: fmtDate(r.next_due) }), t("bills.skip"))) {
      mutate("POST", `recurring/${r.id}/skip`, {}, t("bills.skipped"));
    }
  }
}

// Home Assistant ------------------------------------------------------------
function haCard(s) {
  const opt = (name, value, options) => `<select name="${name}">${options.map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  return `<div class="card" id="ha-card"><h3>Home Assistant</h3>
    <div id="ha-status" class="ha-status muted small">${t("ha.checking")}</div>
    <form id="ha-form">
      <div class="fields-2">
        <label class="field"><span>${t("ha.sync_persons")}</span>${opt("sync_persons", s.sync_persons !== false ? 1 : 0, [[1, t("ha.sync_auto")], [0, t("ha.sync_manual")]])}</label>
        <label class="field"><span>${t("ha.sensors")}</span>${opt("sensors_enabled", s.sensors_enabled !== false ? 1 : 0, [[1, t("ha.publish")], [0, t("ha.dont_publish")]])}</label>
        <label class="field"><span>${t("ha.notifications")}</span>${opt("notify_enabled", s.notify_enabled !== false ? 1 : 0, [[1, t("ha.on")], [0, t("ha.off")]])}</label>
        <label class="field"><span>${t("ha.persistent")}</span>${opt("notify_persistent", s.notify_persistent !== false ? 1 : 0, [[1, t("common.yes")], [0, t("common.no")]])}</label>
        <label class="field"><span>${t("ha.notify_hour")}</span><input name="notify_hour" type="number" min="0" max="21" step="1" value="${s.notify_hour ?? 9}"></label>
        <label class="field"><span>${t("ha.bill_days")}</span><input name="notify_bill_days" value="${esc((s.notify_bill_days || []).join(", "))}" placeholder="3, 0"></label>
        <label class="field"><span>${t("ha.doc_days")}</span><input name="notify_doc_days" value="${esc((s.notify_doc_days || []).join(", "))}" placeholder="30, 7, 1, 0"></label>
      </div>
      <label class="field"><span>${t("ha.budgets")}</span>${opt("notify_budget", s.notify_budget !== false ? 1 : 0, [[1, t("ha.budget_warn")], [0, t("ha.budget_nowarn")]])}</label>
      <div class="row"><button class="btn primary sm">${t("common.save")}</button><button type="button" class="btn sm" id="ha-test">${t("ha.send_test")}</button></div>
    </form>
    <div class="muted small" style="margin-top:10px">${t("ha.hint")}</div>
    <details style="margin-top:10px"><summary class="small">${t("ha.preview_summary")}</summary><div id="ha-preview" class="small"></div></details>
  </div>`;
}

const parseDays = (text) => [...new Set(String(text).split(/[^\d]+/).filter(Boolean).map(Number))].sort((a, b) => b - a);

async function loadHaInfo() {
  const box = $("#ha-status");
  if (!box) return;
  try {
    const [st, pv] = await Promise.all([api("GET", "ha/status"), api("GET", "ha/preview")]);
    ui.haServices = st.notify_services || [];
    loadTodoInfo(st.todo);
    const dl = $("#dl-notify");
    if (dl) dl.innerHTML = ui.haServices.map((x) => `<option value="${esc(x)}">`).join("");
    const modes = { supervisor: t("ha.mode_supervisor"), token: t("ha.mode_token"), none: "" };
    box.innerHTML = st.mode === "none"
      ? `<span class="doc soon">${t("ha.not_connected")}</span> ${t("ha.standalone")}`
      : st.connected
        ? `<span class="doc ok">${t("ha.connected")}</span> ${modes[st.mode] || ""}${st.last_push ? ` · ${t("ha.sensors_updated", { time: st.last_push.slice(11, 16) })}` : ""} · ${t("ha.sent", { n: st.sent })}`
        : `<span class="doc expired">${t("common.error")}</span> ${esc(st.last_error || t("ha.no_connection"))}`;
    if (st.last_error && st.connected) box.innerHTML += `<div style="color:var(--danger)">${esc(st.last_error)}</div>`;
    $("#ha-preview").innerHTML = `
      <div style="margin:8px 0 4px"><b>${t("ha.pending", { n: pv.pending.length })}</b>${pv.in_window ? "" : " · " + t("ha.quiet_hours")}</div>
      ${pv.pending.length ? `<ul class="list">${pv.pending.map((n) => `<li><div class="grow"><div>${esc(n.title)}</div><div class="muted">${esc(n.message)}</div></div>
        <span class="muted">${n.targets.length ? n.targets.map(esc).join(", ") : t("ha.no_targets")}</span></li>`).join("")}</ul>` : `<div class="muted">${t("ha.nothing_pending")}</div>`}
      <div style="margin:12px 0 4px"><b>${t("ha.sensors_title")}</b></div>
      <ul class="list">${Object.entries(pv.sensors).map(([id, x]) => `<li><div class="grow"><code>${id}</code><div class="muted">${esc(x.attributes.friendly_name)}</div></div>
        <span class="num">${esc(x.state)} ${esc(x.attributes.unit_of_measurement || "")}</span></li>`).join("")}</ul>
      <button type="button" class="btn sm ghost" id="ha-reset" style="margin-top:8px">${t("ha.resend")}</button>`;
    $("#ha-reset").onclick = () => mutate("POST", "ha/reset", {}, t("ha.resend_done")).then(loadHaInfo);
  } catch (e) {
    box.textContent = t("ha.status_failed", { error: e.message });
  }
}

// Shopping list sync: Homeledger <-> HA To-do <-> Alice (Yandex.Station integration).
function todoCard(s) {
  const current = (value, empty) => `<option value="">${empty}</option>${value ? `<option value="${esc(value)}" selected>${esc(value)}</option>` : ""}`;
  const link = `<a href="https://github.com/AlexxIT/YandexStation" target="_blank" rel="noopener">Yandex.Station</a>`;
  return `<div class="card" id="todo-card"><h3>${t("todo.title")}</h3>
    <div class="muted small" style="margin:-4px 0 14px">${t("todo.intro", { link })}</div>
    <form id="todo-form">
      <div class="fields-2">
        <label class="field"><span>${t("todo.entity")}</span><select name="todo_entity">${current(s.todo_entity, t("todo.no_sync"))}</select></label>
        <label class="field"><span>${t("todo.station")}</span><select name="yandex_station">${current(s.yandex_station, t("todo.no_alice"))}</select></label>
      </div>
      <div class="row"><button class="btn primary sm">${t("common.save")}</button></div>
    </form>
    <div id="todo-status" class="muted small" style="margin-top:12px"></div>
    <details style="margin-top:10px"><summary class="small">${t("todo.requirements")}</summary><ol class="small muted" style="padding-left:18px;margin:8px 0 0">
      <li>${t("todo.step1")}</li>
      <li>${t("todo.step2")}</li>
      <li>${t("todo.step3")}</li>
      <li>${t("todo.step4")}</li></ol></details>
  </div>`;
}

async function loadTodoInfo(todoState) {
  const box = $("#todo-status");
  if (!box) return;
  const st = todoState || {};
  box.innerHTML = st.last_error
    ? `<span class="doc expired">${t("common.error")}</span> ${esc(st.last_error)}`
    : st.last_sync
      ? `<span class="doc ok">${t("todo.synced_at", { time: st.last_sync.slice(11, 16) })}</span> ${t("todo.sync_stats", st)}`
      : db.settings.todo_entity ? t("todo.not_synced") : "";
  try {
    const ents = await api("GET", "ha/entities");
    const form = $("#todo-form");
    if (!form) return;
    const fill = (select, list, empty) => {
      const value = select.value;
      const ids = new Set(list.map((x) => x.entity_id));
      select.innerHTML = `<option value="">${empty}</option>` + list.map((x) => `<option value="${esc(x.entity_id)}">${esc(x.name)} · ${esc(x.entity_id)}</option>`).join("")
        + (value && !ids.has(value) ? `<option value="${esc(value)}">${esc(value)} ${t("todo.not_found")}</option>` : "");
      select.value = value;
    };
    fill(form.todo_entity, ents.todo, t("todo.no_sync"));
    fill(form.yandex_station, ents.stations, t("todo.no_alice"));
  } catch { /* no HA — keep the saved values */ }
}

function bindTodoCard() {
  const form = $("#todo-form");
  form.onsubmit = (e) => {
    e.preventDefault();
    mutate("PUT", "settings", { todo_entity: form.todo_entity.value, yandex_station: form.yandex_station.value }, t("todo.saved"));
  };
}

// Manual sync, including Alice when a speaker is chosen (the speaker reads the list aloud, so never automatic).
async function runTodoSync(button) {
  button.disabled = true;
  try {
    const st = await api("POST", "ha/todo/sync", {});
    await reload();
    toast(t("todo.synced_toast", st));
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

function bindHaCard() {
  bindTodoCard();
  const form = $("#ha-form");
  form.onsubmit = (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form).entries());
    mutate("PUT", "settings", {
      sensors_enabled: v.sensors_enabled === "1",
      sync_persons: v.sync_persons === "1",
      notify_enabled: v.notify_enabled === "1",
      notify_persistent: v.notify_persistent === "1",
      notify_budget: v.notify_budget === "1",
      notify_hour: Math.min(21, Math.max(0, Math.round(num(v.notify_hour)))),
      notify_bill_days: parseDays(v.notify_bill_days),
      notify_doc_days: parseDays(v.notify_doc_days),
    }, t("ha.saved"));
  };
  $("#ha-test").onclick = async () => {
    try {
      const r = await api("POST", "ha/test", {});
      toast(t("ha.test_sent", { services: r.services.join(", ") }));
    } catch (e) {
      toast(e.message, true);
    }
  };
  loadHaInfo();
}

// Expenses: the simplest list — what for, price, paid or not, in your own order ---
// Each expense belongs to a month (the month it was added to); older items fall back to their creation month.
const expenseMonth = (x) => x.month || String(x.created_at || today()).slice(0, 7);
const expenseItems = (month) => db.expense_items.filter((x) => expenseMonth(x) === month).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

function shiftMonth(month, delta) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthTitle(month) {
  const [y, m] = month.split("-").map(Number);
  const s = new Intl.DateTimeFormat(locale(), { month: "long", year: "numeric" }).format(new Date(y, m - 1, 1));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function expensesView() {
  const month = (ui.expMonth ||= today().slice(0, 7));
  const items = expenseItems(month);
  const total = items.reduce((s, x) => s + num(x.price), 0);
  const paid = items.filter((x) => x.paid).reduce((s, x) => s + num(x.price), 0);
  return `
    <div class="row"><h2>${t("expenses.title")}</h2><span class="spacer"></span>
      <div class="month-switch">
        <button type="button" class="icon-btn" data-exp-month="-1" title="${esc(t("expenses.prev_month"))}" aria-label="${esc(t("expenses.prev_month"))}">‹</button>
        <span class="month-name">${esc(monthTitle(month))}</span>
        <button type="button" class="icon-btn" data-exp-month="1" title="${esc(t("expenses.next_month"))}" aria-label="${esc(t("expenses.next_month"))}">›</button>
      </div></div>
    <div class="grid kpi" style="margin-bottom:12px">
      <div class="card kpi"><div class="label">${t("expenses.total")}</div><div class="value num">${money(total)}</div></div>
      <div class="card kpi"><div class="label">${t("expenses.paid_total")}</div><div class="value num">${money(paid)}</div></div>
      <div class="card kpi"><div class="label">${t("expenses.left")}</div><div class="value num">${money(total - paid)}</div></div>
    </div>
    <div class="card">
      ${items.length ? `<ul class="list exp-list" id="exp-list">${items.map((x) => `
        <li data-id="${x.id}" class="${x.paid ? "is-paid" : ""}">
          <button type="button" class="drag-handle" aria-label="${esc(t("expenses.drag_hint"))}" title="${esc(t("expenses.drag_hint"))}">⠿</button>
          <div class="grow" data-edit-expense="${x.id}"><div class="title">${esc(x.name)}</div>
            ${x.paid && x.paid_at ? `<div class="muted small">${t("expenses.paid_on", { date: fmtDate(x.paid_at) })}</div>` : ""}</div>
          <span class="num">${money(x.price)}</span>
          <button type="button" class="pay-badge ${x.paid ? "paid" : ""}" data-toggle-paid="${x.id}" title="${esc(t("expenses.toggle_hint"))}">${t(x.paid ? "expenses.paid" : "expenses.unpaid")}</button>
          <button type="button" class="icon-btn" data-edit-expense="${x.id}" title="${esc(t("common.edit"))}">✎</button>
          <button type="button" class="icon-btn" data-del-expense="${x.id}" title="${esc(t("common.delete"))}">✕</button>
        </li>`).join("")}</ul>`
        : `<div class="empty">${t(db.expense_items.length ? "expenses.empty_month" : "expenses.empty", { month: monthTitle(month) })}</div>`}
      <form class="exp-add-row ${items.length ? "" : "first"}" id="add-expense" autocomplete="off">
        <span class="plus" aria-hidden="true">＋</span>
        <input name="name" placeholder="${esc(t("expenses.name_placeholder"))}" aria-label="${esc(t("expenses.name_placeholder"))}" required>
        <input name="price" type="number" min="0" step="any" inputmode="decimal" placeholder="${esc(t("expenses.price"))}" aria-label="${esc(t("expenses.price"))}" required>
        <button class="btn sm primary">${t("common.add")}</button>
      </form>
    </div>`;
}

function expenseForm(x) {
  openForm({
    title: t("expenses.edit"),
    fields: [
      { name: "name", label: t("form.name"), value: x.name, required: true },
      { type: "row", fields: [
        { name: "price", label: t("form.amount_currency", { currency: db.settings.currency }), type: "number", value: x.price, required: true },
        { name: "paid", label: t("form.status"), type: "select", value: x.paid ? "1" : "", options: [["", t("expenses.unpaid")], ["1", t("expenses.paid")]] },
      ] },
      { name: "paid_at", label: t("expenses.paid_date"), type: "date", value: x.paid_at || "" },
    ],
    onSubmit: (v) => {
      const paid = v.paid === "1";
      // A paid expense always has a payment date; an unpaid one never does.
      return mutate("PUT", `expense_items/${x.id}`, { ...v, paid, paid_at: paid ? v.paid_at || today() : "" });
    },
    onDelete: () => mutate("DELETE", `expense_items/${x.id}`),
  });
}

async function saveExpenseOrder(list) {
  const ids = [...list.querySelectorAll("li[data-id]")].map((li) => li.dataset.id);
  ids.forEach((id, i) => { const x = db.expense_items.find((e) => e.id === id); if (x) x.order = i; });
  try {
    await api("POST", "expense_items/reorder", { ids });
  } catch (e) {
    toast(e.message, true);
    await reload();
  }
}

// Drag & drop on pointer events: HTML5 drag-and-drop doesn't work with touch on iOS.
// The row follows the finger/mouse; rows it passes over swap places live.
function enableExpenseDrag(list) {
  list.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest(".drag-handle");
    if (!handle || e.button > 0) return;
    e.preventDefault();
    const row = handle.closest("li");
    const startY = e.clientY;
    let shift = 0; // how far the row moved in the layout through swaps (offsetTop ignores transform)
    handle.setPointerCapture(e.pointerId);
    row.classList.add("dragging");

    const follow = (y) => { row.style.transform = `translateY(${y - startY - shift}px)`; };
    const onMove = (ev) => {
      follow(ev.clientY);
      const rect = row.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      const prev = row.previousElementSibling;
      const next = row.nextElementSibling;
      const top0 = row.offsetTop;
      if (prev && mid < prev.getBoundingClientRect().top + prev.offsetHeight / 2) list.insertBefore(row, prev);
      else if (next && mid > next.getBoundingClientRect().top + next.offsetHeight / 2) list.insertBefore(next, row);
      else return;
      shift += row.offsetTop - top0;
      follow(ev.clientY);
    };
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      row.classList.remove("dragging");
      row.style.transform = "";
      if (shift) saveExpenseOrder(list);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  });

  // Keyboard: focus the handle and use ↑ / ↓.
  list.addEventListener("keydown", (e) => {
    const handle = e.target.closest(".drag-handle");
    if (!handle || !["ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const row = handle.closest("li");
    const sibling = e.key === "ArrowUp" ? row.previousElementSibling : row.nextElementSibling;
    if (!sibling) return;
    if (e.key === "ArrowUp") list.insertBefore(row, sibling);
    else list.insertBefore(sibling, row);
    handle.focus();
    saveExpenseOrder(list);
  });
}

// Stats ---------------------------------------------------------------------
const PERIODS = ["month", "3m", "year", "all"];

function stats() {
  const p = ui.statsPeriod;
  const payer = ui.statsPayer;
  const all = expenses().filter((e) => !payer || e.payer_id === payer);
  const ex = all.filter((e) => inPeriod(e.date, p));
  const byKind = (kind) => ex.filter((e) => e.kind === kind);
  const home = byKind("home");
  const groc = byKind("groceries");
  const car = byKind("car");
  const trips = db.trips.filter((tr) => inPeriod(tr.date, p) && (!payer || tr.payer_id === payer));
  const grocTotal = sumAmount(groc);
  const months = Math.max(1, new Set(groc.map((e) => monthKey(e.date))).size);

  const productFreq = new Map();
  for (const tr of trips) for (const i of tr.items) productFreq.set(i.name, (productFreq.get(i.name) || 0) + 1);
  const topProducts = [...productFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const skipped = trips.reduce((s, tr) => s + (tr.skipped || 0), 0);
  const boughtCount = trips.reduce((s, tr) => s + tr.items.length, 0);

  const payerLabel = (id, c) => {
    const r = resident(id);
    return r ? `<span class="dot" style="background:${r.color}"></span>${esc(r.name)}` : `<span class="dot" style="background:${c}"></span><span class="muted">${t("common.not_specified")}</span>`;
  };
  const payerColor = (id) => resident(id)?.color || "#9e9e9e";
  const kindLabel = (k) => `<span class="dot" style="background:${KINDS[k].color}"></span>${kindName(k)}`;
  const carsById = Object.fromEntries(db.cars.map((c) => [c.id, c]));
  const bills = byKind("bills");
  const span = p === "year" || p === "all" ? 12 : 6;

  return `
    <div class="row"><h2>${t("stats.title")}</h2><span class="spacer"></span>
      <select id="payer-filter" style="width:auto"><option value="">${t("stats.all_residents")}</option>
        ${db.residents.map((r) => `<option value="${r.id}" ${r.id === payer ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select>
      <div class="seg" id="period">${PERIODS.map((k) => `<button data-p="${k}" class="${k === p ? "active" : ""}">${t("period." + k)}</button>`).join("")}</div></div>

    <div class="grid kpi">
      <div class="card kpi"><div class="label">${t("stats.total")}</div><div class="value num">${money(sumAmount(ex))}</div><div class="sub">${t("common.transactions", { n: ex.length })}</div></div>
      <div class="card kpi"><div class="label">${kindName("home")}</div><div class="value num">${money(sumAmount(home))}</div><div class="sub">${t("stats.purchases", { n: home.length })}</div></div>
      <div class="card kpi"><div class="label">${kindName("groceries")}</div><div class="value num">${money(grocTotal)}</div>
        <div class="sub">${t("stats.trips", { n: trips.length })} · ${t("stats.avg_receipt", { amount: money(trips.length ? grocTotal / trips.length : 0) })}</div></div>
      <div class="card kpi"><div class="label">${kindName("car")}</div><div class="value num">${money(sumAmount(car))}</div><div class="sub">${t("stats.expenses", { n: car.length })}</div></div>
      <div class="card kpi"><div class="label">${t("bills.title")}</div><div class="value num">${money(sumAmount(bills))}</div><div class="sub">${t("stats.payments", { n: bills.length })}</div></div>
    </div>

    <div class="card" style="margin-top:12px"><h3>${t("stats.by_month")}</h3>${monthlyColumns(all, 12)}</div>

    <div class="card" style="margin-top:12px">
      <div class="row"><h3>${t("stats.who_monthly")}</h3><span class="spacer"></span><span class="muted small">${t("stats.last_months", { n: span })}</span></div>
      ${residentMonthMatrix(all, span)}
    </div>

    <div class="card" style="margin-top:12px">
      <h3>${t("stats.who_what")} <span class="muted small">· ${t("period." + p).toLowerCase()}</span></h3>
      ${residentCategories(ex)}
    </div>

    <div class="grid two" style="margin-top:12px">
      <div class="card"><h3>${t("stats.by_section")}</h3>${barsHtml(sumBy(ex, (e) => e.kind), (k) => KINDS[k].color, kindLabel)}</div>
      <div class="card"><h3>${t("stats.by_category")}</h3>${barsHtml(sumBy(ex, (e) => e.category).slice(0, 12))}</div>
      <div class="card"><h3>${t("form.who_pays")}</h3>${barsHtml(sumBy(ex, (e) => e.payer_id), payerColor, payerLabel)}</div>
      <div class="card"><h3>${t("settings.payment_methods")}</h3>${barsHtml(sumBy(ex, (e) => e.method || t("stats.method_not_set")))}</div>
      <div class="card"><h3>${t("stats.home_by_room")}</h3>${barsHtml(sumBy(home, (e) => e.category))}</div>
      <div class="card"><h3>${t("stats.groceries_by_store")}</h3>${barsHtml(sumBy(groc, (e) => e.store))}</div>
      <div class="card"><h3>${t("stats.car_by_category")}</h3>${barsHtml(sumBy(car, (e) => e.category))}</div>
      <div class="card"><h3>${t("stats.car_by_car")}</h3>${barsHtml(sumBy(car, (e) => carName(carsById[e.car_id])))}</div>
      <div class="card"><h3>${t("stats.bills_by_category")}</h3>${barsHtml(sumBy(bills, (e) => e.category))}</div>
      <div class="card"><h3>${t("stats.bills_top")}</h3>${barsHtml(sumBy(bills, (e) => e.title).slice(0, 10))}</div>
      <div class="card"><h3>${t("stats.top_products")}</h3>
        ${topProducts.length ? `<ul class="list">${topProducts.map(([n, c]) => `<li><div class="grow">${esc(n)}</div><span class="muted small">${t("stats.times", { n: c })}</span></li>`).join("")}</ul>` : `<div class="empty small">${t("common.no_data")}</div>`}
        ${boughtCount + skipped ? `<div class="muted small" style="margin-top:8px">${t("stats.list_completion", { pct: Math.round((boughtCount / (boughtCount + skipped)) * 100), amount: money(grocTotal / months) })}</div>` : ""}
      </div>
    </div>`;
}

// Rows: residents, columns: months. Cell tooltip shows the split by section.
function residentMonthMatrix(list, n) {
  const keys = lastMonths(n);
  const rows = [...db.residents.map((r) => r.id), ""].filter((id) => list.some((e) => (e.payer_id || "") === id && keys.includes(monthKey(e.date))));
  if (!rows.length) return `<div class="empty small">${t("common.no_data")}</div>`;
  const cell = (id, k) => list.filter((e) => (e.payer_id || "") === id && monthKey(e.date) === k);
  const max = Math.max(...rows.flatMap((id) => keys.map((k) => sumAmount(cell(id, k))))) || 1;
  const name = (id) => (id ? residentChip(id) : `<span class="muted">${t("common.not_specified")}</span>`);
  const colTotal = (k) => sumAmount(list.filter((e) => monthKey(e.date) === k));
  return `<div class="scroll-x"><table class="matrix">
    <thead><tr><th>${t("stats.resident")}</th>${keys.map((k) => `<th title="${esc(monthLabel(k, true))}">${monthLabel(k)}</th>`).join("")}<th>${t("stats.total_col")}</th><th>${t("stats.average")}</th></tr></thead>
    <tbody>${rows.map((id) => {
      const color = resident(id)?.color || "#9e9e9e";
      const rowTotal = sumAmount(list.filter((e) => (e.payer_id || "") === id && keys.includes(monthKey(e.date))));
      return `<tr><td>${name(id)}</td>${keys.map((k) => {
        const items = cell(id, k);
        const v = sumAmount(items);
        const tip = (v ? money(v) + "\n" : "") + Object.keys(KINDS).map((kind) => [kind, sumAmount(items.filter((e) => e.kind === kind))]).filter(([, s]) => s)
          .map(([kind, s]) => `${kindName(kind)}: ${money(s)}`).join("\n");
        return `<td class="num heat" title="${esc(tip)}">${v ? compactMoney(v) : '<span class="muted">—</span>'}
          ${v ? `<span class="cell-bar" style="width:${(v / max) * 100}%;background:${color}"></span>` : ""}</td>`;
      }).join("")}<td class="num"><b>${money(rowTotal)}</b></td><td class="num muted">${money(rowTotal / n)}</td></tr>`;
    }).join("")}
    <tr class="total"><td>${t("stats.total_row")}</td>${keys.map((k) => `<td class="num" title="${colTotal(k) ? esc(money(colTotal(k))) : ""}">${colTotal(k) ? compactMoney(colTotal(k)) : "—"}</td>`).join("")}
      <td class="num">${money(sumAmount(list.filter((e) => keys.includes(monthKey(e.date)))))}</td><td></td></tr>
    </tbody></table></div>`;
}

// For each resident: split by section (bar) + top detailed categories.
function residentCategories(list) {
  const ids = [...db.residents.map((r) => r.id), ""].filter((id) => list.some((e) => (e.payer_id || "") === id));
  if (!ids.length) return `<div class="empty small">${t("common.no_data")}</div>`;
  return `<div class="resident-cats">${ids.map((id) => {
    const mine = list.filter((e) => (e.payer_id || "") === id);
    const total = sumAmount(mine);
    const kinds = Object.keys(KINDS).map((k) => [k, sumAmount(mine.filter((e) => e.kind === k))]).filter(([, v]) => v);
    const cats = sumBy(mine, (e) => e.category).slice(0, 6);
    return `<div>
      <div class="row">${id ? residentChip(id) : `<span class="muted">${t("common.not_specified")}</span>`}<span class="spacer"></span><b class="num">${money(total)}</b></div>
      <div class="stackbar">${kinds.map(([k, v]) => `<div title="${esc(kindName(k))}: ${money(v)}" style="width:${(v / total) * 100}%;background:${KINDS[k].color}"></div>`).join("")}</div>
      <div class="row small muted">${kinds.map(([k, v]) => `<span><span class="dot" style="background:${KINDS[k].color}"></span> ${kindName(k)} ${money(v)}</span>`).join(" ")}</div>
      <div class="row small" style="margin-top:4px">${cats.map(([c, v]) => `<span class="chip">${esc(c)} · <span class="num">${money(v)}</span></span>`).join("")}</div>
    </div>`;
  }).join("")}</div>`;
}

// Settings / residents ------------------------------------------------------
function settings() {
  const s = db.settings;
  const tagEditor = (key, title, hint = "", listId = "") => `<div class="card"><h3>${title}</h3>
    ${hint ? `<div class="muted small" style="margin:-4px 0 10px">${hint}</div>` : ""}
    <div class="tag-edit">${s[key].length ? s[key].map((tag, i) => `<span class="chip"><span class="tag-name" data-rename-tag="${key}" data-i="${i}" title="${esc(t("settings.rename_hint"))}">${esc(tag)}</span><button data-del-tag="${key}" data-i="${i}" title="${esc(t("common.delete"))}">✕</button></span>`).join("")
      : `<span class="muted small">${t("common.empty")}</span>`}</div>
    <form class="row" data-add-tag="${key}" style="margin-top:10px"><input name="v" placeholder="${esc(t("settings.add_placeholder"))}" style="flex:1" required ${listId ? `list="${listId}"` : ""}>${listId ? `<datalist id="${listId}">${ui.haServices.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>` : ""}<button class="btn sm">${t("common.add")}</button></form></div>`;
  const budgetField = (name, label) => `<label class="field"><span>${esc(label)}, ${esc(s.currency)}</span><input name="${name}" type="number" min="0" step="any" value="${s[name] || ""}"></label>`;

  return `
    <div class="row"><h2>${t("settings.residents")}</h2><span class="spacer"></span>
      <button class="btn" id="ha-import" title="${esc(t("settings.ha_import_hint"))}">${t("settings.ha_import")}</button>
      <button class="btn primary" id="add-resident">＋ ${t("settings.add_resident")}</button></div>
    <div class="card">
      ${db.residents.length ? `<ul class="list">${db.residents.map((r) => {
          const spent = expenses().filter((e) => e.payer_id === r.id).reduce((sum, e) => sum + e.amount, 0);
          return `<li class="resident">${avatar(r)}
            <div class="grow"><div>${esc(r.name)}${r.ha_person ? ' <span class="badge" title="' + esc(r.ha_person) + '">HA</span>' : ""}${r.id === meId() ? ` <span class="badge">${t("settings.you")}</span>` : ""}</div>
              <div class="muted small">${[r.role, r.notify_service && t("settings.notify_via", { service: r.notify_service })].filter(Boolean).map(esc).join(" · ")}</div></div>
            <span class="muted small num">${t("settings.paid_total", { amount: money(spent) })}</span>
            <button class="icon-btn" data-edit-resident="${r.id}" title="${esc(t("common.edit"))}">✎</button></li>`;
        }).join("")}</ul>` : `<div class="empty">${t("settings.no_residents")}</div>`}
    </div>

    <h2 style="margin-top:24px">${t("nav.settings")}</h2>
    <div class="grid two settings-grid">
      <div class="card"><h3>${t("settings.monthly_budget")}</h3>
        <form id="budget-form">
          <div class="fields-2">
            ${budgetField("budget_groceries", kindName("groceries"))}
            ${budgetField("budget_home", kindName("home"))}
            ${budgetField("budget_car", kindName("car"))}
            ${budgetField("budget_bills", t("bills.title"))}
          </div>
          <button class="btn primary sm">${t("common.save")}</button>
        </form></div>
      ${currencyCard(s)}
      ${tagEditor("payment_methods", t("settings.payment_methods"))}
      ${tagEditor("rooms", t("settings.rooms"))}
      ${tagEditor("grocery_categories", t("settings.grocery_categories"))}
      ${tagEditor("stores", t("settings.stores"), t("settings.stores_hint"))}
      ${tagEditor("favorite_products", t("settings.favorites"), t("settings.favorites_hint"))}
      ${tagEditor("hidden_products", t("settings.hidden"), t("settings.hidden_hint"))}
      ${tagEditor("car_categories", t("settings.car_categories"))}
      ${tagEditor("bill_categories", t("settings.bill_categories"))}
      ${haCard(s)}
      ${todoCard(s)}
      ${tagEditor("notify_services", t("settings.notify_services"), t("settings.notify_services_hint"), "dl-notify")}
      <div class="card"><h3>${t("settings.data")}</h3>
        <div class="muted small" style="margin-bottom:10px">${t("settings.backup_hint")}</div>
        <div class="row"><a class="btn sm" href="api/export" download="homeledger.json">${t("settings.export")}</a>
        <label class="btn sm">${t("settings.import")}<input type="file" id="import-file" accept=".json" hidden></label></div></div>
    </div>
    <div class="muted small" style="text-align:center;margin-top:28px">Homeledger ${esc(document.querySelector('meta[name="hl-version"]')?.content || "")}</div>`;
}

function currencyCard(s) {
  const known = CURRENCIES.find(([code]) => code === s.currency_code);
  const code = known ? s.currency_code : "OTHER";
  const lang = s.language || "auto";
  return `<div class="card"><h3>${t("settings.language_currency")}</h3>
    <label class="field"><span>${t("settings.language")}</span><select id="language-select">
      <option value="auto" ${lang === "auto" ? "selected" : ""}>${t("settings.language_auto")}</option>
      ${LANGUAGES.map(([c, name]) => `<option value="${c}" ${c === lang ? "selected" : ""}>${esc(name)}</option>`).join("")}</select></label>
    <form id="currency-form">
      <label class="field"><span>${t("settings.currency")}</span><select name="currency_code">
        ${CURRENCIES.map((cur) => `<option value="${cur[0]}" ${cur[0] === code ? "selected" : ""}>${esc(currencySymbol(cur))} — ${esc(t("currency." + cur[0]))} (${cur[0]})</option>`).join("")}
        <option value="OTHER" ${code === "OTHER" ? "selected" : ""}>${t("settings.currency_other")}</option></select></label>
      <label class="field" id="custom-currency" ${code === "OTHER" ? "" : "hidden"}><span>${t("settings.currency_symbol")}</span>
        <input name="custom" value="${esc(code === "OTHER" ? s.currency : "")}" maxlength="6" placeholder="${esc(t("settings.currency_symbol_placeholder"))}" style="max-width:160px"></label>
      <div class="fields-2">
        <label class="field"><span>${t("settings.symbol_position")}</span><select name="currency_position">
          <option value="after" ${s.currency_position !== "before" ? "selected" : ""}>${esc(t("settings.currency_after", { example: fmtNumber(1000) + " ₽" }))}</option>
          <option value="before" ${s.currency_position === "before" ? "selected" : ""}>${esc(t("settings.currency_before", { example: "$" + fmtNumber(1000) }))}</option></select></label>
        <label class="field"><span>${t("settings.decimals")}</span><select name="currency_decimals">
          <option value="1" ${s.currency_decimals !== false ? "selected" : ""}>${t("settings.show_cents")}</option>
          <option value="0" ${s.currency_decimals === false ? "selected" : ""}>${t("settings.round")}</option></select></label>
      </div>
      <div class="row"><button class="btn primary sm">${t("common.save")}</button><span class="muted small">${t("settings.example")} <b id="currency-preview" class="num"></b></span></div>
      <div class="muted small" style="margin-top:8px">${t("settings.currency_hint")}</div>
    </form></div>`;
}

function readCurrencyForm(form) {
  const v = Object.fromEntries(new FormData(form).entries());
  const known = CURRENCIES.find(([c]) => c === v.currency_code);
  return {
    currency_code: v.currency_code,
    currency: known ? currencySymbol(known) : (v.custom || "").trim() || "¤",
    currency_position: v.currency_position,
    currency_decimals: v.currency_decimals === "1",
  };
}

function residentForm(r = {}) {
  openForm({
    title: r.id ? t("settings.resident") : t("settings.new_resident"),
    fields: [
      { name: "name", label: t("settings.name"), value: r.name, required: true },
      { name: "role", label: t("settings.role"), value: r.role, placeholder: t("settings.role_placeholder") },
      { name: "notify_service", label: t("settings.resident_notify"), value: r.notify_service, placeholder: "notify.mobile_app_…", datalist: ui.haServices },
      { name: "color", label: t("form.color"), type: "color", value: r.color || COLORS[db.residents.length % COLORS.length] },
    ],
    note: r.ha_person ? t("settings.linked_note", { person: r.ha_person }) : "",
    onSubmit: (v) => (r.id ? mutate("PUT", `residents/${r.id}`, v) : mutate("POST", "residents", v, t("settings.resident_added"))),
    onDelete: r.id ? () => mutate("DELETE", `residents/${r.id}`) : null,
  });
}

// --- event binding per view --------------------------------------------------
const bind = {
  overview() {
    document.querySelectorAll("[data-goto]").forEach((b) => (b.onclick = () => $(`#tabs [data-view="${b.dataset.goto}"]`).click()));
    $("#view").onclick = (e) => {
      const el = e.target.closest("[data-pay],[data-skip]");
      if (el) handleDueAction(el);
    };
  },

  expenses() {
    $("#add-expense").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const name = f.name.value.trim();
      if (!name) return;
      const order = Math.max(-1, ...db.expense_items.map((x) => x.order ?? 0)) + 1; // new items go to the end
      await mutate("POST", "expense_items", { name, price: num(f.price.value), paid: false, paid_at: "", order, month: ui.expMonth });
      $("#add-expense")?.elements.name.focus();
    };
    const list = $("#exp-list");
    if (list) enableExpenseDrag(list);
    $("#view").onclick = (e) => {
      const el = e.target.closest("[data-toggle-paid],[data-edit-expense],[data-del-expense],[data-exp-month]");
      if (!el) return;
      if (el.dataset.expMonth) {
        ui.expMonth = shiftMonth(ui.expMonth, Number(el.dataset.expMonth));
        return render();
      }
      const find = (id) => db.expense_items.find((x) => x.id === id);
      if (el.dataset.togglePaid) {
        const paid = !find(el.dataset.togglePaid).paid;
        mutate("PUT", `expense_items/${el.dataset.togglePaid}`, { paid, paid_at: paid ? today() : "" }); // the date Paid was tapped
      }
      if (el.dataset.editExpense) expenseForm(find(el.dataset.editExpense));
      if (el.dataset.delExpense) {
        const id = el.dataset.delExpense;
        askConfirm(t("common.delete_confirm"), t("common.delete"), true).then((yes) => yes && mutate("DELETE", `expense_items/${id}`));
      }
    };
  },

  bills() {
    $("#add-recurring").onclick = () => recurringForm();
    $("#add-bill-category").onclick = async () => {
      const name = (await askText(t("bills.add_category_prompt")))?.trim();
      if (!name) return;
      try {
        if (!(await addBillCategory(name))) toast(t("bills.category_exists"), true);
        await reload();
        recurringForm({ category: db.settings.bill_categories.find((c) => c.toLowerCase() === name.toLowerCase()) });
      } catch (err) {
        toast(err.message, true);
      }
    };
    $("#view").onclick = (e) => {
      const el = e.target.closest("[data-pay],[data-skip],[data-edit-recurring],[data-edit-payment],[data-add-in],[data-goto]");
      if (!el) return;
      if (el.dataset.addIn) return recurringForm({ category: el.dataset.addIn });
      if (el.dataset.goto) return $(`#tabs [data-view="${el.dataset.goto}"]`).click();
      handleDueAction(el);
      if (el.dataset.editRecurring) recurringForm(recurringById(el.dataset.editRecurring));
      if (el.dataset.editPayment) paymentForm(db.payments.find((p) => p.id === el.dataset.editPayment));
    };
  },

  plans() {
    $("#add-plan").onclick = () => planForm();
    $("#f-room").onchange = (e) => { ui.planFilter.room = e.target.value; render(); };
    $("#f-status").onchange = (e) => { ui.planFilter.status = e.target.value; render(); };
    $("#view").onclick = (e) => {
      const el = e.target.closest("[data-edit-plan],[data-add-item],[data-edit-item]");
      if (!el) return;
      if (el.dataset.editPlan) planForm(db.plans.find((p) => p.id === el.dataset.editPlan));
      if (el.dataset.addItem) itemForm(el.dataset.addItem);
      if (el.dataset.editItem) { const i = db.plan_items.find((x) => x.id === el.dataset.editItem); itemForm(i.plan_id, i); }
    };
    $("#view").onchange = (e) => {
      const id = e.target.dataset.toggleItem;
      if (!id) return;
      const bought = e.target.checked;
      mutate("PUT", `plan_items/${id}`, { status: bought ? "bought" : "planned", bought_at: bought ? today() : "" }, bought ? t("plans.marked_bought") : null);
    };
  },

  groceries() {
    $("#view").onchange = null;
    if (ui.shopping) return bindShopping();
    $("#start-shop").onclick = () => { ui.shopping = { checked: [] }; saveShopping(); render(); };
    const sync = $("#todo-sync");
    if (sync) sync.onclick = () => runTodoSync(sync);
    $("#add-grocery").onsubmit = async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.target).entries());
      v.name = v.name.trim();
      // Remember the category the product had last time.
      const prev = db.trips.flatMap((tr) => tr.items).reverse().find((i) => i.name.toLowerCase() === v.name.toLowerCase());
      if (!v.category) v.category = prev?.category || t("common.other");
      await mutate("POST", "groceries", { ...v, added_by: meId() });
      $("#add-grocery input[name=name]")?.focus();
    };
    $("#view").onclick = (e) => {
      const el = e.target.closest("[data-sug],[data-hide-sug],[data-goto],[data-del-grocery],[data-edit-grocery],[data-edit-trip]");
      if (!el) return;
      if (el.dataset.sug) mutate("POST", "groceries", { name: el.dataset.sug, category: el.dataset.cat || t("common.other") });
      if (el.dataset.goto) $(`#tabs [data-view="${el.dataset.goto}"]`).click();
      if (el.dataset.hideSug) {
        const name = el.dataset.hideSug;
        const s = db.settings;
        mutate("PUT", "settings", el.dataset.fav
          ? { favorite_products: s.favorite_products.filter((n) => n !== name) }
          : { hidden_products: [...s.hidden_products, name] }, t("groceries.hidden_toast", { name }));
      }
      if (el.dataset.delGrocery) mutate("DELETE", `groceries/${el.dataset.delGrocery}`);
      if (el.dataset.editTrip) tripForm(db.trips.find((x) => x.id === el.dataset.editTrip));
      if (el.dataset.editGrocery) {
        const g = db.groceries.find((x) => x.id === el.dataset.editGrocery);
        openForm({
          title: t("groceries.product"),
          fields: [
            { name: "name", label: t("form.name"), value: g.name, required: true },
            { type: "row", fields: [
              { name: "qty", label: t("form.qty"), value: g.qty },
              { name: "category", label: t("form.category"), type: "select", value: g.category, options: groceryCategories().map((c) => [c, c]) },
            ] },
            { name: "added_by", label: t("groceries.added_by"), type: "select", value: g.added_by, options: residentOptions() },
          ],
          onSubmit: (v) => mutate("PUT", `groceries/${g.id}`, v),
          onDelete: () => mutate("DELETE", `groceries/${g.id}`),
        });
      }
    };
  },

  cars() {
    $("#add-car").onclick = () => carForm();
    $("#add-car-expense").onclick = () => carExpenseForm({ car_id: db.cars[0]?.id });
    $("#view").onclick = (e) => {
      const el = e.target.closest("[data-edit-car],[data-add-cexp],[data-edit-cexp],[data-expand-car]");
      if (!el) return;
      if (el.dataset.editCar) carForm(db.cars.find((c) => c.id === el.dataset.editCar));
      if (el.dataset.addCexp) carExpenseForm({ car_id: el.dataset.addCexp });
      if (el.dataset.editCexp) carExpenseForm(db.car_expenses.find((x) => x.id === el.dataset.editCexp));
      if (el.dataset.expandCar) {
        const s = ui.carsExpanded;
        s.has(el.dataset.expandCar) ? s.delete(el.dataset.expandCar) : s.add(el.dataset.expandCar);
        render();
      }
    };
  },

  stats() {
    $("#payer-filter").onchange = (e) => { ui.statsPayer = e.target.value; render(); };
    $("#period").onclick = (e) => {
      const p = e.target.dataset.p;
      if (p) { ui.statsPeriod = p; render(); }
    };
  },

  settings() {
    $("#add-resident").onclick = () => residentForm();
    $("#ha-import").onclick = async () => {
      try {
        const r = await mutate("POST", "ha/persons/sync", {});
        toast(r.total ? t("settings.ha_import_result", r) : t("settings.ha_import_none"));
      } catch { /* toast shown */ }
    };
    bindHaCard();
    $("#view").onclick = (e) => {
      const el = e.target.closest("[data-edit-resident],[data-del-tag],[data-rename-tag]");
      if (!el) return;
      if (el.dataset.editResident) residentForm(resident(el.dataset.editResident));
      if (el.dataset.renameTag) {
        const key = el.dataset.renameTag;
        const old = db.settings[key][+el.dataset.i];
        askText(t("settings.rename_prompt"), old).then((value) => {
          const name = value?.trim();
          if (name && name !== old) {
            mutate("POST", "settings/rename", { key, old, new: name }).then((r) => toast(r.records ? t("settings.renamed_records", { n: r.records }) : t("settings.renamed")));
          }
        });
      }
      if (el.dataset.delTag) {
        const list = [...db.settings[el.dataset.delTag]];
        list.splice(+el.dataset.i, 1);
        mutate("PUT", "settings", { [el.dataset.delTag]: list });
      }
    };
    document.querySelectorAll("[data-add-tag]").forEach((f) => (f.onsubmit = (e) => {
      e.preventDefault();
      const key = f.dataset.addTag;
      const v = f.v.value.trim();
      if (v && !db.settings[key].includes(v)) mutate("PUT", "settings", { [key]: [...db.settings[key], v] });
    }));
    // Language has its own instant save, separate from the currency form.
    $("#language-select").onchange = async (e) => {
      const language = e.target.value;
      try { await mutate("PUT", "settings", { language }); } catch { return; }
      await loadLocale(resolveLanguage(language));
      render();
    };
    const cf = $("#currency-form");
    const preview = () => ($("#currency-preview").textContent = money(12345.5, readCurrencyForm(cf)));
    cf.currency_code.onchange = () => {
      const known = CURRENCIES.find(([c]) => c === cf.currency_code.value);
      $("#custom-currency").hidden = !!known;
      if (known) cf.currency_position.value = known[2] ? "before" : "after";
      preview();
    };
    cf.oninput = preview;
    cf.onsubmit = (e) => {
      e.preventDefault();
      mutate("PUT", "settings", readCurrencyForm(cf), t("settings.currency_saved"));
    };
    preview();
    $("#budget-form").onsubmit = (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.target).entries());
      mutate("PUT", "settings", { budget_groceries: num(v.budget_groceries), budget_home: num(v.budget_home), budget_car: num(v.budget_car), budget_bills: num(v.budget_bills) }, t("common.saved"));
    };
    $("#import-file").onchange = async (e) => {
      const file = e.target.files[0];
      if (!file || !(await askConfirm(t("settings.import_confirm")))) return;
      try { await mutate("POST", "import", JSON.parse(await file.text()), t("settings.imported")); }
      catch { toast(t("settings.import_failed"), true); }
    };
  },
};

function bindShopping() {
  const form = $("#checkout");
  // Keep footer inputs in localStorage so a page reload in the store loses nothing.
  form.oninput = form.onchange = () => {
    Object.assign(ui.shopping, Object.fromEntries(new FormData(form).entries()));
    saveShopping();
  };
  $("#cancel-shop").onclick = async () => {
    if (ui.shopping.checked.length && !(await askConfirm(t("shop.exit_confirm")))) return;
    ui.shopping = null; saveShopping(); render();
  };
  $("#view").onclick = (e) => {
    const li = e.target.closest("[data-check]");
    if (!li) return;
    const set = new Set(ui.shopping.checked);
    set.has(li.dataset.check) ? set.delete(li.dataset.check) : set.add(li.dataset.check);
    ui.shopping.checked = [...set];
    saveShopping();
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form).entries());
    const left = db.groceries.length - ui.shopping.checked.length;
    const shopping = ui.shopping;
    ui.shopping = null;
    try {
      await mutate("POST", "groceries/checkout", { ...v, total: num(v.total), bought_ids: shopping.checked },
        left ? t("shop.saved_left", { n: left }) : t("shop.saved_all"));
      saveShopping();
    } catch {
      ui.shopping = shopping;
      render();
    }
  };
}

// --- start -------------------------------------------------------------------
// The locale depends on settings.language, so it is loaded after the state and before the first render.
(async () => {
  ui.me = await api("GET", "me").catch(() => null);
  try {
    db = await api("GET", "state");
    await loadLocale(resolveLanguage(db.settings?.language));
    render();
  } catch (e) {
    if (!db) await loadLocale(resolveLanguage());
    $("#view").innerHTML = `<div class="card empty">${t("common.load_failed", { error: esc(e.message) })}</div>`;
  }
})();
