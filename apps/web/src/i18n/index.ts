import { createSignal } from "solid-js";
import { en } from "./en";

/**
 * The message catalogue. Screens ask for a key, never for text, so the vocabulary of GLOSSARY.md lives in one file per language.
 * English is the source and the fallback; French and Arabic are separate chunks, fetched only when chosen.
 */
export type Locale = "en" | "fr" | "ar";
export type MessageKey = keyof typeof en;
export type Catalog = Readonly<Record<MessageKey, string>> & Readonly<Record<string, string>>;
/** A counted message: `<base>_one` and `<base>_other` exist (French and Arabic add the forms they need). */
export type PluralBase = { [K in MessageKey]: K extends `${infer B}_other` ? B : never }[MessageKey];
type Params = Readonly<Record<string, string | number>>;

export const LOCALES: readonly { id: Locale; label: string; dir: "ltr" | "rtl" }[] = [
  { id: "en", label: "English", dir: "ltr" },
  { id: "fr", label: "Français", dir: "ltr" },
  { id: "ar", label: "العربية", dir: "rtl" },
];

const STORAGE_KEY = "brain.locale";
const isLocale = (value: string | null | undefined): value is Locale => value === "en" || value === "fr" || value === "ar";
const english = en as Readonly<Record<string, string>>;
const loaded: Partial<Record<Locale, Readonly<Record<string, string>>>> = { en: english };
const [ready, setReady] = createSignal(0);

/** `?lang=` (remembered), else the saved choice, else the browser's language, else English. */
function detect(): Locale {
  try {
    const forced = new URLSearchParams(location.search).get("lang");
    if (isLocale(forced)) { localStorage.setItem(STORAGE_KEY, forced); return forced; }
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch { /* storage blocked: use the browser's language */ }
  const prefix = navigator.language.slice(0, 2).toLowerCase();
  return isLocale(prefix) ? prefix : "en";
}

const [locale, setLocaleSignal] = createSignal<Locale>(detect());
export { locale };
export const direction = (): "ltr" | "rtl" => (locale() === "ar" ? "rtl" : "ltr");

export async function loadLocale(next: Locale): Promise<void> {
  if (!loaded[next]) {
    loaded[next] = next === "fr" ? (await import("./fr")).fr : (await import("./ar")).ar;
    setReady((count) => count + 1);
  }
}

export function setLocale(next: Locale): void {
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* a per-browser convenience only */ }
  void loadLocale(next).then(() => {
    setLocaleSignal(next);
    document.documentElement.lang = next;
    document.documentElement.dir = direction();
  });
}

const catalog = (): Readonly<Record<string, string>> => { ready(); return loaded[locale()] ?? english; };
const fill = (template: string, params?: Params): string => (params ? template.replace(/\{(\w+)\}/gu, (whole, name: string) => (name in params ? String(params[name]) : whole)) : template);

/** One message in the current language; English when the language lacks it. */
export function t(key: MessageKey, params?: Params): string {
  return fill(catalog()[key] ?? english[key] ?? key, params);
}

/** A message whose key is built at run time (a state, an error code); `fallback` when no language has it. */
export function tKey(key: string, fallback: string, params?: Params): string {
  return fill(catalog()[key] ?? english[key] ?? fallback, params);
}

/** A counted message, by the language's own plural rules; `{n}` is the count. */
export function tn(base: PluralBase, count: number, params?: Params): string {
  const category = new Intl.PluralRules(locale()).select(count);
  const messages = catalog();
  return fill(messages[`${base}_${category}`] ?? messages[`${base}_other`] ?? english[`${base}_other`] ?? base, { n: count, ...params });
}

/** The Intl locale for dates and numbers: Latin digits everywhere, day before month. */
export const intlLocale = (): string => (locale() === "fr" ? "fr-FR" : locale() === "ar" ? "ar-TN" : "en-GB");
