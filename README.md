# Homeledger — Home Assistant add-on repository

![Homeledger](homeledger/logo.png)

A household budget inside Home Assistant: home improvement plans, groceries with an
in-store mode, cars, recurring bills, residents from Home Assistant, sensors and
notifications, shopping list sync with Alice (Yandex Station), spending statistics.
13 languages. Details: [homeledger/DOCS.md](homeledger/DOCS.md)
(по-русски: [homeledger/DOCS.ru.md](homeledger/DOCS.ru.md)).

## Installation

### From GitHub

1. In Home Assistant: **Settings → Add-ons → Add-on store → ⋮ → Repositories**.
2. Add `https://github.com/exelka3/ha-homeledger`.
3. Find **Homeledger**, click **Install**, then **Start**, and enable **Show in sidebar**.

### Locally, without GitHub

1. Copy the `homeledger` folder into Home Assistant's `/addons` directory (for example with
   the *Samba share* or *Advanced SSH & Web Terminal* add-ons) so that
   `/addons/homeledger/config.yaml` exists.
2. **Settings → Add-ons → Add-on store → ⋮ → Check for updates**.
3. Open **Local add-ons → Homeledger → Install**.

The Docker image is built on your Home Assistant host and takes 1–3 minutes.

## Development

```bash
python3 homeledger/app/server.py          # http://localhost:8099
python3 homeledger/app/seed_demo.py       # demo data in homeledger/data/db.json
```

To test the Home Assistant integration outside HA, set `HA_URL` and `HA_TOKEN`
(a long-lived access token).

### Adding a language

1. Copy `homeledger/app/static/locales/en.json` (UI) and `homeledger/app/locales/en.json`
   (notifications, sensors, default lists) to `<code>.json` and translate the values.
2. Add the code to `LANGUAGES` in `homeledger/app/static/i18n.js` and to `SUPPORTED`
   in `homeledger/app/i18n.py` (plus a plural rule in `plural_category` if needed).
