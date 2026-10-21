"""Home Assistant integration: sensors + notifications.

Inside the add-on the Supervisor provides SUPERVISOR_TOKEN and proxies the Core API at
http://supervisor/core/api. For local development set HA_URL and HA_TOKEN (a long-lived token).
"""

import json
import os
import threading
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta

import logic

TICK_SECONDS = 300
QUIET_FROM_HOUR = 22  # no notifications from this hour until settings.notify_hour

status = {"mode": "none", "connected": False, "last_push": None, "last_error": None, "sent": 0}
_wake = threading.Event()


class Client:
    def __init__(self):
        if os.environ.get("SUPERVISOR_TOKEN"):
            self.base, self.token, self.mode = "http://supervisor/core/api", os.environ["SUPERVISOR_TOKEN"], "supervisor"
        elif os.environ.get("HA_URL") and os.environ.get("HA_TOKEN"):
            self.base, self.token, self.mode = os.environ["HA_URL"].rstrip("/") + "/api", os.environ["HA_TOKEN"], "token"
        else:
            self.base = self.token = None
            self.mode = "none"

    @property
    def available(self):
        return self.base is not None

    def call(self, method, path, payload=None):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                body = resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"HA {e.code}: {e.read().decode('utf-8', 'replace')[:200]}") from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"HA недоступен: {e.reason}") from e
        return json.loads(body) if body else None

    def notify(self, service, title, message, tag=None):
        if service == "persistent_notification":
            return self.call("POST", "/services/persistent_notification/create",
                             {"title": title, "message": message, "notification_id": tag or f"home_budget_{int(time.time())}"})
        name = service.split(".", 1)[1] if service.startswith("notify.") else service
        payload = {"title": title, "message": message}
        if tag:
            payload["data"] = {"tag": tag}  # replaces the previous push with the same tag on mobile
        return self.call("POST", f"/services/notify/{name}", payload)

    def get_bytes(self, path):
        """Fetch a file served from the HA root (e.g. /api/image/serve/... avatars)."""
        root = self.base[: -len("/api")]
        req = urllib.request.Request(root + path, headers={"Authorization": f"Bearer {self.token}"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.read(), resp.headers.get("Content-Type", "image/jpeg")

    def notify_services(self):
        services = self.call("GET", "/services") or []
        return sorted(f"notify.{name}" for d in services if d.get("domain") == "notify" for name in d.get("services", {}))


client = Client()
status["mode"] = client.mode


# --- sensors ------------------------------------------------------------------
def sensors(db, today=None):
    today = today or date.today()
    s = db["settings"]
    unit = s.get("currency_code") or "RUB"
    summary = logic.month_summary(db, today.isoformat()[:7])
    budgets = logic.budgets(db)
    money_attrs = {"unit_of_measurement": unit, "device_class": "monetary", "state_class": "total"}
    out = {
        "sensor.home_budget_month_total": (summary["total"], {
            **money_attrs, "friendly_name": "Траты за месяц", "icon": "mdi:cash-multiple",
            **{logic.KIND_LABELS[k]: v for k, v in summary["by_kind"].items()}, "по жителям": summary["by_payer"]}),
    }
    icons = {"home": "mdi:sofa", "groceries": "mdi:cart", "car": "mdi:car", "bills": "mdi:receipt-text"}
    for kind, label in logic.KIND_LABELS.items():
        spent, budget = summary["by_kind"][kind], budgets[kind]
        out[f"sensor.home_budget_{kind}_month"] = (spent, {
            **money_attrs, "friendly_name": f"{label} за месяц", "icon": icons[kind],
            "budget": budget or None, "remaining": round(budget - spent, 2) if budget else None,
            "percent": round(spent / budget * 100) if budget else None})

    out["sensor.home_budget_shopping_list"] = (len(db["groceries"]), {
        "friendly_name": "Список продуктов", "icon": "mdi:format-list-checks", "unit_of_measurement": "шт.",
        "items": [g["name"] + (f" ({g['qty']})" if g.get("qty") else "") for g in db["groceries"]]})

    names = {r["id"]: r["name"] for r in db["residents"]}
    due = []
    for rec in db["recurring"]:
        d = logic.next_due(rec)
        if d and (d - today).days <= 7:
            due.append({"name": rec.get("name"), "due": d.isoformat(), "days": (d - today).days,
                        "amount": logic.num(rec.get("amount")), "payer": names.get(rec.get("payer_id")), "auto": bool(rec.get("auto"))})
    due.sort(key=lambda x: x["due"])
    out["sensor.home_budget_bills_due"] = (len(due), {
        "friendly_name": "Платежи на неделе", "icon": "mdi:calendar-clock", "unit_of_measurement": "шт.",
        "overdue": sum(1 for x in due if x["days"] < 0), "total": round(sum(x["amount"] for x in due), 2),
        "next": due[0]["due"] if due else None, "payments": due})

    docs = [d for d in logic.car_docs(db, today) if d["days"] <= 30]
    out["sensor.home_budget_car_documents"] = (len(docs), {
        "friendly_name": "Документы на авто (≤30 дн.)", "icon": "mdi:card-account-details-outline", "unit_of_measurement": "шт.",
        "expired": sum(1 for d in docs if d["days"] < 0),
        "documents": [{"car": logic.car_title(d["car"]), "document": d["label"], "until": d["date"].isoformat(), "days": d["days"]} for d in docs]})

    planned = sum(logic.num(i.get("price")) * (logic.num(i.get("qty")) or 1) for i in db["plan_items"] if i.get("status") != "bought")
    out["sensor.home_budget_home_planned"] = (round(planned, 2), {
        **money_attrs, "state_class": None, "friendly_name": "Запланировано для дома", "icon": "mdi:home-edit"})
    return out


def push_sensors(db):
    for entity, (state, attrs) in sensors(db).items():
        client.call("POST", f"/states/{entity}", {"state": state, "attributes": {k: v for k, v in attrs.items() if v is not None}})


# --- people ---------------------------------------------------------------------
PERSON_COLORS = ["#03a9f4", "#e91e63", "#4caf50", "#ff9800", "#9c27b0", "#00bcd4", "#795548", "#607d8b"]


def fetch_persons():
    """HA person entities, with a guessed notify service from their mobile app device trackers."""
    states = client.call("GET", "/states") or []
    try:
        services = set(client.notify_services())
    except RuntimeError:
        services = set()
    persons = []
    for st in states:
        if not st.get("entity_id", "").startswith("person."):
            continue
        attrs = st.get("attributes", {})
        notify = next((f"notify.mobile_app_{t.split('.', 1)[1]}" for t in attrs.get("device_trackers") or []
                       if f"notify.mobile_app_{t.split('.', 1)[1]}" in services), None)
        persons.append({
            "entity_id": st["entity_id"],
            "name": attrs.get("friendly_name") or st["entity_id"].split(".", 1)[1].title(),
            "user_id": attrs.get("user_id"),
            "picture": attrs.get("entity_picture"),
            "notify_service": notify,
        })
    return persons


def apply_persons(db, persons):
    """Link residents to HA persons (by entity, then by name) and add the missing ones."""
    added = linked = 0
    for p in persons:
        r = next((r for r in db["residents"] if r.get("ha_person") == p["entity_id"]), None)
        if r is None:
            r = next((r for r in db["residents"] if not r.get("ha_person")
                      and r.get("name", "").strip().lower() == p["name"].strip().lower()), None)
            if r is not None:
                linked += 1
        if r is None:
            r = {"id": logic.new_id(), "name": p["name"], "role": "",
                 "color": PERSON_COLORS[len(db["residents"]) % len(PERSON_COLORS)],
                 "created_at": datetime.now().isoformat(timespec="seconds")}
            db["residents"].append(r)
            added += 1
        r["ha_person"] = p["entity_id"]
        r["ha_user_id"] = p["user_id"]
        r["picture"] = p["picture"]
        if p["notify_service"] and not r.get("notify_service"):
            r["notify_service"] = p["notify_service"]
    return {"added": added, "linked": linked, "total": len(persons)}


def resident_for_user(db, user_id, display_name=None):
    if user_id:
        r = next((r for r in db["residents"] if r.get("ha_user_id") == user_id), None)
        if r:
            return r
    if display_name:
        return next((r for r in db["residents"] if r.get("name", "").strip().lower() == display_name.strip().lower()), None)
    return None


# --- notifications --------------------------------------------------------------
def _bucket(days, thresholds):
    """The tightest reminder threshold the date has already crossed (so each one fires once)."""
    if days < 0:
        return "overdue"
    passed = [t for t in thresholds if t >= days]
    return min(passed) if passed else None


def _when(db, d, days):
    if days < 0:
        return f"просрочено на {-days} дн. ({d.day} {MONTHS[d.month - 1]})"
    if days == 0:
        return "сегодня"
    if days == 1:
        return "завтра"
    return f"через {days} дн. ({d.day} {MONTHS[d.month - 1]})"


MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]


def _ints(value, default):
    try:
        return sorted({int(x) for x in value}, reverse=True)
    except (TypeError, ValueError):
        return default


def collect(db, today=None):
    """Notifications that should go out now and haven't been sent yet."""
    today = today or date.today()
    s = db["settings"]
    log = db.get("notify_log", {})
    names = {r["id"]: r["name"] for r in db["residents"]}
    out = []

    for rec in db["recurring"]:
        d = logic.next_due(rec)
        if not d or rec.get("auto"):
            continue
        days = (d - today).days
        b = _bucket(days, _ints(s.get("notify_bill_days"), [3, 0]))
        if b is None:
            continue
        payer = names.get(rec.get("payer_id"))
        out.append({
            "key": f"bill:{rec['id']}:{d.isoformat()}:{b}",
            "title": ("⚠️ Просрочен платёж: " if days < 0 else "💳 Платёж: ") + rec.get("name", ""),
            "message": f"{logic.money(db, logic.num(rec.get('amount')))} — {_when(db, d, days)}" + (f". Платит: {payer}" if payer else ""),
            "resident_id": rec.get("payer_id"),
        })

    for doc in logic.car_docs(db, today):
        b = _bucket(doc["days"], _ints(s.get("notify_doc_days"), [30, 7, 1, 0]))
        if b is None:
            continue
        car = doc["car"]
        out.append({
            "key": f"doc:{car['id']}:{doc['key']}:{doc['date'].isoformat()}:{b}",
            "title": f"🚗 {doc['label']} — {logic.car_title(car)}",
            "message": (f"Срок истёк {doc['date'].day} {MONTHS[doc['date'].month - 1]} ({-doc['days']} дн. назад)" if doc["days"] < 0
                        else "Заканчивается " + _when(db, doc["date"], doc["days"])),
            "resident_id": car.get("owner_id"),
        })

    if s.get("notify_budget", True):
        summary = logic.month_summary(db, today.isoformat()[:7])
        for kind, budget in logic.budgets(db).items():
            if not budget:
                continue
            spent = summary["by_kind"][kind]
            pct = spent / budget * 100
            b = 100 if pct >= 100 else 80 if pct >= 80 else None
            if b is None:
                continue
            out.append({
                "key": f"budget:{kind}:{summary['month']}:{b}",
                "title": f"📊 Бюджет «{logic.KIND_LABELS[kind]}»: {round(pct)}%",
                "message": f"Потрачено {logic.money(db, spent)} из {logic.money(db, budget)}"
                           + (f", перерасход {logic.money(db, spent - budget)}" if pct >= 100 else f", осталось {logic.money(db, budget - spent)}"),
                "resident_id": None,
            })

    return [n for n in out if n["key"] not in log]


def targets(db, note):
    s = db["settings"]
    resident = next((r for r in db["residents"] if r["id"] == note.get("resident_id")), None)
    services = [resident["notify_service"]] if resident and resident.get("notify_service") else list(s.get("notify_services") or [])
    if s.get("notify_persistent", True):
        services.append("persistent_notification")
    return services


def in_send_window(db, now=None):
    now = now or datetime.now()
    return int(db["settings"].get("notify_hour", 9)) <= now.hour < QUIET_FROM_HOUR


# --- background worker ------------------------------------------------------------
def wake():
    _wake.set()


def tick(load, save, lock):
    with lock:
        db = load()
        if logic.auto_pay(db):
            save(db)
        snapshot = json.loads(json.dumps(db))
    if not client.available:
        return
    try:
        if snapshot["settings"].get("sync_persons", True):
            persons = fetch_persons()
            with lock:
                db = load()
                before = json.dumps(db["residents"], sort_keys=True)
                apply_persons(db, persons)
                if json.dumps(db["residents"], sort_keys=True) != before:
                    save(db)
                snapshot = json.loads(json.dumps(db))
        if snapshot["settings"].get("sensors_enabled", True):
            push_sensors(snapshot)
        status.update(connected=True, last_push=datetime.now().isoformat(timespec="seconds"), last_error=None)
    except Exception as e:  # noqa: BLE001 — keep the worker alive, show the error in the UI
        status.update(connected=False, last_error=str(e))
        return

    if not snapshot["settings"].get("notify_enabled", True) or not in_send_window(snapshot):
        return
    sent = []
    for note in collect(snapshot):
        services = targets(snapshot, note)
        if not services:
            continue
        try:
            for service in services:
                client.notify(service, note["title"], note["message"], tag=note["key"].rsplit(":", 1)[0].replace(":", "_"))
            sent.append(note["key"])
        except Exception as e:  # noqa: BLE001
            status["last_error"] = str(e)
    if sent:
        with lock:
            db = load()
            log = db.setdefault("notify_log", {})
            stamp = datetime.now().isoformat(timespec="seconds")
            log.update({k: stamp for k in sent})
            cutoff = (date.today() - timedelta(days=400)).isoformat()
            db["notify_log"] = {k: v for k, v in log.items() if v >= cutoff}
            save(db)
        status["sent"] += len(sent)


def start(load, save, lock):
    def run():
        while True:
            try:
                tick(load, save, lock)
            except Exception as e:  # noqa: BLE001
                status["last_error"] = f"worker: {e}"
            _wake.wait(TICK_SECONDS)
            if _wake.is_set():
                _wake.clear()
                time.sleep(2)  # debounce bursts of edits
    threading.Thread(target=run, daemon=True, name="ha-worker").start()
