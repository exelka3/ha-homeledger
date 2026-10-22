# Changelog

## 1.6.0

- One-time payments: a new "One-time" frequency for bills that don't repeat. With a date it
  has a due date and a reminder; without one it can be marked paid once. After payment it
  moves to finished bills. One-time payments don't count towards fixed costs per month.

## 1.5.0

- Recurring bills are grouped into category cards (e.g. Pets → food, pills, vet; Car →
  insurance, inspection) with the number of bills and the monthly cost of each category.
- **＋ Category** on the Bills tab creates a category and opens a new bill in it; **＋** on a
  card adds a bill to that category; the bill form has **＋ New category…**.
- Empty categories are listed below the cards for one-click adding.
- New installs get a "Pets" bill category.

## 1.4.0

- Recurring bills: the first payment date is optional. Without it there are no due dates,
  reminders or "overdue" — the bill just shows whether the current period is paid.
- **Paid** can be marked once per calendar period: once a day, week, calendar month,
  quarter, half-year (Jan–Jun / Jul–Dec) or year. Paying ahead for a future period is no
  longer possible; overdue past periods can still be caught up. The server enforces it too.
- New frequency: daily.
- Optional date fields get a clear (✕) button — mobile date pickers can't erase a date.
- Automatic payments require a first payment date.

## 1.3.0

- Sync with Alice is now manual only: the **Sync with Alice** button on the Groceries tab.
  Yandex.Station makes the speaker read the list aloud on every sync, so it no longer runs
  in the background. The Home Assistant to-do list still syncs automatically.
- The sync button moved from Settings to the Groceries tab.

## 1.2.2

- Fixed: after an update the browser or the Home Assistant app could keep showing the
  previous version. Scripts, styles and translations are now loaded with a content
  fingerprint, and the page itself is never cached.
- The add-on version is shown at the bottom of **Settings**.

## 1.2.1

- Compact amounts in the monthly chart and the per-resident table now keep one decimal
  ("143.3k", "1.2M" instead of "143k"); the exact amount is in the tooltip.
- Averages (average receipt, per-month averages, fixed costs per month) are no longer
  rounded to whole units; they are shown to the cent.

## 1.2.0

- Multilingual: English, Русский, Deutsch, Français, Español, Italiano, Português,
  Nederlands, Polski, Українська, Lietuvių, Latviešu, Eesti. The language follows the browser / Home Assistant
  by default and can be set in **Settings → Language & currency**.
- Notifications and sensor names use the app language; dates, months and numbers are
  formatted for the selected language.
- New installs get category lists and a currency matching their language.
- **Breaking:** attributes of `sensor.home_budget_month_total` are now `by_kind`
  (keys `home`, `groceries`, `car`, `bills`) and `by_resident`, instead of
  Russian-named attributes. Update automations that read them.

## 1.1.0

- Two-way sync of the grocery list with a Home Assistant to-do list (`todo.*`).
- Through the Yandex.Station integration — with Alice's shopping list: items added by
  voice appear in Homeledger, items bought in the store are crossed off for Alice.
- Items coming from Home Assistant get a category based on purchase history.

## 1.0.0

First release.

- Monthly overview with budgets per section.
- Home improvement plans with items, prices, payer and payment method.
- Grocery list, in-store mode, receipt history, frequent-purchase suggestions.
- Cars: registration details, document deadlines, expenses.
- Recurring bills: reminders, mark as paid, skip, auto-pay.
- Statistics by month, resident, section, category and store.
- Home Assistant integration: residents from `person.*`, sensors, notifications.
- Currency settings, editable lists, data export and import.
