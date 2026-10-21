"""Fill data/db.json with demo data for trying the prototype: python3 seed_demo.py"""

import random
from datetime import date, timedelta

import server

random.seed(7)
db = server.load_db()
fresh = not db["residents"]


def new_id():
    return server.uuid.uuid4().hex[:12]


if fresh:
    people = [("Анна", "Мама", "#e91e63"), ("Дмитрий", "Папа", "#03a9f4"), ("Миша", "Сын", "#4caf50")]
    for name, role, color in people:
        db["residents"].append({"id": new_id(), "name": name, "role": role, "color": color})
    anna, dima, misha = (r["id"] for r in db["residents"])

    today = date.today()
    plans = [
        ("Ремонт кухни", "Кухня", "in_progress", "high", [
            ("Смеситель", 8900, 1, dima, "Карта", True),
            ("Фартук плитка, м²", 2100, 6, dima, "Карта", True),
            ("Вытяжка", 24500, 1, anna, "Рассрочка", False),
            ("Светильники под шкафы", 1800, 3, anna, "Карта", False),
        ]),
        ("Уют в гостиной", "Гостиная", "planned", "medium", [
            ("Диван", 64000, 1, dima, "Рассрочка", False),
            ("Ковёр", 12000, 1, anna, "Карта", True),
            ("Шторы блэкаут", 5400, 2, anna, "Наличные", False),
        ]),
        ("Детская для Миши", "Детская", "idea", "low", [
            ("Письменный стол", 15900, 1, dima, "Перевод", False),
            ("Лампа настольная", 2300, 1, misha, "Наличные", True),
        ]),
    ]
    for title, room, status, prio, items in plans:
        pid = new_id()
        db["plans"].append({"id": pid, "title": title, "room": room, "status": status, "priority": prio, "note": ""})
        for name, price, qty, payer, method, bought in items:
            db["plan_items"].append({
                "id": new_id(), "plan_id": pid, "name": name, "price": price, "qty": qty,
                "payer_id": payer, "payment_method": method,
                "status": "bought" if bought else "planned",
                "bought_at": (today - timedelta(days=random.randint(0, 120))).isoformat() if bought else "",
            })

    products = [
        ("Молоко", "Молочное"), ("Творог", "Молочное"), ("Сыр", "Молочное"), ("Хлеб", "Хлеб"),
        ("Бананы", "Овощи и фрукты"), ("Яблоки", "Овощи и фрукты"), ("Помидоры", "Овощи и фрукты"),
        ("Курица", "Мясо и рыба"), ("Фарш", "Мясо и рыба"), ("Гречка", "Бакалея"), ("Макароны", "Бакалея"),
        ("Сок", "Напитки"), ("Средство для посуды", "Бытовая химия"), ("Яйца", "Молочное"),
    ]
    stores = ["Пятёрочка", "Перекрёсток", "ВкусВилл", "Лента"]
    for d in range(170, 0, -4):
        picked = random.sample(products, random.randint(3, 8))
        db["trips"].append({
            "id": new_id(), "date": (today - timedelta(days=d)).isoformat(), "store": random.choice(stores),
            "total": random.randint(9, 45) * 100 + random.randint(0, 99),
            "payer_id": random.choice([anna, anna, dima]), "payment_method": random.choice(["Карта", "Карта", "Наличные"]),
            "items": [{"name": n, "qty": "", "category": c} for n, c in picked],
            "skipped": random.randint(0, 2), "created_at": server.now_iso(),
        })

    for n, c in random.sample(products, 7):
        db["groceries"].append({"id": new_id(), "name": n, "qty": "", "category": c, "added_by": random.choice([anna, dima, misha])})

    db["settings"]["budget_groceries"] = 30000
    db["settings"]["budget_home"] = 50000

anna, dima = (r["id"] for r in db["residents"][:2])
today = date.today()

# Cars are seeded separately so they can be added to an existing demo db.
if not db["cars"]:
    for name, year, plate, owner, color, mileage, docs in [
        ("Kia Rio", 2019, "А123ВС 77", anna, "#e53935", 68400,
         {"osago_until": today + timedelta(days=14), "inspection_until": today + timedelta(days=200), "next_service_date": today + timedelta(days=45)}),
        ("Toyota RAV4", 2022, "М456ОР 50", dima, "#546e7a", 41200,
         {"osago_until": today + timedelta(days=160), "kasko_until": today - timedelta(days=3), "next_service_date": today + timedelta(days=90)}),
    ]:
        cid = new_id()
        db["cars"].append({
            "id": cid, "name": name, "year": year, "plate": plate, "owner_id": owner, "color": color,
            "mileage": mileage + 2000, "vin": "XW8" + new_id()[:14].upper(), "sts": f"77 {random.randint(10,99)} {random.randint(100000,999999)}",
            "registered_at": date(year, random.randint(1, 12), random.randint(1, 28)).isoformat(),
            **{k: v.isoformat() for k, v in docs.items()},
        })
        km = mileage - 6000
        for d in range(170, 0, -6):
            km += random.randint(150, 400)
            db["car_expenses"].append({
                "id": new_id(), "car_id": cid, "date": (today - timedelta(days=d)).isoformat(), "category": "Топливо",
                "amount": random.randint(25, 45) * 100, "liters": random.randint(30, 50), "mileage": km,
                "payer_id": owner, "payment_method": "Карта",
            })
        for cat, amount, note in [("ТО и ремонт", 14800, "Плановое ТО"), ("Мойка", 900, ""), ("Шины", 32000, "Зимняя резина"),
                                  ("Страховка", 9800, "ОСАГО"), ("Штрафы", 500, "Превышение скорости"), ("Парковка", 1200, "")]:
            db["car_expenses"].append({
                "id": new_id(), "car_id": cid, "date": (today - timedelta(days=random.randint(0, 160))).isoformat(),
                "category": cat, "amount": amount, "note": note, "payer_id": random.choice([owner, owner, anna, dima]),
                "payment_method": random.choice(["Карта", "Перевод"]),
            })
    db["settings"]["budget_car"] = 25000

# Recurring payments with half a year of history.
if not db["recurring"]:
    import logic
    for name, cat, amount, freq, start, payer, auto, variable in [
        ("Квартплата и коммуналка", "Коммунальные услуги", 7800, "monthly", today.replace(day=1) - timedelta(days=150), dima, False, True),
        ("Ипотека", "Аренда и ипотека", 38500, "monthly", date(today.year - 2, 3, 15), dima, True, False),
        ("Домашний интернет", "Интернет и связь", 650, "monthly", today - timedelta(days=178), anna, False, False),
        ("Мобильная связь (семья)", "Интернет и связь", 1200, "monthly", today - timedelta(days=176), anna, True, False),
        ("Кинопоиск", "Подписки", 399, "monthly", today - timedelta(days=170), anna, True, False),
        ("Секция плавания", "Образование и кружки", 4500, "monthly", today - timedelta(days=160), anna, False, False),
        ("Страховка квартиры", "Страхование", 5600, "yearly", today + timedelta(days=40), dima, False, False),
    ]:
        rec = {"id": new_id(), "name": name, "category": cat, "amount": amount, "frequency": freq,
               "start_date": start.isoformat(), "payer_id": payer, "payment_method": "Карта", "auto": auto, "variable": variable}
        db["recurring"].append(rec)
        for _ in range(60):
            due = logic.next_due(rec)
            if not due or (due - today).days > -1 or (not auto and (today - due).days < 3):
                break  # leave the most recent manual period open so reminders have something to show
            if (today - due).days > 200:
                logic.skip(db, rec)  # don't backfill years of mortgage history
                continue
            logic.pay(db, rec, {"date": due.isoformat(), "period": due.isoformat(),
                                "amount": amount + (random.randint(-900, 1400) if variable else 0)}, auto=auto)
    db["settings"]["budget_bills"] = 65000

server.save_db(db)
print("Demo data written to", server.DB_FILE)
