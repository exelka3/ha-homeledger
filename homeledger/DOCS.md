# Homeledger

A household budget inside Home Assistant: home improvement plans, a shared shopping
list with an in-store mode, cars, recurring bills, residents and spending statistics.

Open it from the Home Assistant sidebar (**Homeledger**). No port is exposed to the
network — access goes through Home Assistant and its user accounts only.

**Languages:** English, Русский, Deutsch, Français, Español, Italiano, Português,
Nederlands, Polski, Українська, Lietuvių, Latviešu, Eesti. By default the app follows your browser / Home
Assistant language; change it in **Settings → Language & currency**.
Documentation in Russian: [DOCS.ru.md](https://github.com/exelka3/ha-homeledger/blob/main/homeledger/DOCS.ru.md).

## Sections

- **Overview** — this month's spending and budgets, upcoming bills, car document deadlines.
- **Home improvement** — plans by room: items with price, who pays and how.
- **Groceries** — a shared list; **Go shopping** switches to an in-store mode where you
  tick what you bought and enter the receipt total. Unticked items stay on the list.
- **Cars** — cars (plate, VIN, registration, insurance, inspection and service dates) and expenses.
- **Bills** — utilities, mortgage, subscriptions: reminders, marking as paid, auto-pay.
  **Paid** can be marked once per calendar period (day, week, month, quarter, half-year,
  year). The first payment date is optional: without it there are no due dates or reminders.
- **Statistics** — by month, resident, section, category and store.
- **Settings** — residents, budgets, language & currency, lists, Home Assistant, export.

## Residents

People from Home Assistant (**Settings → People**) are added automatically, with their
avatar and the notification service of their phone. Whoever opens Homeledger is
pre-selected as the payer. Residents without a Home Assistant account (e.g. children)
can be added manually.

## Shopping list and Alice (Yandex Station)

The grocery list syncs both ways with a Home Assistant to-do list, and through it with
Alice's shopping list on a Yandex Station.

Requirements:

1. In Home Assistant — the **Shopping list** or **Local To-do** integration
   (Todoist, Google Tasks and other to-do lists work too).
2. For Alice — the [Yandex.Station](https://github.com/AlexxIT/YandexStation)
   integration from HACS, with the speaker in **local mode** (same network as HA).
3. In Homeledger: **Settings → Shopping list ⇄ Alice** — pick the list and the speaker.

How it works:

- "Alice, add milk to my shopping list" — milk shows up in Homeledger after the next
  “Sync with Alice” (its category is guessed from past purchases).
- Items added, renamed or removed in Homeledger go to Home Assistant and Alice.
- Items bought in the in-store mode are crossed off for Alice too (on the next sync with Alice).
- Changes in Homeledger reach the Home Assistant list automatically (every minute and
  a couple of seconds after each change).
- Alice's list syncs **only when you tap “Sync with Alice”** on the Groceries tab: the
  speaker reads the list aloud whenever Yandex.Station syncs it, so this never runs on
  its own.

Yandex limitations: Alice silently rejects some item names; don't clear completed items
in the Home Assistant list by hand — Yandex.Station uses them to cross items off for Alice.

## Sensors

Updated every 5 minutes and right after changes:

| Sensor | Value |
| --- | --- |
| `sensor.home_budget_month_total` | spending this month (attributes `by_kind`, `by_resident`) |
| `sensor.home_budget_groceries_month` | groceries this month, with `budget`, `remaining`, `percent` |
| `sensor.home_budget_home_month` | home improvement this month |
| `sensor.home_budget_car_month` | car expenses this month |
| `sensor.home_budget_bills_month` | recurring bills this month |
| `sensor.home_budget_shopping_list` | items on the shopping list (attribute `items`) |
| `sensor.home_budget_bills_due` | bills due within a week (attribute `payments`) |
| `sensor.home_budget_car_documents` | car documents expiring within 30 days |
| `sensor.home_budget_home_planned` | what is still to buy for the home |

Sensor names follow the app language; entity IDs and attribute keys are always English,
so automations keep working when the language changes. The sensors are published through
the API and reappear within 5 minutes after Home Assistant restarts.

## Notifications

Configure in **Settings → Home Assistant**:

- bills — N days before and on the due date (default: 3 days before and on the day),
  sent to whoever pays;
- car documents — 30, 7, 1 days before and on the expiry date, sent to the car owner;
- budgets — at 80% and 100%.

Recipients are `notify.*` services (e.g. `notify.mobile_app_pixel_8`). Nothing is sent at
night (from 22:00 until the configured hour). **Send test** checks delivery.
Notifications use the app language.

## Data and backups

All data lives in a single file, `/data/db.json`, and is included in Home Assistant
backups. JSON export and import are in **Settings → Data**.
