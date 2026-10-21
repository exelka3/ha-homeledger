"""Homeledger — backend for the Home Assistant add-on.

Zero dependencies: Python stdlib HTTP server + JSON file storage.
All URLs are relative so the app works behind HA Ingress.
"""

import json
import os
import threading
import time
import uuid
from datetime import datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import ha
import logic
import todo_sync

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR.parent / "data"))
DB_FILE = DATA_DIR / "db.json"
PORT = int(os.environ.get("PORT", "8099"))
# In the add-on only the Supervisor's Ingress proxy may talk to us (no auth of our own).
ALLOWED_CLIENTS = {ip.strip() for ip in os.environ.get("ALLOWED_CLIENTS", "").split(",") if ip.strip()}

COLLECTIONS = ("residents", "plans", "plan_items", "groceries", "trips", "cars", "car_expenses", "recurring", "payments")

# Child collections removed together with their parent record.
CASCADE = {"plans": ("plan_items", "plan_id"), "cars": ("car_expenses", "car_id")}

DEFAULT_DB = {
    "residents": [],
    "plans": [],
    "plan_items": [],
    "groceries": [],
    "trips": [],
    "cars": [],
    "car_expenses": [],
    "recurring": [],
    "payments": [],
    "notify_log": {},
    "settings": {
        "currency": "₽",
        "currency_code": "RUB",
        "currency_position": "after",
        "currency_decimals": True,
        "payment_methods": ["Карта", "Наличные", "Перевод", "Рассрочка"],
        "rooms": ["Кухня", "Гостиная", "Спальня", "Ванная", "Прихожая", "Детская", "Балкон", "Двор"],
        "grocery_categories": ["Овощи и фрукты", "Молочное", "Мясо и рыба", "Хлеб", "Бакалея", "Напитки", "Бытовая химия", "Другое"],
        "car_categories": ["Топливо", "ТО и ремонт", "Шины", "Страховка", "Налог", "Штрафы", "Мойка", "Парковка", "Регистрация и документы", "Другое"],
        "bill_categories": ["Коммунальные услуги", "Аренда и ипотека", "Кредиты", "Интернет и связь", "Подписки", "Страхование", "Налоги", "Образование и кружки", "Другое"],
        "stores": [],
        "favorite_products": [],
        "hidden_products": [],
        "budget_groceries": 0,
        "budget_home": 0,
        "budget_car": 0,
        "budget_bills": 0,
        "sensors_enabled": True,
        "sync_persons": True,
        "todo_entity": "",
        "yandex_station": "",
        "notify_enabled": True,
        "notify_services": [],
        "notify_persistent": True,
        "notify_hour": 9,
        "notify_bill_days": [3, 0],
        "notify_doc_days": [30, 7, 1, 0],
        "notify_budget": True,
    },
}

# Settings lists whose values are also stored in records: renaming updates both.
RENAME_TARGETS = {
    "stores": [("trips", "store")],
    "payment_methods": [("plan_items", "payment_method"), ("trips", "payment_method"), ("car_expenses", "payment_method"),
                        ("recurring", "payment_method"), ("payments", "payment_method")],
    "rooms": [("plans", "room")],
    "grocery_categories": [("groceries", "category")],
    "car_categories": [("car_expenses", "category")],
    "bill_categories": [("recurring", "category"), ("payments", "category")],
}

_lock = threading.Lock()
_avatars = {}  # HA picture url -> (bytes, content type)


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def load_db():
    if not DB_FILE.exists():
        return json.loads(json.dumps(DEFAULT_DB))
    with DB_FILE.open(encoding="utf-8") as f:
        db = json.load(f)
    for key, value in DEFAULT_DB.items():
        db.setdefault(key, json.loads(json.dumps(value)))
    if "stores" not in db["settings"]:
        # Older databases only had store names inside trips — turn them into an editable list.
        db["settings"]["stores"] = sorted({t["store"] for t in db["trips"] if t.get("store")})
    for key, value in DEFAULT_DB["settings"].items():
        db["settings"].setdefault(key, value)
    return db


def save_db(db):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = DB_FILE.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=1)
    os.replace(tmp, DB_FILE)


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def checkout(db, body):
    """Close a shopping trip: checked items go to the receipt, the rest stay planned."""
    bought_ids = set(body.get("bought_ids") or [])
    if not bought_ids:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Не отмечено ни одного продукта")
    try:
        total = float(body.get("total") or 0)
    except (TypeError, ValueError):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Некорректная сумма чека")

    bought, remaining = [], []
    for item in db["groceries"]:
        (bought if item["id"] in bought_ids else remaining).append(item)

    trip = {
        "id": uuid.uuid4().hex[:12],
        "date": body.get("date") or now_iso()[:10],
        "store": (body.get("store") or "").strip(),
        "total": total,
        "payer_id": body.get("payer_id") or None,
        "payment_method": body.get("payment_method") or "",
        "items": [
            {"name": i["name"], "qty": i.get("qty", ""), "category": i.get("category", "")}
            for i in bought
        ],
        "skipped": len(remaining),
        "created_at": now_iso(),
    }
    db["trips"].append(trip)
    db["groceries"] = remaining
    if trip["store"] and trip["store"] not in db["settings"]["stores"]:
        db["settings"]["stores"].append(trip["store"])
    return trip


def rename_setting(db, body):
    key, old, new = body.get("key"), body.get("old"), (body.get("new") or "").strip()
    values = db["settings"].get(key)
    if not isinstance(values, list) or old not in values or not new:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Нечего переименовывать")
    if new in values and new != old:
        values.remove(old)  # merging into an existing value
    else:
        values[values.index(old)] = new
    changed = 0
    for coll, field in RENAME_TARGETS.get(key, []):
        for rec in db[coll]:
            if rec.get(field) == old:
                rec[field] = new
                changed += 1
    if key == "grocery_categories":
        for trip in db["trips"]:
            for item in trip["items"]:
                if item.get("category") == old:
                    item["category"] = new
    return {"ok": True, "records": changed}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def end_headers(self):
        # Revalidate static files on every load so add-on updates show up immediately.
        if "Cache-Control" not in "".join(h.decode("latin-1") for h in getattr(self, "_headers_buffer", [])):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        print(f"[{time.strftime('%H:%M:%S')}] {self.address_string()} {fmt % args}", flush=True)

    # --- helpers ---------------------------------------------------------
    def _send_json(self, payload, status=HTTPStatus.OK):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Invalid JSON")

    def _api_parts(self):
        path = self.path.split("?", 1)[0]
        idx = path.find("/api/")
        if idx == -1:
            return None
        return [p for p in path[idx + 5:].split("/") if p]

    def _send_avatar(self, resident_id):
        with _lock:
            resident = next((r for r in load_db()["residents"] if r["id"] == resident_id), None)
        picture = resident and resident.get("picture")
        if not picture or not ha.client.available:
            return self._send_json({"error": "Нет аватара"}, HTTPStatus.NOT_FOUND)
        if picture not in _avatars:
            try:
                _avatars[picture] = ha.client.get_bytes(picture)
            except Exception as e:  # noqa: BLE001
                return self._send_json({"error": str(e)}, HTTPStatus.BAD_GATEWAY)
        data, ctype = _avatars[picture]
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=86400")
        self.end_headers()
        self.wfile.write(data)

    def _allowed(self):
        if ALLOWED_CLIENTS and self.client_address[0] not in ALLOWED_CLIENTS:
            self.send_error(HTTPStatus.FORBIDDEN, "Open Homeledger from the Home Assistant sidebar")
            return False
        return True

    def do_HEAD(self):
        if self._allowed():
            super().do_HEAD()

    def _handle(self, method):
        if not self._allowed():
            return
        parts = self._api_parts()
        if parts and parts[:2] == ["ha", "avatar"] and len(parts) == 3 and method == "GET":
            return self._send_avatar(parts[2])
        if parts == ["ha", "todo", "sync"] and method == "POST":
            # Runs outside the db lock: it talks to HA and takes the lock itself.
            try:
                result = todo_sync.sync(load_db, save_db, _lock)
            except Exception as e:  # noqa: BLE001
                return self._send_json({"error": f"Синхронизация не удалась: {e}"}, HTTPStatus.BAD_GATEWAY)
            if result is None:
                return self._send_json({"error": "Не выбран список дел Home Assistant"}, HTTPStatus.BAD_REQUEST)
            return self._send_json(result)
        if parts is None:
            if method == "GET":
                return super().do_GET()
            return self._send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
        try:
            body = self._read_body() if method in ("POST", "PUT") else {}
            with _lock:
                db = load_db()
                result, changed = self._route(db, method, parts, body)
                if changed:
                    save_db(db)
            if changed:
                ha.wake()
            self._send_json(result)
        except ApiError as e:
            self._send_json({"error": str(e)}, e.status)
        except Exception as e:  # noqa: BLE001 — surface any bug to the UI
            self._send_json({"error": f"Server error: {e}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def _route(self, db, method, parts, body):
        if parts == ["state"] and method == "GET":
            changed = logic.auto_pay(db)
            return logic.with_next_due(db), changed

        if parts == ["me"] and method == "GET":
            # HA Ingress tells us who opened the add-on.
            user_id = self.headers.get("X-Remote-User-Id")
            name = self.headers.get("X-Remote-User-Display-Name") or self.headers.get("X-Remote-User-Name")
            if name:
                # http.server decodes headers as latin-1; HA sends UTF-8 (Cyrillic names).
                try:
                    name = name.encode("latin-1").decode("utf-8")
                except (UnicodeEncodeError, UnicodeDecodeError):
                    pass
            r = ha.resident_for_user(db, user_id, name)
            return {"user_id": user_id, "name": name, "resident_id": r["id"] if r else None}, False

        if parts[:1] == ["ha"]:
            return self._route_ha(db, method, parts[1:], body)

        if len(parts) == 3 and parts[0] == "recurring" and method == "POST" and parts[2] in ("pay", "skip"):
            rec = next((r for r in db["recurring"] if r["id"] == parts[1]), None)
            if rec is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Платёж не найден")
            if not logic.next_due(rec):
                raise ApiError(HTTPStatus.BAD_REQUEST, "У платежа нет ближайшего срока")
            return (logic.pay(db, rec, body) if parts[2] == "pay" else logic.skip(db, rec)), True

        if parts == ["settings"] and method == "PUT":
            db["settings"].update(body)
            return db["settings"], True

        if parts == ["settings", "rename"] and method == "POST":
            return rename_setting(db, body), True

        if parts == ["groceries", "checkout"] and method == "POST":
            return checkout(db, body), True

        if parts == ["export"] and method == "GET":
            return {k: v for k, v in db.items() if k != "notify_log"}, False

        if parts == ["import"] and method == "POST":
            for key in DEFAULT_DB:
                if key in body:
                    db[key] = body[key]
            return {"ok": True}, True

        if not parts or parts[0] not in COLLECTIONS:
            raise ApiError(HTTPStatus.NOT_FOUND, "Unknown endpoint")

        coll = db[parts[0]]
        item_id = parts[1] if len(parts) > 1 else None

        if method == "GET":
            return coll, False

        if method == "POST" and item_id is None:
            item = {**body, "id": uuid.uuid4().hex[:12], "created_at": now_iso()}
            coll.append(item)
            return item, True

        target = next((x for x in coll if x["id"] == item_id), None)
        if target is None:
            raise ApiError(HTTPStatus.NOT_FOUND, "Запись не найдена")

        if method == "PUT":
            body.pop("id", None)
            target.update(body)
            target["updated_at"] = now_iso()
            return target, True

        if method == "DELETE":
            coll.remove(target)
            if parts[0] in CASCADE:
                child, key = CASCADE[parts[0]]
                db[child] = [i for i in db[child] if i.get(key) != item_id]
            if parts[0] == "payments" and target.get("recurring_id"):
                # Deleting a payment reopens its period.
                rec = next((r for r in db["recurring"] if r["id"] == target["recurring_id"]), None)
                if rec:
                    logic.recompute_last_period(db, rec)
            return {"ok": True}, True

        raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "Method not allowed")

    def _route_ha(self, db, method, parts, body):
        if parts == ["status"] and method == "GET":
            services = []
            if ha.client.available:
                try:
                    services = ha.client.notify_services()
                    ha.status.update(connected=True)
                except Exception as e:  # noqa: BLE001
                    ha.status.update(connected=False, last_error=str(e))
            return {**ha.status, "notify_services": services, "todo": todo_sync.state}, False

        if parts == ["entities"] and method == "GET":
            if not ha.client.available:
                return {"todo": [], "stations": []}, False
            try:
                todo = ha.client.entities("todo")
                players = ha.client.entities("media_player")
            except RuntimeError as e:
                raise ApiError(HTTPStatus.BAD_GATEWAY, str(e))
            pick = lambda s: {"entity_id": s["entity_id"], "name": s.get("attributes", {}).get("friendly_name") or s["entity_id"]}
            # Yandex.Station players first: they're the ones that can sync Alice's list.
            players.sort(key=lambda s: "yandex" not in s["entity_id"])
            return {"todo": [pick(s) for s in todo], "stations": [pick(s) for s in players]}, False

        if parts == ["preview"] and method == "GET":
            pending = [{**n, "targets": ha.targets(db, n)} for n in ha.collect(db)]
            sensors = {k: {"state": v[0], "attributes": v[1]} for k, v in ha.sensors(db).items()}
            return {"pending": pending, "in_window": ha.in_send_window(db), "sensors": sensors}, False

        if parts == ["test"] and method == "POST":
            if not ha.client.available:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Нет подключения к Home Assistant")
            services = [body["service"]] if body.get("service") else ha.targets(db, {})
            if not services:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Не выбран ни один сервис уведомлений")
            try:
                for service in services:
                    ha.client.notify(service, "Homeledger", "Тестовое уведомление — всё работает!")
            except RuntimeError as e:
                raise ApiError(HTTPStatus.BAD_GATEWAY, str(e))
            return {"ok": True, "services": services}, False

        if parts == ["persons"] and method == "GET":
            if not ha.client.available:
                return [], False
            return ha.fetch_persons(), False

        if parts == ["persons", "sync"] and method == "POST":
            if not ha.client.available:
                raise ApiError(HTTPStatus.BAD_REQUEST, "Нет подключения к Home Assistant")
            try:
                persons = ha.fetch_persons()
            except RuntimeError as e:
                raise ApiError(HTTPStatus.BAD_GATEWAY, str(e))
            return ha.apply_persons(db, persons), True

        if parts == ["reset"] and method == "POST":
            db["notify_log"] = {}  # resend reminders that are currently due
            return {"ok": True}, True

        raise ApiError(HTTPStatus.NOT_FOUND, "Unknown endpoint")

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_PUT(self):
        self._handle("PUT")

    def do_DELETE(self):
        self._handle("DELETE")


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    ha.start(load_db, save_db, _lock, jobs=[todo_sync.sync])
    print(f"Homeledger listening on :{PORT}, data in {DB_FILE}, Home Assistant: {ha.client.mode}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
