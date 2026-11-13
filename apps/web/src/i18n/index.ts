import { createSignal } from "solid-js";
import { en } from "./en";
import { fr } from "./fr";
import { ar } from "./ar";

/**
 * The message catalogue (phase 2). Screens ask for a key, never for English text, so one
 * vocabulary (Mission, Plan, Task, Result, Check; ADR glossary) lives in one place per language.
 * English is the source of truth: `fr.ts` and `ar.ts` must carry every key with the same
 * `{placeholders}` (tests/domain/i18n-catalog.test.ts). Arabic renders right to left through the
 * document direction alone; no string is patched with bidi marks.
 */
export type Locale = "en" | "fr" | "ar";
export type MessageKey = keyof typeof en;
/** What a translation file must provide: every English key, plus the plural categories its language adds. */
export type Catalog = Readonly<Record<MessageKey, string>> & Readonly<Record<string, string>>;
/** A plural family: `<base>_one` and `<base>_other` exist (Arabic and French add the categories they need). */
export type PluralBase = { [K in MessageKey]: K extends `${infer B}_other` ? B : never }[MessageKey];

export const LOCALES: readonly { id: Locale; label: string; dir: "ltr" | "rtl" }[] = [
  { id: "en", label: "English", dir: "ltr" },
  { id: "fr", label: "Français", dir: "ltr" },
  { id: "ar", label: "العربية", dir: "rtl" },
];

export const CATALOGS: Readonly<Record<Locale, Catalog>> = { en, fr, ar };
const STORAGE_KEY = "brain.locale";

function isLocale(value: string | null | undefined): value is Locale {
  return value === "en" || value === "fr" || value === "ar";
}

/** `?lang=` (remembered), else the saved choice, else the browser language, else English. */
export function detectLocale(search = typeof location === "undefined" ? "" : location.search, language = typeof navigator === "undefined" ? "en" : navigator.language): Locale {
  try {
    const forced = new URLSearchParams(search).get("lang");
    if (isLocale(forced)) { localStorage.setItem(STORAGE_KEY, forced); return forced; }
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch { /* storage blocked: fall through to the browser language */ }
  const prefix = language.slice(0, 2).toLowerCase();
  return isLocale(prefix) ? prefix : "en";
}

const [locale, setLocaleSignal] = createSignal<Locale>(detectLocale());
export { locale };

export function setLocale(next: Locale): void {
  setLocaleSignal(next);
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* per-browser convenience only */ }
  if (typeof document !== "undefined") document.documentElement.lang = next;
}

/** The Intl locale for dates and numbers: Latin digits for Arabic (Tunisia), day before month everywhere. */
export function intlLocale(current: Locale = locale()): string {
  return current === "fr" ? "fr-FR" : current === "ar" ? "ar-TN" : "en-GB";
}

function fill(template: string, params?: Readonly<Record<string, string | number>>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** One message in the current language; falls back to English, never to a bare key. */
export function t(key: MessageKey, params?: Readonly<Record<string, string | number>>): string {
  return fill(CATALOGS[locale()][key] ?? en[key], params);
}

/** A message looked up by a key built at run time (a status word, a service id); the fallback shows when the catalogue has no such key. */
export function tOr(key: string, fallback: string): string {
  return (CATALOGS[locale()] as Readonly<Record<string, string>>)[key] ?? (en as Readonly<Record<string, string>>)[key] ?? fallback;
}

/** A counted message: picks `<base>_<category>` by the language's own plural rules; `{n}` is the count. */
export function tn(base: PluralBase, count: number, params?: Readonly<Record<string, string | number>>): string {
  const current = locale();
  const category = new Intl.PluralRules(intlLocale(current)).select(count);
  const catalog = CATALOGS[current] as Readonly<Record<string, string>>;
  const template = catalog[`${base}_${category}`] ?? catalog[`${base}_other`] ?? (en as Readonly<Record<string, string>>)[`${base}_other`] ?? base;
  return fill(template, { n: count, ...params });
}

/** The reading direction a language implies. */
export function localeDirection(current: Locale = locale()): "ltr" | "rtl" {
  return LOCALES.find((entry) => entry.id === current)?.dir ?? "ltr";
}
