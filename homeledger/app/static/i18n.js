/* Homeledger i18n: flat JSON dictionaries in locales/<lang>.json, English as the fallback.
 *
 *   t("nav.overview")                       -> "Overview"
 *   t("bills.left_count", { n: 3 })          -> plural form picked with Intl.PluralRules
 *   t("budget.of", { pct: 74, total: "…" })  -> "{name}" placeholders are replaced
 *
 * A plural entry is an object keyed by CLDR category: { "one": "…", "few": "…", "many": "…", "other": "…" }.
 * Static markup is translated through data-i18n / data-i18n-title / data-i18n-aria attributes. */

const LANGUAGES = [
  ["en", "English"], ["ru", "Русский"], ["de", "Deutsch"], ["fr", "Français"], ["es", "Español"],
  ["it", "Italiano"], ["pt", "Português"], ["nl", "Nederlands"], ["pl", "Polski"], ["uk", "Українська"],
  ["lt", "Lietuvių"], ["lv", "Latviešu"], ["et", "Eesti"],
];

const I18N = { lang: "en", dict: {}, fallback: {}, plural: new Intl.PluralRules("en") };

function t(key, vars = {}) {
  let s = I18N.dict[key] ?? I18N.fallback[key] ?? key;
  if (s && typeof s === "object") {
    const cat = I18N.plural.select(Number(vars.n ?? 0));
    s = s[cat] ?? s.other ?? Object.values(s)[0];
  }
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// The language actually used: an explicit setting, else the best match from the browser (HA passes the user's locale).
function resolveLanguage(setting) {
  const supported = new Set(LANGUAGES.map(([code]) => code));
  if (setting && setting !== "auto" && supported.has(setting)) return setting;
  for (const tag of navigator.languages || [navigator.language || "en"]) {
    const code = String(tag).toLowerCase().split("-")[0];
    if (supported.has(code)) return code;
  }
  return "en";
}

async function loadLocale(lang) {
  const get = (code) => fetch(`locales/${code}.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const [dict, fallback] = await Promise.all([get(lang), lang === "en" ? Promise.resolve(null) : get("en")]);
  I18N.lang = lang;
  I18N.dict = dict;
  I18N.fallback = fallback || dict;
  I18N.plural = new Intl.PluralRules(lang);
  document.documentElement.lang = lang;
  translateStatic();
}

function translateStatic(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  root.querySelectorAll("[data-i18n-title]").forEach((el) => (el.title = t(el.dataset.i18nTitle)));
  root.querySelectorAll("[data-i18n-aria]").forEach((el) => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
}

// --- locale-aware formatting ---------------------------------------------------
const locale = () => I18N.lang;
const fmtNumber = (v, decimals = 0) =>
  new Intl.NumberFormat(locale(), { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(v);

function monthShort(monthIndex) {
  return new Intl.DateTimeFormat(locale(), { month: "short" }).format(new Date(2000, monthIndex, 1)).replace(".", "");
}

function fmtDate(d) {
  if (!d) return "";
  const [y, m, day] = String(d).slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", year: "numeric" }).format(new Date(y, m - 1, day));
}
