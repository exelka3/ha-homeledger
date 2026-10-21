"""Server-side translations: notifications, sensor names, API errors and default lists.

Dictionaries live in app/locales/<lang>.json (flat keys, English fallback). Plural entries are objects
keyed by CLDR category ("one", "few", "many", "other") and are selected with the `n` variable.
"""

import json
from pathlib import Path

LOCALES_DIR = Path(__file__).resolve().parent / "locales"
SUPPORTED = ("en", "ru", "de", "fr", "es", "it", "pt", "nl", "pl", "uk", "lt", "lv", "et")

_cache = {}
_current = "en"
ha_language = None  # Home Assistant's own language, filled in by the HA client when available


def _dict(lang):
    if lang not in _cache:
        path = LOCALES_DIR / f"{lang}.json"
        _cache[lang] = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    return _cache[lang]


def plural_category(lang, n):
    """CLDR cardinal rules for the supported languages (integer part is enough for our counts)."""
    i = abs(int(n))
    if lang in ("ru", "uk"):
        if i % 10 == 1 and i % 100 != 11:
            return "one"
        if 2 <= i % 10 <= 4 and not 12 <= i % 100 <= 14:
            return "few"
        return "many"
    if lang == "pl":
        if i == 1:
            return "one"
        if 2 <= i % 10 <= 4 and not 12 <= i % 100 <= 14:
            return "few"
        return "many"
    if lang == "lt":
        if i % 10 == 1 and not 11 <= i % 100 <= 19:
            return "one"
        if 2 <= i % 10 <= 9 and not 11 <= i % 100 <= 19:
            return "few"
        return "other"
    if lang == "lv":
        if i % 10 == 0 or 11 <= i % 100 <= 19:
            return "zero"
        if i % 10 == 1 and i % 100 != 11:
            return "one"
        return "other"
    if lang in ("fr", "pt"):
        return "one" if i in (0, 1) else "other"
    return "one" if i == 1 else "other"


def normalize(code):
    code = str(code or "").lower().replace("_", "-").split("-")[0]
    return code if code in SUPPORTED else None


def resolve(setting, hint=None):
    """Language for server text: explicit setting, else the browser's (hint), else HA's language, else English."""
    explicit = normalize(setting) if setting and setting != "auto" else None
    return explicit or normalize(hint) or normalize(ha_language) or "en"


def use(lang):
    global _current
    _current = lang if lang in SUPPORTED else "en"


def current():
    return _current


def tr(key, lang=None, **vars):
    lang = lang or _current
    value = _dict(lang).get(key, _dict("en").get(key, key))
    if isinstance(value, dict):
        n = vars.get("n", 0)
        value = value.get(plural_category(lang, n)) or value.get("other") or next(iter(value.values()))
    if isinstance(value, list):
        return list(value)
    for k, v in vars.items():
        value = value.replace("{" + k + "}", str(v))
    return value


def month_short(month_index, lang=None):
    return tr("months_short", lang)[month_index]


def fmt_number(value, decimals=0, lang=None):
    lang = lang or _current
    text = f"{value:,.{decimals}f}"
    group, point = {"en": (",", "."), "de": (".", ","), "nl": (".", ","), "it": (".", ","), "es": (".", ","),
                    "pt": (".", ",")}.get(lang, (" ", ","))
    return text.replace(",", "\x00").replace(".", point).replace("\x00", group)
