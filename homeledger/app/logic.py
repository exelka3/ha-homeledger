"""Domain calculations shared by the API and the Home Assistant integration."""

import calendar
import uuid
from datetime import date, datetime, timedelta

from i18n import fmt_number, tr

FREQ_MONTHS = {"monthly": 1, "quarterly": 3, "halfyear": 6, "yearly": 12}
KINDS = ("home", "groceries", "car", "bills")
CAR_DOCS = ("osago_until", "kasko_until", "inspection_until", "next_service_date")


def kind_label(kind):
    return tr(f"kind.{kind}")


def parse_date(value):
    try:
        return date.fromisoformat(str(value)[:10]) if value else None
    except ValueError:
        return None


def num(value):
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def new_id():
    return uuid.uuid4().hex[:12]


# --- recurring payments -------------------------------------------------------
def add_months(d, months, day):
    m = d.month - 1 + months
    y, m = d.year + m // 12, m % 12 + 1
    return date(y, m, min(day, calendar.monthrange(y, m)[1]))


def next_period(rec, d):
    freq = rec.get("frequency", "monthly")
    if freq == "once":
        return None  # a one-time payment has no next period
    if freq == "daily":
        return d + timedelta(days=1)
    if freq == "weekly":
        return d + timedelta(days=7)
    anchor = parse_date(rec.get("start_date")) or d
    return add_months(d, FREQ_MONTHS.get(freq, 1), anchor.day)


def period_key(freq, d):
    """Calendar period a date falls in: day, ISO week, month, quarter, half-year or year.
    Keys of one frequency sort chronologically as strings."""
    if freq == "once":
        return "once"  # the whole life of the payment is a single period
    if freq == "daily":
        return d.isoformat()
    if freq == "weekly":
        year, week, _ = d.isocalendar()
        return f"{year}-W{week:02d}"
    if freq == "quarterly":
        return f"{d.year}-Q{(d.month - 1) // 3 + 1}"
    if freq == "halfyear":
        return f"{d.year}-H{(d.month - 1) // 6 + 1}"
    if freq == "yearly":
        return str(d.year)
    return f"{d.year}-{d.month:02d}"


def has_schedule(rec):
    """Only a payment with a first payment date has due dates, reminders and "overdue"."""
    return parse_date(rec.get("start_date")) is not None


def next_due(rec):
    """Date of the first period that is neither paid nor skipped, or None when the payment is over
    or has no schedule (no first payment date)."""
    if rec.get("active") is False or not has_schedule(rec):
        return None
    last = parse_date(rec.get("last_period"))
    due = next_period(rec, last) if last else parse_date(rec.get("start_date"))
    end = parse_date(rec.get("end_date"))
    if due and end and due > end:
        return None
    return due


def paid_in_period(db, rec, key):
    freq = rec.get("frequency", "monthly")
    return any(p.get("recurring_id") == rec["id"] and (d := parse_date(p.get("date"))) and period_key(freq, d) == key
               for p in db["payments"])


def is_finished(rec, today=None, db=None):
    today = today or date.today()
    end = parse_date(rec.get("end_date"))
    if rec.get("active") is False or (end and end < today):
        return True
    if has_schedule(rec):
        return next_due(rec) is None
    # An unscheduled one-time payment is over once it has been paid.
    return rec.get("frequency") == "once" and db is not None and any(p.get("recurring_id") == rec["id"] for p in db["payments"])


def can_pay(db, rec, on=None):
    """A payment can be marked once per calendar period: never ahead of time, never twice.
    Scheduled payments pay their due period (overdue ones can be caught up); unscheduled ones
    pay the period of the payment date if nothing was paid in it yet."""
    on = on or date.today()
    if is_finished(rec, on, db):
        return False
    freq = rec.get("frequency", "monthly")
    if has_schedule(rec):
        due = next_due(rec)
        return bool(due) and period_key(freq, due) <= period_key(freq, on)
    return not paid_in_period(db, rec, period_key(freq, on))


def with_next_due(db):
    """Copy of the db for the API, with the schedule state of each recurring payment."""
    today = date.today()
    out = dict(db)
    out["recurring"] = [{
        **r,
        "next_due": (d.isoformat() if (d := next_due(r)) else None),
        "scheduled": has_schedule(r),
        "finished": is_finished(r, today, db),
        "can_pay": can_pay(db, r, today),
        "paid_this_period": paid_in_period(db, r, period_key(r.get("frequency", "monthly"), today)),
    } for r in db["recurring"]]
    out.pop("notify_log", None)
    return out


def recompute_last_period(db, rec):
    periods = [p["period"] for p in db["payments"] if p.get("recurring_id") == rec["id"] and p.get("period")]
    periods += rec.get("skipped", [])
    rec["last_period"] = max(periods) if periods else None


def pay(db, rec, body, auto=False):
    due = next_due(rec)
    paid_on = body.get("date") or date.today().isoformat()
    # Scheduled: the due period; unscheduled: the period the payment date falls in.
    period = body.get("period") or (due.isoformat() if due else paid_on)
    payment = {
        "id": new_id(),
        "recurring_id": rec["id"],
        "name": rec.get("name", ""),
        "category": rec.get("category", ""),
        "amount": num(body.get("amount", rec.get("amount"))),
        "date": paid_on,
        "payer_id": body.get("payer_id", rec.get("payer_id")) or None,
        "payment_method": body.get("payment_method", rec.get("payment_method")) or "",
        "period": period,
        "note": body.get("note", ""),
        "auto": auto,
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    db["payments"].append(payment)
    if period and (not rec.get("last_period") or period > rec["last_period"]):
        rec["last_period"] = period
    return payment


def skip(db, rec):
    due = next_due(rec)
    if due:
        rec.setdefault("skipped", []).append(due.isoformat())
        rec["last_period"] = due.isoformat()
    return rec


def auto_pay(db, today=None):
    """Record payments marked as automatic whose due date has come. Returns True if anything changed."""
    today = today or date.today()
    changed = False
    for rec in db["recurring"]:
        if not rec.get("auto"):
            continue
        for _ in range(60):  # safety cap when catching up after a long downtime
            due = next_due(rec)
            if not due or due > today:
                break
            pay(db, rec, {"date": due.isoformat(), "period": due.isoformat()}, auto=True)
            changed = True
    return changed


# --- spending -----------------------------------------------------------------
def expenses(db):
    plans = {p["id"]: p for p in db["plans"]}
    out = []
    for i in db["plan_items"]:
        if i.get("status") == "bought":
            out.append({"kind": "home", "date": i.get("bought_at") or (i.get("updated_at") or i.get("created_at") or "")[:10],
                        "amount": num(i.get("price")) * (num(i.get("qty")) or 1), "payer_id": i.get("payer_id"),
                        "category": plans.get(i.get("plan_id"), {}).get("room") or tr("fallback.no_room")})
    for t in db["trips"]:
        out.append({"kind": "groceries", "date": t.get("date", ""), "amount": num(t.get("total")),
                    "payer_id": t.get("payer_id"), "category": kind_label("groceries")})
    for x in db["car_expenses"]:
        out.append({"kind": "car", "date": x.get("date", ""), "amount": num(x.get("amount")),
                    "payer_id": x.get("payer_id"), "category": x.get("category") or tr("fallback.other")})
    for p in db["payments"]:
        out.append({"kind": "bills", "date": p.get("date", ""), "amount": num(p.get("amount")),
                    "payer_id": p.get("payer_id"), "category": p.get("category") or tr("fallback.other")})
    return out


def month_summary(db, month=None):
    month = month or date.today().isoformat()[:7]
    items = [e for e in expenses(db) if str(e["date"]).startswith(month)]
    by_kind = {k: round(sum(e["amount"] for e in items if e["kind"] == k), 2) for k in KINDS}
    names = {r["id"]: r["name"] for r in db["residents"]}
    by_payer = {}
    for e in items:
        name = names.get(e["payer_id"], tr("fallback.not_set"))
        by_payer[name] = round(by_payer.get(name, 0) + e["amount"], 2)
    return {"month": month, "total": round(sum(by_kind.values()), 2), "by_kind": by_kind, "by_payer": by_payer}


def budgets(db):
    s = db["settings"]
    return {k: num(s.get(f"budget_{k}")) for k in KINDS}


def car_docs(db, today=None):
    today = today or date.today()
    out = []
    for car in db["cars"]:
        for key in CAR_DOCS:
            d = parse_date(car.get(key))
            if d:
                out.append({"car": car, "key": key, "label": tr(f"car_doc.{key}"), "date": d, "days": (d - today).days})
    return sorted(out, key=lambda x: x["days"])


def car_title(car):
    return (car.get("name") or tr("fallback.car")) + (f" ({car['plate']})" if car.get("plate") else "")


def money(db, value):
    s = db["settings"]
    decimals = 0 if s.get("currency_decimals") is False or float(value).is_integer() else 2
    n = fmt_number(value, decimals)
    sym = s.get("currency", "€")
    return f"{sym}{n}" if s.get("currency_position") == "before" else f"{n} {sym}"
