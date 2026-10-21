# Changelog

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
