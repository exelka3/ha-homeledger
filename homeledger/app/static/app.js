/* Home Budget — frontend (vanilla JS, no build step).
 * All requests use relative URLs so the app works behind Home Assistant Ingress. */

const COLORS = ["#4353ff", "#e0566b", "#1f9e74", "#e08a3c", "#8a5cf6", "#2a9fb8", "#a07655", "#6b7686"];
const KINDS = {
  home: { label: "Обустройство", color: "#5b6cff" },
  groceries: { label: "Продукты", color: "#1f9e74" },
  car: { label: "Авто", color: "#e08a3c" },
  bills: { label: "Платежи", color: "#b9548c" },
};
const kindDot = (k) => `<span class="dot" style="background:${KINDS[k].color}"></span>`;
const KIND_COLORS = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.color]));
const CAR_DOCS = [
  ["osago_until", "ОСАГО"],
  ["kasko_until", "КАСКО"],
  ["inspection_until", "Техосмотр"],
  ["next_service_date", "Плановое ТО"],
];
const PLAN_STATUS = { idea: "Идея", planned: "Запланировано", in_progress: "В работе", done: "Готово" };
const PRIORITY = { high: "Высокий", medium: "Средний", low: "Низкий" };
// [code, symbol, name, symbol goes before the number]
const CURRENCIES = [
  ["RUB", "₽", "Российский рубль"], ["USD", "$", "Доллар США", true], ["EUR", "€", "Евро"],
  ["KZT", "₸", "Казахстанский тенге"], ["BYN", "Br", "Белорусский рубль"], ["UAH", "₴", "Украинская гривна"],
  ["UZS", "сум", "Узбекский сум"], ["KGS", "сом", "Киргизский сом"], ["AMD", "֏", "Армянский драм"],
  ["GEL", "₾", "Грузинский лари"], ["AZN", "₼", "Азербайджанский манат"], ["TRY", "₺", "Турецкая лира"],
  ["CNY", "¥", "Китайский юань"], ["GBP", "£", "Фунт стерлингов", true], ["PLN", "zł", "Польский злотый"],
  ["CZK", "Kč", "Чешская крона"], ["AED", "AED", "Дирхам ОАЭ"], ["THB", "฿", "Тайский бат"],
];
const MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

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
const today = () => new Date().toISOString().slice(0, 10);
const num = (v) => (Number.isFinite(+v) ? +v : 0);
function money(v, settings = db?.settings || {}) {
  const decimals = settings.currency_decimals === false ? 0 : num(v) % 1 ? 2 : 0;
  const n = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(num(v));
  const sym = settings.currency || "₽";
  return settings.currency_position === "before" ? sym + n : n + " " + sym;
}
const monthKey = (d) => String(d || "").slice(0, 7);
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
    headers: body ? { "Content-Type": "application/json" } : {},
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
function openForm({ title, fields, submitLabel = "Сохранить", onSubmit, onDelete, note = "" }) {
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
    if (!confirm("Удалить запись?")) return;
    closeModal();
    await onDelete();
  };
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
  }
  return `<label class="field"><span>${esc(f.label)}</span>${input}</label>`;
}

function closeModal() {
  $("#modal").hidden = true;
}
$("#modal-cancel").onclick = closeModal;
$("#modal").addEventListener("click", (e) => e.target.id === "modal" && closeModal());
document.addEventListener("keydown", (e) => e.key === "Escape" && closeModal());

const residentOptions = (withEmpty = true) => [...(withEmpty ? [["", "— не указано —"]] : []), ...db.residents.map((r) => [r.id, r.name])];
const methodOptions = () => [["", "— не указано —"], ...db.settings.payment_methods.map((m) => [m, m])];

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
      category: plans[i.plan_id]?.room || "Без комнаты",
      title: i.name,
    }));
  const groceries = db.trips.map((t) => ({
    kind: "groceries",
    date: t.date,
    amount: num(t.total),
    payer_id: t.payer_id,
    method: t.payment_method,
    category: "Продукты",
    store: t.store || "Магазин не указан",
    title: t.store ? `Продукты — ${t.store}` : "Продукты",
  }));
  const cars = Object.fromEntries(db.cars.map((c) => [c.id, c]));
  const car = db.car_expenses.map((x) => ({
    kind: "car",
    date: x.date,
    amount: num(x.amount),
    payer_id: x.payer_id,
    method: x.payment_method,
    category: x.category || "Другое",
    car_id: x.car_id,
    title: `${x.category || "Авто"} — ${carName(cars[x.car_id])}`,
  }));
  const bills = db.payments.map((p) => ({
    kind: "bills",
    date: p.date,
    amount: num(p.amount),
    payer_id: p.payer_id,
    method: p.payment_method,
    category: p.category || "Другое",
    title: p.name,
  }));
  return [...home, ...groceries, ...car, ...bills].sort((a, b) => (a.date < b.date ? 1 : -1));
}

const carName = (c) => (c ? c.name + (c.plate ? ` (${c.plate})` : "") : "авто");
const sumAmount = (list) => list.reduce((s, e) => s + e.amount, 0);

function docStatus(date) {
  if (!date) return null;
  const days = Math.round((new Date(date) - new Date(today())) / 86400000);
  return { days, cls: days < 0 ? "expired" : days <= 30 ? "soon" : "ok" };
}

function carReminders() {
  const out = [];
  for (const c of db.cars) for (const [key, label] of CAR_DOCS) {
    const st = docStatus(c[key]);
    if (st && st.cls !== "ok") out.push({ car: c, label, date: c[key], ...st });
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
  if (!entries.length) return `<div class="empty small">Нет данных</div>`;
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
      const tip = `${MONTHS[+d.k.slice(5) - 1]} ${d.k.slice(0, 4)}: ${money(d.tot)}\n` +
        kinds.filter((k) => d.byKind[k]).map((k) => `${KINDS[k].label}: ${money(d.byKind[k])}`).join("\n");
      return `<div class="col" title="${esc(tip)}">
        <div class="val">${d.tot ? shortMoney(d.tot) : ""}</div>
        <div class="stack" style="height:${(d.tot / max) * 140}px">
          ${kinds.map((k) => `<div style="height:${d.tot ? (d.byKind[k] / d.tot) * 100 : 0}%;background:${KINDS[k].color}"></div>`).join("")}
        </div>
        <div class="cap">${MONTHS[+d.k.slice(5) - 1]}</div></div>`;
    })
    .join("")}</div>
    <div class="legend">${kinds.map((k) => `<span><i class="dot" style="background:${KINDS[k].color}"></i>${KINDS[k].label}</span>`).join("")}</div>`;
}

const shortMoney = (v) => (v >= 1000 ? Math.round(v / 1000) + "k" : String(Math.round(v)));

function lastMonths(n) {
  const now = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (n - 1 - i), 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
}

function budgetBar(spent, budget) {
  if (!budget) return `<div class="sub">Бюджет не задан</div>`;
  const pct = (spent / budget) * 100;
  return `<div class="progress ${pct > 100 ? "over" : ""}" style="margin-top:8px"><div style="width:${Math.min(pct, 100)}%"></div></div>
    <div class="sub">${Math.round(pct)}% из ${money(budget)} · ${pct > 100 ? "перерасход " + money(spent - budget) : "осталось " + money(budget - spent)}</div>`;
}

// --- views -----------------------------------------------------------------
const views = { overview, plans, groceries, cars, bills, stats, settings };

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
    ? `<div class="card row"><div class="grow">Начните с жителей дома — тогда можно будет отмечать, кто за что платит.</div><span class="spacer"></span>
       <button class="btn primary" data-goto="settings">Добавить жителей</button></div>`
    : "";

  return `
    ${noResidents}
    ${reminders.length ? `<div class="card callout warn" style="margin-bottom:12px"><div class="row"><h3>Документы на авто</h3><span class="spacer"></span>
        <button class="btn sm" data-goto="cars">Открыть</button></div>
      <ul class="list">${reminders.map((r) => `<li><div class="grow">${esc(r.label)} — ${esc(carName(r.car))}</div>
        <span class="doc ${r.cls}">${r.days < 0 ? "просрочено" : r.days === 0 ? "сегодня" : "через " + r.days + " дн."} · ${fmtDate(r.date)}</span></li>`).join("")}</ul></div>` : ""}
    ${dueSoon.length ? `<div class="card callout" style="margin-bottom:12px"><div class="row"><h3>Платежи на этой неделе</h3><span class="spacer"></span>
        <button class="btn sm" data-goto="bills">Все платежи</button></div>
      <ul class="list due-list">${dueSoon.map(dueRow).join("")}</ul></div>` : ""}
    <div class="grid kpi" style="margin-top:${noResidents ? 12 : 0}px">
      <div class="card kpi"><div class="label">Всего за месяц</div><div class="value num">${money(home + groc + car + billsSum)}</div>
        <div class="sub">${month.length} операций</div></div>
      <div class="card kpi"><div class="label">${kindDot("groceries")}Продукты за месяц</div><div class="value num">${money(groc)}</div>
        ${budgetBar(groc, db.settings.budget_groceries)}</div>
      <div class="card kpi"><div class="label">${kindDot("home")}Обустройство за месяц</div><div class="value num">${money(home)}</div>
        ${budgetBar(home, db.settings.budget_home)}</div>
      <div class="card kpi"><div class="label">${kindDot("car")}Авто за месяц</div><div class="value num">${money(car)}</div>
        ${budgetBar(car, db.settings.budget_car)}</div>
      <div class="card kpi"><div class="label">${kindDot("bills")}Платежи за месяц</div><div class="value num">${money(billsSum)}</div>
        ${budgetBar(billsSum, db.settings.budget_bills)}</div>
    </div>

    <div class="grid two" style="margin-top:12px">
      <div class="card">
        <div class="row"><h3>Список продуктов</h3><span class="spacer"></span><button class="btn sm" data-goto="groceries">Открыть</button></div>
        ${db.groceries.length
          ? `<div class="row">${db.groceries.slice(0, 18).map((g) => `<span class="chip">${esc(g.name)}${g.qty ? ` · ${esc(g.qty)}` : ""}</span>`).join("")}
             ${db.groceries.length > 18 ? `<span class="muted small">и ещё ${db.groceries.length - 18}</span>` : ""}</div>`
          : `<div class="empty small">Список пуст</div>`}
      </div>
      <div class="card">
        <div class="row"><h3>Активные планы</h3><span class="spacer"></span><button class="btn sm" data-goto="plans">Все планы</button></div>
        <div class="muted small" style="margin:-4px 0 10px">Осталось купить: <b class="num" style="color:var(--text)">${money(plannedSum)}</b> · ${planned.length} позиций</div>
        ${activePlans.length
          ? `<ul class="list">${activePlans.slice(0, 6).map((p) => {
              const items = db.plan_items.filter((i) => i.plan_id === p.id);
              const total = items.reduce((s, i) => s + itemTotal(i), 0);
              const done = items.filter((i) => i.status === "bought").reduce((s, i) => s + itemTotal(i), 0);
              return `<li><div class="grow"><div class="title">${esc(p.title)}</div>
                <div class="progress" style="margin-top:4px"><div style="width:${total ? (done / total) * 100 : 0}%"></div></div></div>
                <span class="badge ${p.status}">${PLAN_STATUS[p.status] || ""}</span><span class="num small">${money(total)}</span></li>`;
            }).join("")}</ul>`
          : `<div class="empty small">Нет активных планов</div>`}
      </div>
    </div>

    <div class="card" style="margin-top:12px">
      <h3>Последние траты</h3>
      ${ex.length
        ? `<ul class="list">${ex.slice(0, 8).map((e) => `<li><span class="dot" style="background:${KIND_COLORS[e.kind]}"></span>
            <div class="grow"><div class="title">${esc(e.title)}</div><div class="muted small">${fmtDate(e.date)} · ${esc(e.method || "способ не указан")}</div></div>
            ${residentChip(e.payer_id)}<span class="num">${money(e.amount)}</span></li>`).join("")}</ul>`
        : `<div class="empty small">Пока нет трат</div>`}
    </div>`;
}

function fmtDate(d) {
  if (!d) return "";
  const [y, m, day] = d.slice(0, 10).split("-");
  return `${+day} ${MONTHS[+m - 1]} ${y}`;
}

// Plans ---------------------------------------------------------------------
function plans() {
  const f = ui.planFilter;
  const list = db.plans
    .filter((p) => (!f.room || p.room === f.room) && (!f.status || p.status === f.status))
    .sort((a, b) => (a.status === "done") - (b.status === "done") || ["high", "medium", "low"].indexOf(a.priority) - ["high", "medium", "low"].indexOf(b.priority));

  const allItems = db.plan_items;
  const planned = allItems.filter((i) => i.status !== "bought").reduce((s, i) => s + itemTotal(i), 0);
  const bought = allItems.filter((i) => i.status === "bought").reduce((s, i) => s + itemTotal(i), 0);
  const rooms = [...new Set([...db.settings.rooms, ...db.plans.map((p) => p.room).filter(Boolean)])];

  return `
    <div class="row"><h2>Обустройство дома</h2><span class="spacer"></span>
      <button class="btn primary" id="add-plan">＋ Новый план</button></div>
    <div class="grid kpi" style="margin-bottom:12px">
      <div class="card kpi"><div class="label">Осталось купить</div><div class="value num">${money(planned)}</div></div>
      <div class="card kpi"><div class="label">Уже куплено</div><div class="value num">${money(bought)}</div></div>
      <div class="card kpi wide"><div class="label">Кто платит (план)</div>
        <div style="margin-top:6px">${sumBy(allItems.filter((i) => i.status !== "bought").map((i) => ({ ...i, amount: itemTotal(i) })), (i) => i.payer_id)
          .map(([id, v]) => `<div class="row small" style="flex-wrap:nowrap">${id === "—" ? '<span class="muted">не назначено</span>' : residentChip(id)}<span class="spacer"></span><span class="num">${money(v)}</span></div>`).join("") || '<span class="muted small">—</span>'}</div></div>
    </div>
    <div class="row filters">
      <select id="f-room"><option value="">Все комнаты</option>${rooms.map((r) => `<option ${r === f.room ? "selected" : ""}>${esc(r)}</option>`).join("")}</select>
      <select id="f-status"><option value="">Все статусы</option>${Object.entries(PLAN_STATUS).map(([k, v]) => `<option value="${k}" ${k === f.status ? "selected" : ""}>${v}</option>`).join("")}</select>
    </div>
    ${list.length ? list.map(planCard).join("") : `<div class="card empty">Планов пока нет. Добавьте первый — например «Ремонт кухни».</div>`}`;
}

function planCard(p) {
  const items = db.plan_items.filter((i) => i.plan_id === p.id);
  const total = items.reduce((s, i) => s + itemTotal(i), 0);
  const done = items.filter((i) => i.status === "bought").reduce((s, i) => s + itemTotal(i), 0);
  return `<div class="card" data-plan="${p.id}">
    <div class="plan-head">
      <div class="grow">
        <div class="row"><h3>${esc(p.title)}</h3><span class="badge ${p.status}">${PLAN_STATUS[p.status] || ""}</span>
          ${p.priority === "high" ? '<span class="badge urgent">Важно</span>' : ""}</div>
        <div class="muted small">${[p.room, p.deadline ? "до " + fmtDate(p.deadline) : "", p.note].filter(Boolean).map(esc).join(" · ")}</div>
      </div>
      <div class="plan-sum"><div class="big num">${money(total)}</div><div class="muted small num">куплено ${money(done)}</div></div>
      <button class="icon-btn" data-edit-plan="${p.id}" title="Редактировать">✎</button>
    </div>
    <div class="progress" style="margin:10px 0"><div style="width:${total ? (done / total) * 100 : 0}%"></div></div>
    ${items.length ? `<table class="items"><thead><tr><th></th><th>Что купить</th><th class="r">Цена</th><th>Кто платит · способ</th><th></th></tr></thead><tbody>
      ${items.map((i) => `<tr class="${i.status === "bought" ? "bought" : ""}">
        <td><input type="checkbox" data-toggle-item="${i.id}" ${i.status === "bought" ? "checked" : ""} title="Куплено"></td>
        <td class="name">${i.link ? `<a href="${esc(i.link)}" target="_blank" rel="noopener">${esc(i.name)}</a>` : esc(i.name)}
          ${num(i.qty) > 1 ? `<span class="muted small">× ${i.qty}</span>` : ""}</td>
        <td class="r num price">${money(itemTotal(i))}</td>
        <td class="meta"><div class="row">${residentChip(i.payer_id)}${i.payment_method ? `<span class="muted small">${esc(i.payment_method)}</span>` : ""}
          ${i.status === "bought" && i.bought_at ? `<span class="muted small">· ${fmtDate(i.bought_at)}</span>` : ""}</div></td>
        <td class="r act"><button class="icon-btn" data-edit-item="${i.id}" title="Редактировать">✎</button></td></tr>`).join("")}
      </tbody></table>` : `<div class="muted small">Добавьте вещи, которые нужно купить для этого плана.</div>`}
    <div style="margin-top:8px"><button class="btn sm ghost" data-add-item="${p.id}">＋ Добавить вещь</button></div>
  </div>`;
}

function planForm(p = {}) {
  openForm({
    title: p.id ? "Редактировать план" : "Новый план",
    fields: [
      { name: "title", label: "Название", value: p.title, required: true, placeholder: "Ремонт кухни" },
      { type: "row", fields: [
        { name: "room", label: "Комната / зона", value: p.room, datalist: db.settings.rooms },
        { name: "status", label: "Статус", type: "select", value: p.status || "planned", options: Object.entries(PLAN_STATUS) },
      ] },
      { type: "row", fields: [
        { name: "priority", label: "Приоритет", type: "select", value: p.priority || "medium", options: Object.entries(PRIORITY) },
        { name: "deadline", label: "Срок", type: "date", value: p.deadline },
      ] },
      { name: "note", label: "Заметка", type: "textarea", value: p.note },
    ],
    onSubmit: (v) => (p.id ? mutate("PUT", `plans/${p.id}`, v) : mutate("POST", "plans", v, "План создан")),
    onDelete: p.id ? () => mutate("DELETE", `plans/${p.id}`, null, "План удалён") : null,
  });
}

function itemForm(planId, i = {}) {
  openForm({
    title: i.id ? "Редактировать вещь" : "Добавить вещь",
    fields: [
      { name: "name", label: "Что купить", value: i.name, required: true, placeholder: "Смеситель для кухни" },
      { type: "row", fields: [
        { name: "price", label: `Цена за шт., ${db.settings.currency}`, type: "number", value: i.price, required: true },
        { name: "qty", label: "Количество", type: "number", step: "1", value: i.qty || 1 },
      ] },
      { type: "row", fields: [
        { name: "payer_id", label: "Кто оплачивает", type: "select", value: i.id ? i.payer_id : meId(), options: residentOptions() },
        { name: "payment_method", label: "Способ оплаты", type: "select", value: i.payment_method, options: methodOptions() },
      ] },
      { type: "row", fields: [
        { name: "status", label: "Статус", type: "select", value: i.status || "planned", options: [["planned", "Нужно купить"], ["bought", "Куплено"]] },
        { name: "bought_at", label: "Дата покупки", type: "date", value: i.bought_at },
      ] },
      { name: "link", label: "Ссылка на товар", type: "url", value: i.link, placeholder: "https://…" },
    ],
    onSubmit: (v) => {
      if (v.status === "bought" && !v.bought_at) v.bought_at = today();
      if (v.status !== "bought") v.bought_at = "";
      return i.id ? mutate("PUT", `plan_items/${i.id}`, v) : mutate("POST", "plan_items", { ...v, plan_id: planId }, "Добавлено");
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
    const c = g.category || "Другое";
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
  for (const t of db.trips) for (const it of t.items) {
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
  return db.trips.flatMap((t) => t.items).reverse().find((i) => i.name.trim().toLowerCase() === n)?.category || "Другое";
}

const storesDatalist = () => `<datalist id="dl-stores">${db.settings.stores.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>`;

function groceries() {
  if (ui.shopping) return shoppingMode();
  const groups = groupByCategory(db.groceries);
  const sug = suggestions();
  const trips = [...db.trips].sort((a, b) => (a.date < b.date ? 1 : -1));
  return `
    <div class="row"><h2>Список продуктов</h2><span class="spacer"></span>
      <button class="btn primary big" id="start-shop" ${db.groceries.length ? "" : "disabled"}>Иду в магазин</button></div>
    <div class="card">
      <form class="add-bar" id="add-grocery">
        <input name="name" placeholder="Добавить продукт…" required list="dl-gnames">
        <input name="qty" placeholder="Кол-во">
        <select name="category"><option value="">Категория: авто</option>${groceryCategories().map((c) => `<option>${esc(c)}</option>`).join("")}</select>
        <button class="btn primary">Добавить</button>
        <datalist id="dl-gnames">${[...new Set(db.trips.flatMap((t) => t.items.map((i) => i.name)))].map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
      </form>
      ${sug.length ? `<div class="suggest"><span class="muted small">Часто покупаете:</span>${sug.map((s) => `<span class="sug ${s.fav ? "fav" : ""}">
          <button data-sug="${esc(s.name)}" data-cat="${esc(s.category)}">${s.fav ? "★" : "＋"} ${esc(s.name)}</button><button class="x" data-hide-sug="${esc(s.name)}" data-fav="${s.fav ? 1 : ""}" title="${s.fav ? "Убрать из избранного" : "Больше не предлагать"}">✕</button></span>`).join("")}
          <button class="link" data-goto="settings">Настроить</button></div>` : ""}
      ${groups.length
        ? groups.map(([cat, items]) => `<div class="cat-title">${esc(cat)}</div><ul class="list">${items.map((g) => `<li>
            <div class="grow"><span class="title">${esc(g.name)}</span>${g.qty ? ` <span class="muted small">· ${esc(g.qty)}</span>` : ""}</div>
            ${g.added_by ? residentChip(g.added_by) : ""}
            <button class="icon-btn" data-edit-grocery="${g.id}" title="Изменить">✎</button>
            <button class="icon-btn" data-del-grocery="${g.id}" title="Убрать">✕</button></li>`).join("")}</ul>`).join("")
        : `<div class="empty">Список пуст — добавьте продукты, которые нужно купить.</div>`}
    </div>

    <div class="card">
      <h3>История покупок</h3>
      ${trips.length ? `<ul class="list">${trips.slice(0, 30).map((t) => `<li style="align-items:flex-start">
          <div class="grow"><div class="title">${fmtDate(t.date)}${t.store ? " · " + esc(t.store) : ""}</div>
          <div class="muted small">${t.items.map((i) => esc(i.name)).join(", ")}${t.skipped ? ` · <i>не куплено: ${t.skipped}</i>` : ""}</div></div>
          <div style="text-align:right"><div class="num"><b>${money(t.total)}</b></div><div class="row" style="justify-content:flex-end">${residentChip(t.payer_id)}</div>
          <div class="muted small">${esc(t.payment_method || "")}</div></div>
          <button class="icon-btn" data-edit-trip="${t.id}" title="Изменить">✎</button></li>`).join("")}</ul>`
        : `<div class="empty small">Покупок ещё не было</div>`}
    </div>`;
}

function shoppingMode() {
  const checked = new Set(ui.shopping.checked);
  const groups = groupByCategory(db.groceries);
  const n = db.groceries.filter((g) => checked.has(g.id)).length;
  const s = ui.shopping;
  return `
    <div class="row"><h2>В магазине</h2><span class="spacer"></span>
      <button class="btn ghost" id="cancel-shop">Выйти без сохранения</button></div>
    <div class="card">
      <div class="muted small">Отмечайте купленное. Неотмеченные продукты останутся в списке.</div>
      ${groups.map(([cat, items]) => `<div class="cat-title">${esc(cat)}</div><ul class="list shop">${items.map((g) => `
        <li data-check="${g.id}" class="${checked.has(g.id) ? "on" : ""}"><span class="check">✓</span>
          <div class="grow"><span class="title">${esc(g.name)}</span>${g.qty ? ` <span class="muted small">· ${esc(g.qty)}</span>` : ""}</div></li>`).join("")}</ul>`).join("")}
      <form class="shop-footer" id="checkout">
        <div class="fields">
          <label class="field"><span>Сумма чека, ${esc(db.settings.currency)}</span><input name="total" type="number" step="any" min="0" inputmode="decimal" required value="${esc(s.total || "")}"></label>
          <label class="field"><span>Магазин</span><input name="store" list="dl-stores" value="${esc(s.store || "")}">${storesDatalist()}</label>
          <label class="field"><span>Кто платил</span><select name="payer_id">${residentOptions().map(([v, l]) => `<option value="${v}" ${v === (s.payer_id ?? (meId() || lastTrip()?.payer_id)) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
          <label class="field"><span>Способ оплаты</span><select name="payment_method">${methodOptions().map(([v, l]) => `<option value="${esc(v)}" ${v === (s.payment_method ?? lastTrip()?.payment_method) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
        </div>
        <button class="btn primary big" style="width:100%" ${n ? "" : "disabled"}>Завершить покупку · отмечено ${n} из ${db.groceries.length}</button>
      </form>
    </div>`;
}

const lastTrip = () => [...db.trips].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
const saveShopping = () => localStorage.setItem("hb.shopping", JSON.stringify(ui.shopping));

function tripForm(t) {
  openForm({
    title: "Покупка " + fmtDate(t.date),
    fields: [
      { type: "row", fields: [
        { name: "date", label: "Дата", type: "date", value: t.date, required: true },
        { name: "total", label: "Сумма чека", type: "number", value: t.total, required: true },
      ] },
      { name: "store", label: "Магазин", value: t.store, datalist: db.settings.stores },
      { type: "row", fields: [
        { name: "payer_id", label: "Кто платил", type: "select", value: t.payer_id, options: residentOptions() },
        { name: "payment_method", label: "Способ оплаты", type: "select", value: t.payment_method, options: methodOptions() },
      ] },
    ],
    onSubmit: (v) => mutate("PUT", `trips/${t.id}`, v),
    onDelete: () => mutate("DELETE", `trips/${t.id}`, null, "Покупка удалена"),
  });
}

// Cars ----------------------------------------------------------------------
function cars() {
  const carEx = expenses().filter((e) => e.kind === "car");
  const month = carEx.filter((e) => inPeriod(e.date, "month"));
  const year = carEx.filter((e) => inPeriod(e.date, "year"));
  return `
    <div class="row"><h2>Автомобили</h2><span class="spacer"></span>
      <button class="btn" id="add-car-expense" ${db.cars.length ? "" : "disabled"}>＋ Расход</button>
      <button class="btn primary" id="add-car">＋ Автомобиль</button></div>
    <div class="grid kpi" style="margin-bottom:12px">
      <div class="card kpi"><div class="label">Авто за месяц</div><div class="value num">${money(sumAmount(month))}</div>
        ${budgetBar(sumAmount(month), db.settings.budget_car)}</div>
      <div class="card kpi"><div class="label">За 12 месяцев</div><div class="value num">${money(sumAmount(year))}</div>
        <div class="sub">≈ ${money(Math.round(sumAmount(year) / 12))} в месяц</div></div>
      <div class="card kpi wide"><div class="label">Месяц по категориям</div>
        <div style="margin-top:6px">${sumBy(month, (e) => e.category).slice(0, 4)
          .map(([k, v]) => `<div class="row small" style="flex-wrap:nowrap"><span>${esc(k)}</span><span class="spacer"></span><span class="num">${money(v)}</span></div>`).join("") || '<span class="muted small">—</span>'}</div></div>
    </div>
    ${db.cars.length ? db.cars.map((c) => carCard(c, carEx)).join("") : `<div class="card empty">Добавьте автомобили семьи — с госномером, VIN, СТС и сроками ОСАГО и техосмотра.</div>`}`;
}

function carCard(c, carEx) {
  const list = db.car_expenses.filter((x) => x.car_id === c.id).sort((a, b) => (a.date < b.date ? 1 : -1));
  const mine = carEx.filter((e) => e.car_id === c.id);
  const expanded = ui.carsExpanded.has(c.id);
  const shown = expanded ? list : list.slice(0, 5);
  const docs = CAR_DOCS.filter(([k]) => c[k]).map(([k, label]) => {
    const st = docStatus(c[k]);
    return `<span class="doc ${st.cls}" title="${st.days < 0 ? "Просрочено" : "Осталось " + st.days + " дн."}">${label} до ${fmtDate(c[k])}</span>`;
  });
  const reg = [
    c.vin && `VIN ${esc(c.vin)}`,
    c.sts && `СТС ${esc(c.sts)}`,
    c.registered_at && `на учёте с ${fmtDate(c.registered_at)}`,
    c.mileage && `пробег ${new Intl.NumberFormat("ru-RU").format(c.mileage)} км`,
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
        <div class="muted small num">в этом месяце · всего ${money(sumAmount(mine))}</div></div>
      <button class="icon-btn" data-edit-car="${c.id}" title="Редактировать">✎</button>
    </div>
    ${docs.length ? `<div class="row" style="margin-top:10px">${docs.join("")}</div>` : ""}
    ${list.length ? `<ul class="list" style="margin-top:8px">${shown.map((x) => `<li>
        <div class="grow"><div class="title">${esc(x.category || "Другое")}${x.note ? ` <span class="muted small">· ${esc(x.note)}</span>` : ""}</div>
        <div class="muted small">${fmtDate(x.date)}${x.mileage ? ` · ${new Intl.NumberFormat("ru-RU").format(x.mileage)} км` : ""}${x.liters ? ` · ${x.liters} л` : ""}${x.payment_method ? " · " + esc(x.payment_method) : ""}</div></div>
        ${residentChip(x.payer_id)}<span class="num">${money(x.amount)}</span>
        <button class="icon-btn" data-edit-cexp="${x.id}" title="Изменить">✎</button></li>`).join("")}</ul>
      ${list.length > 5 ? `<button class="btn sm ghost" data-expand-car="${c.id}">${expanded ? "Свернуть" : `Показать все (${list.length})`}</button>` : ""}`
      : `<div class="muted small" style="margin-top:8px">Расходов пока нет.</div>`}
    <div style="margin-top:8px"><button class="btn sm ghost" data-add-cexp="${c.id}">＋ Добавить расход</button></div>
  </div>`;
}

function carForm(c = {}) {
  openForm({
    title: c.id ? "Автомобиль" : "Новый автомобиль",
    fields: [
      { type: "row", fields: [
        { name: "name", label: "Марка и модель", value: c.name, required: true, placeholder: "Kia Rio" },
        { name: "year", label: "Год выпуска", type: "number", step: "1", value: c.year },
      ] },
      { type: "row", fields: [
        { name: "plate", label: "Госномер", value: c.plate, placeholder: "А123ВС 77" },
        { name: "owner_id", label: "Владелец", type: "select", value: c.owner_id, options: residentOptions() },
      ] },
      { name: "vin", label: "VIN", value: c.vin },
      { type: "row", fields: [
        { name: "sts", label: "Номер СТС", value: c.sts },
        { name: "registered_at", label: "Дата постановки на учёт", type: "date", value: c.registered_at },
      ] },
      { type: "row", fields: [
        { name: "osago_until", label: "ОСАГО действует до", type: "date", value: c.osago_until },
        { name: "kasko_until", label: "КАСКО действует до", type: "date", value: c.kasko_until },
      ] },
      { type: "row", fields: [
        { name: "inspection_until", label: "Техосмотр до", type: "date", value: c.inspection_until },
        { name: "next_service_date", label: "Следующее ТО", type: "date", value: c.next_service_date },
      ] },
      { type: "row", fields: [
        { name: "mileage", label: "Пробег, км", type: "number", step: "1", value: c.mileage },
        { name: "color", label: "Цвет", type: "color", value: c.color || "#607d8b" },
      ] },
      { name: "note", label: "Заметка", type: "textarea", value: c.note },
    ],
    onSubmit: (v) => (c.id ? mutate("PUT", `cars/${c.id}`, v) : mutate("POST", "cars", v, "Автомобиль добавлен")),
    onDelete: c.id ? () => mutate("DELETE", `cars/${c.id}`, null, "Автомобиль и его расходы удалены") : null,
  });
}

function carExpenseForm(x = {}) {
  const car = db.cars.find((c) => c.id === x.car_id);
  openForm({
    title: x.id ? "Расход на авто" : "Новый расход на авто",
    fields: [
      { type: "row", fields: [
        { name: "car_id", label: "Автомобиль", type: "select", value: x.car_id, options: db.cars.map((c) => [c.id, carName(c)]) },
        { name: "category", label: "Категория", type: "select", value: x.category || db.settings.car_categories[0], options: db.settings.car_categories.map((k) => [k, k]) },
      ] },
      { type: "row", fields: [
        { name: "amount", label: `Сумма, ${db.settings.currency}`, type: "number", value: x.amount, required: true },
        { name: "date", label: "Дата", type: "date", value: x.date || today(), required: true },
      ] },
      { type: "row", fields: [
        { name: "payer_id", label: "Кто платил", type: "select", value: x.payer_id ?? (meId() || car?.owner_id), options: residentOptions() },
        { name: "payment_method", label: "Способ оплаты", type: "select", value: x.payment_method, options: methodOptions() },
      ] },
      { type: "row", fields: [
        { name: "mileage", label: "Пробег, км", type: "number", step: "1", value: x.mileage },
        { name: "liters", label: "Литров (для топлива)", type: "number", value: x.liters },
      ] },
      { name: "note", label: "Комментарий", value: x.note, placeholder: "Замена масла, АЗС Лукойл…" },
    ],
    onSubmit: async (v) => {
      await (x.id ? mutate("PUT", `car_expenses/${x.id}`, v) : mutate("POST", "car_expenses", v, "Расход добавлен"));
      // Keep the car's odometer at the highest mileage seen in its expenses.
      const target = db.cars.find((c) => c.id === v.car_id);
      if (target && num(v.mileage) > num(target.mileage)) await mutate("PUT", `cars/${target.id}`, { mileage: v.mileage });
    },
    onDelete: x.id ? () => mutate("DELETE", `car_expenses/${x.id}`) : null,
  });
}

// Bills (recurring payments) ------------------------------------------------
const FREQUENCIES = { weekly: "Еженедельно", monthly: "Ежемесячно", quarterly: "Раз в квартал", halfyear: "Раз в полгода", yearly: "Раз в год" };
const PER_MONTH = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, halfyear: 1 / 6, yearly: 1 / 12 };

const daysUntil = (d) => Math.round((new Date(d) - new Date(today())) / 86400000);
const recurringById = (id) => db.recurring.find((r) => r.id === id);

function dueChip(date) {
  const days = daysUntil(date);
  const cls = days < 0 ? "expired" : days <= 3 ? "soon" : "ok";
  const text = days < 0 ? `просрочено ${-days} дн.` : days === 0 ? "сегодня" : days === 1 ? "завтра" : `через ${days} дн.`;
  return `<span class="doc ${cls}" title="${fmtDate(date)}">${text} · ${fmtDate(date)}</span>`;
}

// One row of an upcoming payment with its actions; shared by Overview and Bills.
function dueRow(r) {
  const actions = r.auto
    ? `<span class="badge" title="Будет отмечен автоматически в день платежа">авто</span>`
    : `<button class="btn sm primary" data-pay="${r.id}">Оплачено</button><button class="btn sm ghost" data-skip="${r.id}" title="Пропустить этот период">Пропустить</button>`;
  return `<li><div class="grow"><div class="title">${esc(r.name)}</div>
      <div class="muted small">${esc(r.category || "")}${r.payer_id ? "" : " · плательщик не назначен"}</div></div>
    ${r.payer_id ? residentChip(r.payer_id) : ""}
    <span class="num">${r.variable ? "≈ " : ""}${money(r.amount)}</span>${dueChip(r.next_due)}
    <span class="row" style="flex-wrap:nowrap">${actions}</span></li>`;
}

function bills() {
  const nowMonth = today().slice(0, 7);
  const active = db.recurring.filter((r) => r.next_due);
  const finished = db.recurring.filter((r) => !r.next_due);
  const due = [...active].sort((a, b) => (a.next_due < b.next_due ? -1 : 1));
  const leftThisMonth = active.filter((r) => r.next_due.slice(0, 7) <= nowMonth);
  const paidThisMonth = db.payments.filter((p) => monthKey(p.date) === nowMonth);
  const perMonth = active.reduce((s, r) => s + num(r.amount) * (PER_MONTH[r.frequency] || 1), 0);
  const history = [...db.payments].sort((a, b) => (a.date < b.date ? 1 : -1));
  const groups = new Map();
  for (const r of active) {
    const c = r.category || "Другое";
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(r);
  }

  return `
    <div class="row"><h2>Регулярные платежи</h2><span class="spacer"></span>
      <button class="btn primary" id="add-recurring">＋ Платёж</button></div>
    <div class="grid kpi" style="margin-bottom:12px">
      <div class="card kpi"><div class="label">Оплачено в этом месяце</div><div class="value num">${money(sumAmount(paidThisMonth.map((p) => ({ amount: num(p.amount) }))))}</div>
        ${budgetBar(sumAmount(paidThisMonth.map((p) => ({ amount: num(p.amount) }))), db.settings.budget_bills)}</div>
      <div class="card kpi"><div class="label">Осталось оплатить в этом месяце</div><div class="value num">${money(leftThisMonth.reduce((s, r) => s + num(r.amount), 0))}</div>
        <div class="sub">${leftThisMonth.length} платежей${leftThisMonth.some((r) => daysUntil(r.next_due) < 0) ? ` · <span style="color:var(--danger)">есть просроченные</span>` : ""}</div></div>
      <div class="card kpi wide"><div class="label">Обязательные расходы в месяц</div><div class="value num">${money(Math.round(perMonth))}</div>
        <div class="sub">${active.length} активных платежей</div></div>
    </div>

    <div class="card"><h3>Ближайшие</h3>
      ${due.length ? `<ul class="list due-list">${due.slice(0, 12).map(dueRow).join("")}</ul>` : `<div class="empty">Добавьте коммуналку, интернет, ипотеку, подписки — всё, что платите регулярно.</div>`}
    </div>

    ${groups.size ? `<div class="card"><h3>Все платежи</h3>
      ${[...groups.entries()].map(([cat, list]) => `<div class="cat-title">${esc(cat)}</div><ul class="list">${list.map((r) => `<li>
        <div class="grow"><div class="title">${esc(r.name)}${r.auto ? ' <span class="badge">авто</span>' : ""}</div>
          <div class="muted small">${FREQUENCIES[r.frequency] || ""}${r.payment_method ? " · " + esc(r.payment_method) : ""}${r.end_date ? " · до " + fmtDate(r.end_date) : ""}${r.note ? " · " + esc(r.note) : ""}</div></div>
        ${residentChip(r.payer_id)}<span class="num">${r.variable ? "≈ " : ""}${money(r.amount)}</span>
        <button class="icon-btn" data-edit-recurring="${r.id}" title="Редактировать">✎</button></li>`).join("")}</ul>`).join("")}
      ${finished.length ? `<div class="cat-title">Завершённые и отключённые</div><ul class="list">${finished.map((r) => `<li class="muted">
        <div class="grow">${esc(r.name)}</div><span class="num">${money(r.amount)}</span>
        <button class="icon-btn" data-edit-recurring="${r.id}" title="Редактировать">✎</button></li>`).join("")}</ul>` : ""}
    </div>` : ""}

    <div class="card"><h3>История оплат</h3>
      ${history.length ? `<ul class="list">${history.slice(0, 30).map((p) => `<li>
        <div class="grow"><div class="title">${esc(p.name)}${p.auto ? ' <span class="badge">авто</span>' : ""}</div>
          <div class="muted small">${fmtDate(p.date)}${p.period && p.period !== p.date ? ` · за период ${fmtDate(p.period)}` : ""}${p.payment_method ? " · " + esc(p.payment_method) : ""}${p.note ? " · " + esc(p.note) : ""}</div></div>
        ${residentChip(p.payer_id)}<span class="num">${money(p.amount)}</span>
        <button class="icon-btn" data-edit-payment="${p.id}" title="Изменить">✎</button></li>`).join("")}</ul>`
        : `<div class="empty small">Оплат ещё не было</div>`}
    </div>`;
}

function recurringForm(r = {}) {
  openForm({
    title: r.id ? "Регулярный платёж" : "Новый регулярный платёж",
    fields: [
      { name: "name", label: "Название", value: r.name, required: true, placeholder: "Интернет, Квартплата, Netflix…" },
      { type: "row", fields: [
        { name: "category", label: "Категория", type: "select", value: r.category || db.settings.bill_categories[0], options: db.settings.bill_categories.map((c) => [c, c]) },
        { name: "frequency", label: "Как часто", type: "select", value: r.frequency || "monthly", options: Object.entries(FREQUENCIES) },
      ] },
      { type: "row", fields: [
        { name: "amount", label: `Сумма, ${db.settings.currency}`, type: "number", value: r.amount, required: true },
        { name: "variable", label: "Сумма", type: "select", value: r.variable ? "1" : "", options: [["", "Фиксированная"], ["1", "Меняется (уточню при оплате)"]] },
      ] },
      { type: "row", fields: [
        { name: "start_date", label: "Дата первого платежа", type: "date", value: r.start_date || today(), required: true },
        { name: "end_date", label: "Последний платёж (необяз.)", type: "date", value: r.end_date },
      ] },
      { type: "row", fields: [
        { name: "payer_id", label: "Кто платит", type: "select", value: r.id ? r.payer_id : meId(), options: residentOptions() },
        { name: "payment_method", label: "Способ оплаты", type: "select", value: r.payment_method, options: methodOptions() },
      ] },
      { type: "row", fields: [
        { name: "auto", label: "Отметка оплаты", type: "select", value: r.auto ? "1" : "", options: [["", "Вручную — напоминать"], ["1", "Автоматически (автоплатёж)"]] },
        { name: "active", label: "Статус", type: "select", value: r.active === false ? "0" : "1", options: [["1", "Активен"], ["0", "Отключён"]] },
      ] },
      { name: "note", label: "Заметка", value: r.note, placeholder: "Лицевой счёт, договор…" },
    ],
    onSubmit: (v) => {
      v.auto = v.auto === "1";
      v.variable = v.variable === "1";
      v.active = v.active !== "0";
      return r.id ? mutate("PUT", `recurring/${r.id}`, v) : mutate("POST", "recurring", v, "Платёж добавлен");
    },
    onDelete: r.id ? () => mutate("DELETE", `recurring/${r.id}`, null, "Платёж удалён, история оплат сохранена") : null,
  });
}

function payForm(r) {
  openForm({
    title: `Оплата: ${r.name} за ${fmtDate(r.next_due)}`,
    submitLabel: "Отметить оплату",
    fields: [
      { type: "row", fields: [
        { name: "amount", label: r.variable ? "Сумма по квитанции" : "Сумма", type: "number", value: r.variable ? "" : r.amount, required: true, placeholder: r.variable ? `обычно ≈ ${r.amount}` : "" },
        { name: "date", label: "Дата оплаты", type: "date", value: today(), required: true },
      ] },
      { type: "row", fields: [
        { name: "payer_id", label: "Кто платил", type: "select", value: r.payer_id, options: residentOptions() },
        { name: "payment_method", label: "Способ оплаты", type: "select", value: r.payment_method, options: methodOptions() },
      ] },
      { name: "note", label: "Комментарий", placeholder: "Показания, номер квитанции…" },
    ],
    onSubmit: (v) => mutate("POST", `recurring/${r.id}/pay`, v, "Оплата отмечена"),
  });
}

function paymentForm(p) {
  openForm({
    title: `Оплата: ${p.name}`,
    fields: [
      { type: "row", fields: [
        { name: "amount", label: "Сумма", type: "number", value: p.amount, required: true },
        { name: "date", label: "Дата оплаты", type: "date", value: p.date, required: true },
      ] },
      { type: "row", fields: [
        { name: "payer_id", label: "Кто платил", type: "select", value: p.payer_id, options: residentOptions() },
        { name: "payment_method", label: "Способ оплаты", type: "select", value: p.payment_method, options: methodOptions() },
      ] },
      { name: "note", label: "Комментарий", value: p.note },
    ],
    onSubmit: (v) => mutate("PUT", `payments/${p.id}`, v),
    onDelete: () => mutate("DELETE", `payments/${p.id}`, null, "Оплата удалена — период снова ждёт оплаты"),
  });
}

// Pay / skip buttons work the same on every screen that lists upcoming payments.
function handleDueAction(t) {
  if (t.dataset.pay) payForm(recurringById(t.dataset.pay));
  if (t.dataset.skip) {
    const r = recurringById(t.dataset.skip);
    if (confirm(`Пропустить «${r.name}» за ${fmtDate(r.next_due)}? Следующий срок сдвинется на период вперёд.`)) {
      mutate("POST", `recurring/${r.id}/skip`, {}, "Период пропущен");
    }
  }
}

// Home Assistant ------------------------------------------------------------
function haCard(s) {
  const opt = (name, value, options) => `<select name="${name}">${options.map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? "selected" : ""}>${l}</option>`).join("")}</select>`;
  return `<div class="card" id="ha-card"><h3>Home Assistant</h3>
    <div id="ha-status" class="ha-status muted small">Проверяю подключение…</div>
    <form id="ha-form">
      <div class="fields-2">
        <label class="field"><span>Жители из HA</span>${opt("sync_persons", s.sync_persons !== false ? 1 : 0, [[1, "Добавлять новых автоматически"], [0, "Только по кнопке"]])}</label>
        <label class="field"><span>Сенсоры в HA</span>${opt("sensors_enabled", s.sensors_enabled !== false ? 1 : 0, [[1, "Публиковать"], [0, "Не публиковать"]])}</label>
        <label class="field"><span>Уведомления</span>${opt("notify_enabled", s.notify_enabled !== false ? 1 : 0, [[1, "Включены"], [0, "Выключены"]])}</label>
        <label class="field"><span>Уведомление в интерфейсе HA</span>${opt("notify_persistent", s.notify_persistent !== false ? 1 : 0, [[1, "Да"], [0, "Нет"]])}</label>
        <label class="field"><span>Присылать не раньше, ч</span><input name="notify_hour" type="number" min="0" max="21" step="1" value="${s.notify_hour ?? 9}"></label>
        <label class="field"><span>О платежах за, дней</span><input name="notify_bill_days" value="${esc((s.notify_bill_days || []).join(", "))}" placeholder="3, 0"></label>
        <label class="field"><span>О документах на авто за, дней</span><input name="notify_doc_days" value="${esc((s.notify_doc_days || []).join(", "))}" placeholder="30, 7, 1, 0"></label>
      </div>
      <label class="field"><span>Бюджеты</span>${opt("notify_budget", s.notify_budget !== false ? 1 : 0, [[1, "Предупреждать при 80% и 100%"], [0, "Не предупреждать"]])}</label>
      <div class="row"><button class="btn primary sm">Сохранить</button><button type="button" class="btn sm" id="ha-test">Отправить тест</button></div>
    </form>
    <div class="muted small" style="margin-top:10px">Платёжные напоминания уходят тому, кто платит (сервис указывается в карточке жителя), остальные — получателям ниже. Ночью (с 22:00) уведомления не отправляются.</div>
    <details style="margin-top:10px"><summary class="small">Что будет отправлено и какие сенсоры создаются</summary><div id="ha-preview" class="small"></div></details>
  </div>`;
}

const parseDays = (text) => [...new Set(String(text).split(/[^\d]+/).filter(Boolean).map(Number))].sort((a, b) => b - a);

async function loadHaInfo() {
  const box = $("#ha-status");
  if (!box) return;
  try {
    const [st, pv] = await Promise.all([api("GET", "ha/status"), api("GET", "ha/preview")]);
    ui.haServices = st.notify_services || [];
    const dl = $("#dl-notify");
    if (dl) dl.innerHTML = ui.haServices.map((x) => `<option value="${esc(x)}">`).join("");
    const modes = { supervisor: "через Supervisor", token: "по токену (HA_URL)", none: "" };
    box.innerHTML = st.mode === "none"
      ? `<span class="doc soon">Не подключено</span> Приложение запущено вне Home Assistant — сенсоры и уведомления заработают после установки аддона.`
      : st.connected
        ? `<span class="doc ok">Подключено</span> ${modes[st.mode]}${st.last_push ? ` · сенсоры обновлены ${st.last_push.slice(11, 16)}` : ""} · отправлено уведомлений: ${st.sent}`
        : `<span class="doc expired">Ошибка</span> ${esc(st.last_error || "нет связи с HA")}`;
    if (st.last_error && st.connected) box.innerHTML += `<div style="color:var(--danger)">${esc(st.last_error)}</div>`;
    $("#ha-preview").innerHTML = `
      <div style="margin:8px 0 4px"><b>Ожидают отправки (${pv.pending.length})</b>${pv.in_window ? "" : " · сейчас тихие часы"}</div>
      ${pv.pending.length ? `<ul class="list">${pv.pending.map((n) => `<li><div class="grow"><div>${esc(n.title)}</div><div class="muted">${esc(n.message)}</div></div>
        <span class="muted">${n.targets.length ? n.targets.map(esc).join(", ") : "нет получателей"}</span></li>`).join("")}</ul>` : '<div class="muted">Ничего — все напоминания уже отправлены или пока не нужны.</div>'}
      <div style="margin:12px 0 4px"><b>Сенсоры</b></div>
      <ul class="list">${Object.entries(pv.sensors).map(([id, x]) => `<li><div class="grow"><code>${id}</code><div class="muted">${esc(x.attributes.friendly_name)}</div></div>
        <span class="num">${esc(x.state)} ${esc(x.attributes.unit_of_measurement || "")}</span></li>`).join("")}</ul>
      <button type="button" class="btn sm ghost" id="ha-reset" style="margin-top:8px">Отправить актуальные напоминания заново</button>`;
    $("#ha-reset").onclick = () => mutate("POST", "ha/reset", {}, "Напоминания будут отправлены повторно").then(loadHaInfo);
  } catch (e) {
    box.textContent = "Не удалось получить статус: " + e.message;
  }
}

function bindHaCard() {
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
    }, "Настройки Home Assistant сохранены");
  };
  $("#ha-test").onclick = async () => {
    try {
      const r = await api("POST", "ha/test", {});
      toast("Отправлено: " + r.services.join(", "));
    } catch (e) {
      toast(e.message, true);
    }
  };
  loadHaInfo();
}

// Stats ---------------------------------------------------------------------
const PERIODS = [["month", "Месяц"], ["3m", "3 месяца"], ["year", "Год"], ["all", "Всё время"]];

function stats() {
  const p = ui.statsPeriod;
  const payer = ui.statsPayer;
  const all = expenses().filter((e) => !payer || e.payer_id === payer);
  const ex = all.filter((e) => inPeriod(e.date, p));
  const byKind = (kind) => ex.filter((e) => e.kind === kind);
  const home = byKind("home");
  const groc = byKind("groceries");
  const car = byKind("car");
  const trips = db.trips.filter((t) => inPeriod(t.date, p) && (!payer || t.payer_id === payer));
  const grocTotal = sumAmount(groc);
  const months = Math.max(1, new Set(groc.map((e) => monthKey(e.date))).size);

  const productFreq = new Map();
  for (const t of trips) for (const i of t.items) productFreq.set(i.name, (productFreq.get(i.name) || 0) + 1);
  const topProducts = [...productFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const skipped = trips.reduce((s, t) => s + (t.skipped || 0), 0);
  const boughtCount = trips.reduce((s, t) => s + t.items.length, 0);

  const payerLabel = (id, c) => {
    const r = resident(id);
    return r ? `<span class="dot" style="background:${r.color}"></span>${esc(r.name)}` : `<span class="dot" style="background:${c}"></span><span class="muted">не указано</span>`;
  };
  const payerColor = (id) => resident(id)?.color || "#9e9e9e";
  const kindLabel = (k) => `<span class="dot" style="background:${KINDS[k].color}"></span>${KINDS[k].label}`;
  const carsById = Object.fromEntries(db.cars.map((c) => [c.id, c]));

  return `
    <div class="row"><h2>Статистика трат</h2><span class="spacer"></span>
      <select id="payer-filter" style="width:auto"><option value="">Все жители</option>
        ${db.residents.map((r) => `<option value="${r.id}" ${r.id === payer ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select>
      <div class="seg" id="period">${PERIODS.map(([k, l]) => `<button data-p="${k}" class="${k === p ? "active" : ""}">${l}</button>`).join("")}</div></div>

    <div class="grid kpi">
      <div class="card kpi"><div class="label">Всего потрачено</div><div class="value num">${money(sumAmount(ex))}</div><div class="sub">${ex.length} операций</div></div>
      <div class="card kpi"><div class="label">Обустройство</div><div class="value num">${money(sumAmount(home))}</div><div class="sub">${home.length} покупок</div></div>
      <div class="card kpi"><div class="label">Продукты</div><div class="value num">${money(grocTotal)}</div>
        <div class="sub">${trips.length} походов · средний чек ${money(trips.length ? Math.round(grocTotal / trips.length) : 0)}</div></div>
      <div class="card kpi"><div class="label">Авто</div><div class="value num">${money(sumAmount(car))}</div><div class="sub">${car.length} расходов</div></div>
      <div class="card kpi"><div class="label">Регулярные платежи</div><div class="value num">${money(sumAmount(byKind("bills")))}</div><div class="sub">${byKind("bills").length} оплат</div></div>
    </div>

    <div class="card" style="margin-top:12px"><h3>По месяцам</h3>${monthlyColumns(all, 12)}</div>

    <div class="card" style="margin-top:12px">
      <div class="row"><h3>Кто сколько тратит по месяцам</h3><span class="spacer"></span><span class="muted small">последние ${p === "year" || p === "all" ? 12 : 6} мес.</span></div>
      ${residentMonthMatrix(all, p === "year" || p === "all" ? 12 : 6)}
    </div>

    <div class="card" style="margin-top:12px">
      <h3>Кто на что тратит <span class="muted small">· ${PERIODS.find(([k]) => k === p)[1].toLowerCase()}</span></h3>
      ${residentCategories(ex)}
    </div>

    <div class="grid two" style="margin-top:12px">
      <div class="card"><h3>По разделам</h3>${barsHtml(sumBy(ex, (e) => e.kind), (k) => KINDS[k].color, kindLabel)}</div>
      <div class="card"><h3>По категориям</h3>${barsHtml(sumBy(ex, (e) => e.category).slice(0, 12))}</div>
      <div class="card"><h3>Кто платит</h3>${barsHtml(sumBy(ex, (e) => e.payer_id), payerColor, payerLabel)}</div>
      <div class="card"><h3>Способы оплаты</h3>${barsHtml(sumBy(ex, (e) => e.method || "не указан"))}</div>
      <div class="card"><h3>Обустройство по комнатам</h3>${barsHtml(sumBy(home, (e) => e.category))}</div>
      <div class="card"><h3>Продукты по магазинам</h3>${barsHtml(sumBy(groc, (e) => e.store))}</div>
      <div class="card"><h3>Авто по категориям</h3>${barsHtml(sumBy(car, (e) => e.category))}</div>
      <div class="card"><h3>Авто по машинам</h3>${barsHtml(sumBy(car, (e) => carName(carsById[e.car_id])))}</div>
      <div class="card"><h3>Платежи по категориям</h3>${barsHtml(sumBy(byKind("bills"), (e) => e.category))}</div>
      <div class="card"><h3>Платежи: на что уходит больше всего</h3>${barsHtml(sumBy(byKind("bills"), (e) => e.title).slice(0, 10))}</div>
      <div class="card"><h3>Чаще всего покупаем</h3>
        ${topProducts.length ? `<ul class="list">${topProducts.map(([n, c]) => `<li><div class="grow">${esc(n)}</div><span class="muted small">${c} раз</span></li>`).join("")}</ul>` : '<div class="empty small">Нет данных</div>'}
        ${boughtCount + skipped ? `<div class="muted small" style="margin-top:8px">Куплено по списку: ${Math.round((boughtCount / (boughtCount + skipped)) * 100)}% позиций · в среднем ${money(Math.round(grocTotal / months))} в месяц</div>` : ""}
      </div>
    </div>`;
}

// Rows: residents, columns: months. Cell tooltip shows the split by section.
function residentMonthMatrix(list, n) {
  const keys = lastMonths(n);
  const rows = [...db.residents.map((r) => r.id), ""].filter((id) => list.some((e) => (e.payer_id || "") === id && keys.includes(monthKey(e.date))));
  if (!rows.length) return `<div class="empty small">Нет данных</div>`;
  const cell = (id, k) => list.filter((e) => (e.payer_id || "") === id && monthKey(e.date) === k);
  const max = Math.max(...rows.flatMap((id) => keys.map((k) => sumAmount(cell(id, k))))) || 1;
  const name = (id) => (id ? residentChip(id) : `<span class="muted">не указано</span>`);
  const colTotal = (k) => sumAmount(list.filter((e) => monthKey(e.date) === k));
  return `<div class="scroll-x"><table class="matrix">
    <thead><tr><th>Житель</th>${keys.map((k) => `<th title="${k}">${MONTHS[+k.slice(5) - 1]}</th>`).join("")}<th>Итого</th><th>В среднем</th></tr></thead>
    <tbody>${rows.map((id) => {
      const color = resident(id)?.color || "#9e9e9e";
      const rowTotal = sumAmount(list.filter((e) => (e.payer_id || "") === id && keys.includes(monthKey(e.date))));
      return `<tr><td>${name(id)}</td>${keys.map((k) => {
        const items = cell(id, k);
        const v = sumAmount(items);
        const tip = Object.keys(KINDS).map((kind) => [kind, sumAmount(items.filter((e) => e.kind === kind))]).filter(([, s]) => s)
          .map(([kind, s]) => `${KINDS[kind].label}: ${money(s)}`).join("\n");
        return `<td class="num heat" title="${esc(tip)}">${v ? shortMoney(v) : '<span class="muted">—</span>'}
          ${v ? `<span class="cell-bar" style="width:${(v / max) * 100}%;background:${color}"></span>` : ""}</td>`;
      }).join("")}<td class="num"><b>${money(rowTotal)}</b></td><td class="num muted">${money(Math.round(rowTotal / n))}</td></tr>`;
    }).join("")}
    <tr class="total"><td>Всего</td>${keys.map((k) => `<td class="num">${colTotal(k) ? shortMoney(colTotal(k)) : "—"}</td>`).join("")}
      <td class="num">${money(sumAmount(list.filter((e) => keys.includes(monthKey(e.date)))))}</td><td></td></tr>
    </tbody></table></div>`;
}

// For each resident: split by section (bar) + top detailed categories.
function residentCategories(list) {
  const ids = [...db.residents.map((r) => r.id), ""].filter((id) => list.some((e) => (e.payer_id || "") === id));
  if (!ids.length) return `<div class="empty small">Нет данных</div>`;
  return `<div class="resident-cats">${ids.map((id) => {
    const mine = list.filter((e) => (e.payer_id || "") === id);
    const total = sumAmount(mine);
    const kinds = Object.keys(KINDS).map((k) => [k, sumAmount(mine.filter((e) => e.kind === k))]).filter(([, v]) => v);
    const cats = sumBy(mine, (e) => e.category).slice(0, 6);
    return `<div>
      <div class="row">${id ? residentChip(id) : '<span class="muted">не указано</span>'}<span class="spacer"></span><b class="num">${money(total)}</b></div>
      <div class="stackbar">${kinds.map(([k, v]) => `<div title="${KINDS[k].label}: ${money(v)}" style="width:${(v / total) * 100}%;background:${KINDS[k].color}"></div>`).join("")}</div>
      <div class="row small muted">${kinds.map(([k, v]) => `<span><span class="dot" style="background:${KINDS[k].color}"></span> ${KINDS[k].label} ${money(v)}</span>`).join(" ")}</div>
      <div class="row small" style="margin-top:4px">${cats.map(([c, v]) => `<span class="chip">${esc(c)} · <span class="num">${money(v)}</span></span>`).join("")}</div>
    </div>`;
  }).join("")}</div>`;
}

// Settings / residents ------------------------------------------------------
function settings() {
  const s = db.settings;
  const tagEditor = (key, title, hint = "", listId = "") => `<div class="card"><h3>${title}</h3>
    ${hint ? `<div class="muted small" style="margin:-4px 0 10px">${hint}</div>` : ""}
    <div class="tag-edit">${s[key].length ? s[key].map((t, i) => `<span class="chip"><span class="tag-name" data-rename-tag="${key}" data-i="${i}" title="Нажмите, чтобы переименовать">${esc(t)}</span><button data-del-tag="${key}" data-i="${i}" title="Удалить">✕</button></span>`).join("")
      : '<span class="muted small">Пусто</span>'}</div>
    <form class="row" data-add-tag="${key}" style="margin-top:10px"><input name="v" placeholder="Добавить…" style="flex:1" required ${listId ? `list="${listId}"` : ""}>${listId ? `<datalist id="${listId}">${ui.haServices.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>` : ""}<button class="btn sm">Добавить</button></form></div>`;

  return `
    <div class="row"><h2>Жители дома</h2><span class="spacer"></span>
      <button class="btn" id="ha-import" title="Добавить людей из Home Assistant (Настройки → Люди)">Импорт из Home Assistant</button>
      <button class="btn primary" id="add-resident">＋ Добавить жителя</button></div>
    <div class="card">
      ${db.residents.length ? `<ul class="list">${db.residents.map((r) => {
          const spent = expenses().filter((e) => e.payer_id === r.id).reduce((s, e) => s + e.amount, 0);
          return `<li class="resident">${avatar(r)}
            <div class="grow"><div>${esc(r.name)}${r.ha_person ? ' <span class="badge" title="' + esc(r.ha_person) + '">HA</span>' : ""}${r.id === meId() ? ' <span class="badge">это вы</span>' : ""}</div>
              <div class="muted small">${[r.role, r.notify_service && "уведомления: " + r.notify_service].filter(Boolean).map(esc).join(" · ")}</div></div>
            <span class="muted small num">оплачено ${money(spent)}</span>
            <button class="icon-btn" data-edit-resident="${r.id}">✎</button></li>`;
        }).join("")}</ul>` : `<div class="empty">Добавьте всех, кто живёт в доме и участвует в расходах.</div>`}
    </div>

    <h2 style="margin-top:24px">Настройки</h2>
    <div class="grid two settings-grid">
      <div class="card"><h3>Бюджет на месяц</h3>
        <form id="budget-form">
          <div class="fields-2">
            <label class="field"><span>Продукты, ${esc(s.currency)}</span><input name="budget_groceries" type="number" min="0" step="any" value="${s.budget_groceries || ""}"></label>
            <label class="field"><span>Обустройство, ${esc(s.currency)}</span><input name="budget_home" type="number" min="0" step="any" value="${s.budget_home || ""}"></label>
            <label class="field"><span>Авто, ${esc(s.currency)}</span><input name="budget_car" type="number" min="0" step="any" value="${s.budget_car || ""}"></label>
            <label class="field"><span>Регулярные платежи, ${esc(s.currency)}</span><input name="budget_bills" type="number" min="0" step="any" value="${s.budget_bills || ""}"></label>
          </div>
          <button class="btn primary sm">Сохранить</button>
        </form></div>
      ${currencyCard(s)}
      ${tagEditor("payment_methods", "Способы оплаты")}
      ${tagEditor("rooms", "Комнаты и зоны")}
      ${tagEditor("grocery_categories", "Категории продуктов")}
      ${tagEditor("stores", "Магазины", "Новые магазины из чеков добавляются сюда автоматически.")}
      ${tagEditor("favorite_products", "Избранные продукты", "Всегда первыми в подсказках «Часто покупаете».")}
      ${tagEditor("hidden_products", "Скрытые из подсказок", "Эти продукты не будут предлагаться, даже если их часто покупают.")}
      ${tagEditor("car_categories", "Категории расходов на авто")}
      ${tagEditor("bill_categories", "Категории регулярных платежей")}
      ${haCard(s)}
      ${tagEditor("notify_services", "Получатели уведомлений", "Сервисы notify из Home Assistant, например notify.mobile_app_pixel_8. Сюда уходят напоминания о документах и бюджете, а платёжные — если у плательщика не указан свой сервис.", "dl-notify")}
      <div class="card"><h3>Данные</h3>
        <div class="muted small" style="margin-bottom:10px">Резервная копия всех данных в JSON.</div>
        <div class="row"><a class="btn sm" href="api/export" download="homeledger.json">Экспорт</a>
        <label class="btn sm">Импорт<input type="file" id="import-file" accept=".json" hidden></label></div></div>
    </div>`;
}

function currencyCard(s) {
  const known = CURRENCIES.find(([code]) => code === s.currency_code);
  const code = known ? s.currency_code : "OTHER";
  return `<div class="card"><h3>Валюта</h3>
    <form id="currency-form">
      <label class="field"><span>Валюта</span><select name="currency_code">
        ${CURRENCIES.map(([c, sym, name]) => `<option value="${c}" ${c === code ? "selected" : ""}>${esc(sym)} — ${esc(name)} (${c})</option>`).join("")}
        <option value="OTHER" ${code === "OTHER" ? "selected" : ""}>Другая…</option></select></label>
      <label class="field" id="custom-currency" ${code === "OTHER" ? "" : "hidden"}><span>Знак валюты</span>
        <input name="custom" value="${esc(code === "OTHER" ? s.currency : "")}" maxlength="6" placeholder="например, руб." style="max-width:160px"></label>
      <div class="fields-2">
        <label class="field"><span>Положение знака</span><select name="currency_position">
          <option value="after" ${s.currency_position !== "before" ? "selected" : ""}>После суммы: 1 000 ₽</option>
          <option value="before" ${s.currency_position === "before" ? "selected" : ""}>Перед суммой: $1 000</option></select></label>
        <label class="field"><span>Дробная часть</span><select name="currency_decimals">
          <option value="1" ${s.currency_decimals !== false ? "selected" : ""}>Показывать копейки</option>
          <option value="0" ${s.currency_decimals === false ? "selected" : ""}>Округлять до целых</option></select></label>
      </div>
      <div class="row"><button class="btn primary sm">Сохранить</button><span class="muted small">Пример: <b id="currency-preview" class="num"></b></span></div>
      <div class="muted small" style="margin-top:8px">Меняется только отображение — суммы не пересчитываются по курсу.</div>
    </form></div>`;
}

function readCurrencyForm(form) {
  const v = Object.fromEntries(new FormData(form).entries());
  const known = CURRENCIES.find(([c]) => c === v.currency_code);
  return {
    currency_code: v.currency_code,
    currency: known ? known[1] : (v.custom || "").trim() || "¤",
    currency_position: v.currency_position,
    currency_decimals: v.currency_decimals === "1",
  };
}

function residentForm(r = {}) {
  openForm({
    title: r.id ? "Житель" : "Новый житель",
    fields: [
      { name: "name", label: "Имя", value: r.name, required: true },
      { name: "role", label: "Кто это (необязательно)", value: r.role, placeholder: "Мама, папа, сын…" },
      { name: "notify_service", label: "Уведомления в Home Assistant", value: r.notify_service, placeholder: "notify.mobile_app_…", datalist: ui.haServices },
      { name: "color", label: "Цвет", type: "color", value: r.color || COLORS[db.residents.length % COLORS.length] },
    ],
    note: r.ha_person ? `Связан с ${r.ha_person} в Home Assistant — аватар и пользователь берутся оттуда.` : "",
    onSubmit: (v) => (r.id ? mutate("PUT", `residents/${r.id}`, v) : mutate("POST", "residents", v, "Житель добавлен")),
    onDelete: r.id ? () => mutate("DELETE", `residents/${r.id}`) : null,
  });
}

// --- event binding per view --------------------------------------------------
const bind = {
  overview() {
    document.querySelectorAll("[data-goto]").forEach((b) => (b.onclick = () => $(`#tabs [data-view="${b.dataset.goto}"]`).click()));
    $("#view").onclick = (e) => {
      const t = e.target.closest("[data-pay],[data-skip]");
      if (t) handleDueAction(t);
    };
  },

  bills() {
    $("#add-recurring").onclick = () => recurringForm();
    $("#view").onclick = (e) => {
      const t = e.target.closest("[data-pay],[data-skip],[data-edit-recurring],[data-edit-payment]");
      if (!t) return;
      handleDueAction(t);
      if (t.dataset.editRecurring) recurringForm(recurringById(t.dataset.editRecurring));
      if (t.dataset.editPayment) paymentForm(db.payments.find((p) => p.id === t.dataset.editPayment));
    };
  },

  plans() {
    $("#add-plan").onclick = () => planForm();
    $("#f-room").onchange = (e) => { ui.planFilter.room = e.target.value; render(); };
    $("#f-status").onchange = (e) => { ui.planFilter.status = e.target.value; render(); };
    $("#view").onclick = (e) => {
      const t = e.target.closest("[data-edit-plan],[data-add-item],[data-edit-item]");
      if (!t) return;
      if (t.dataset.editPlan) planForm(db.plans.find((p) => p.id === t.dataset.editPlan));
      if (t.dataset.addItem) itemForm(t.dataset.addItem);
      if (t.dataset.editItem) { const i = db.plan_items.find((x) => x.id === t.dataset.editItem); itemForm(i.plan_id, i); }
    };
    $("#view").onchange = (e) => {
      const id = e.target.dataset.toggleItem;
      if (!id) return;
      const bought = e.target.checked;
      mutate("PUT", `plan_items/${id}`, { status: bought ? "bought" : "planned", bought_at: bought ? today() : "" }, bought ? "Отмечено как куплено" : null);
    };
  },

  groceries() {
    $("#view").onchange = null;
    if (ui.shopping) return bindShopping();
    $("#start-shop").onclick = () => { ui.shopping = { checked: [] }; saveShopping(); render(); };
    $("#add-grocery").onsubmit = async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.target).entries());
      v.name = v.name.trim();
      // Remember the category the product had last time.
      const prev = db.trips.flatMap((t) => t.items).reverse().find((i) => i.name.toLowerCase() === v.name.toLowerCase());
      if (!v.category) v.category = prev?.category || "Другое";
      await mutate("POST", "groceries", { ...v, added_by: meId() });
      $("#add-grocery input[name=name]")?.focus();
    };
    $("#view").onclick = (e) => {
      const t = e.target.closest("[data-sug],[data-hide-sug],[data-goto],[data-del-grocery],[data-edit-grocery],[data-edit-trip]");
      if (!t) return;
      if (t.dataset.sug) mutate("POST", "groceries", { name: t.dataset.sug, category: t.dataset.cat || "Другое" });
      if (t.dataset.goto) $(`#tabs [data-view="${t.dataset.goto}"]`).click();
      if (t.dataset.hideSug) {
        const name = t.dataset.hideSug;
        const s = db.settings;
        mutate("PUT", "settings", t.dataset.fav
          ? { favorite_products: s.favorite_products.filter((n) => n !== name) }
          : { hidden_products: [...s.hidden_products, name] }, `«${name}» больше не предлагается`);
      }
      if (t.dataset.delGrocery) mutate("DELETE", `groceries/${t.dataset.delGrocery}`);
      if (t.dataset.editTrip) tripForm(db.trips.find((x) => x.id === t.dataset.editTrip));
      if (t.dataset.editGrocery) {
        const g = db.groceries.find((x) => x.id === t.dataset.editGrocery);
        openForm({
          title: "Продукт",
          fields: [
            { name: "name", label: "Название", value: g.name, required: true },
            { type: "row", fields: [
              { name: "qty", label: "Количество", value: g.qty },
              { name: "category", label: "Категория", type: "select", value: g.category, options: groceryCategories().map((c) => [c, c]) },
            ] },
            { name: "added_by", label: "Кто добавил", type: "select", value: g.added_by, options: residentOptions() },
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
      const t = e.target.closest("[data-edit-car],[data-add-cexp],[data-edit-cexp],[data-expand-car]");
      if (!t) return;
      if (t.dataset.editCar) carForm(db.cars.find((c) => c.id === t.dataset.editCar));
      if (t.dataset.addCexp) carExpenseForm({ car_id: t.dataset.addCexp });
      if (t.dataset.editCexp) carExpenseForm(db.car_expenses.find((x) => x.id === t.dataset.editCexp));
      if (t.dataset.expandCar) {
        const s = ui.carsExpanded;
        s.has(t.dataset.expandCar) ? s.delete(t.dataset.expandCar) : s.add(t.dataset.expandCar);
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
        toast(r.total ? `Людей в HA: ${r.total} · добавлено ${r.added}, связано ${r.linked}` : "В Home Assistant не найдено ни одного человека (Настройки → Люди)");
      } catch { /* toast shown */ }
    };
    bindHaCard();
    $("#view").onclick = (e) => {
      const t = e.target.closest("[data-edit-resident],[data-del-tag],[data-rename-tag]");
      if (!t) return;
      if (t.dataset.editResident) residentForm(resident(t.dataset.editResident));
      if (t.dataset.renameTag) {
        const key = t.dataset.renameTag;
        const old = db.settings[key][+t.dataset.i];
        const name = prompt("Новое название (старые записи тоже обновятся):", old)?.trim();
        if (name && name !== old) {
          mutate("POST", "settings/rename", { key, old, new: name }).then((r) => toast(r.records ? `Переименовано, обновлено записей: ${r.records}` : "Переименовано"));
        }
      }
      if (t.dataset.delTag) {
        const list = [...db.settings[t.dataset.delTag]];
        list.splice(+t.dataset.i, 1);
        mutate("PUT", "settings", { [t.dataset.delTag]: list });
      }
    };
    document.querySelectorAll("[data-add-tag]").forEach((f) => (f.onsubmit = (e) => {
      e.preventDefault();
      const key = f.dataset.addTag;
      const v = f.v.value.trim();
      if (v && !db.settings[key].includes(v)) mutate("PUT", "settings", { [key]: [...db.settings[key], v] });
    }));
    const cf = $("#currency-form");
    const preview = () => ($("#currency-preview").textContent = money(12345.5, readCurrencyForm(cf)));
    cf.currency_code.onchange = () => {
      const known = CURRENCIES.find(([c]) => c === cf.currency_code.value);
      $("#custom-currency").hidden = !!known;
      if (known) cf.currency_position.value = known[3] ? "before" : "after";
      preview();
    };
    cf.oninput = preview;
    cf.onsubmit = (e) => {
      e.preventDefault();
      mutate("PUT", "settings", readCurrencyForm(cf), "Валюта сохранена");
    };
    preview();
    $("#budget-form").onsubmit = (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.target).entries());
      mutate("PUT", "settings", { budget_groceries: num(v.budget_groceries), budget_home: num(v.budget_home), budget_car: num(v.budget_car), budget_bills: num(v.budget_bills) }, "Сохранено");
    };
    $("#import-file").onchange = async (e) => {
      const file = e.target.files[0];
      if (!file || !confirm("Импорт заменит текущие данные. Продолжить?")) return;
      try { await mutate("POST", "import", JSON.parse(await file.text()), "Данные импортированы"); }
      catch { toast("Не удалось прочитать файл", true); }
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
  $("#cancel-shop").onclick = () => {
    if (ui.shopping.checked.length && !confirm("Отметки будут сброшены. Выйти?")) return;
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
        left ? `Чек сохранён. ${left} прод. осталось в списке` : "Чек сохранён. Всё куплено!");
      saveShopping();
    } catch {
      ui.shopping = shopping;
      render();
    }
  };
}

// --- start -------------------------------------------------------------------
api("GET", "me").then((m) => (ui.me = m)).catch(() => {}).finally(() => reload().catch((e) => {
  $("#view").innerHTML = `<div class="card empty">Не удалось загрузить данные: ${esc(e.message)}</div>`;
}));
