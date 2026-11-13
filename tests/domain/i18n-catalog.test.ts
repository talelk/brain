import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ar } from "../../apps/web/src/i18n/ar";
import { en } from "../../apps/web/src/i18n/en";
import { fr } from "../../apps/web/src/i18n/fr";

const SRC = join(import.meta.dirname, "../../apps/web/src");
const english = en as Record<string, string>;
const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]!).sort();
/** Arabic says "one task" and "two tasks" with the noun's own form, so those two forms may leave the number out. */
const withoutCount = (key: string, names: string[]): string[] => (/_(one|two)$/u.test(key) ? names.filter((name) => name !== "n") : names);
const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return name === "i18n" ? [] : sources(path);
  return /\.(ts|tsx)$/u.test(name) ? [path] : [];
});

describe("message catalogue (phase 2)", () => {
  for (const [name, catalog] of [["fr", fr], ["ar", ar]] as const) {
    it(`${name} carries every English key with the same placeholders`, () => {
      const translated = catalog as Record<string, string>;
      const missing = Object.keys(english).filter((key) => typeof translated[key] !== "string" || translated[key]!.trim() === "");
      expect(missing).toEqual([]);
      const different = Object.keys(english).filter((key) => translated[key] !== undefined
        && (name === "ar" ? withoutCount(key, placeholders(translated[key]!)).join() !== withoutCount(key, placeholders(english[key]!)).join() : placeholders(translated[key]!).join() !== placeholders(english[key]!).join()));
      expect(different).toEqual([]);
    });
    it(`${name} defines no key English does not know, except plural categories`, () => {
      const extra = Object.keys(catalog).filter((key) => !(key in english) && !/_(zero|two|few|many)$/u.test(key));
      expect(extra).toEqual([]);
    });
  }

  it("Arabic plural categories only extend families English has, with the same placeholders", () => {
    for (const key of Object.keys(ar).filter((entry) => /_(zero|two|few|many)$/u.test(entry))) {
      const base = key.replace(/_(zero|two|few|many)$/u, "");
      expect(`${base}_other` in english, key).toBe(true);
      expect(withoutCount(key, placeholders((ar as Record<string, string>)[key]!)).join(), key).toBe(withoutCount(key, placeholders(english[`${base}_other`]!)).join());
    }
  });

  it("Arabic is right to left through the document direction alone: no bidi control characters anywhere in a catalogue", () => {
    const bidi = new RegExp("[\\u200e\\u200f\\u061c\\u202a-\\u202e\\u2066-\\u2069]", "u");
    for (const language of ["en", "fr", "ar"]) {
      expect(bidi.test(readFileSync(join(SRC, "i18n", `${language}.ts`), "utf8")), language).toBe(false);
    }
  });

  it("every key a screen asks for exists", () => {
    const unknown: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/\bt\(\s*"([a-zA-Z0-9_.-]+)"/gu)) if (!(match[1]! in english)) unknown.push(`${file.replace(SRC, "")}: ${match[1]}`);
      for (const match of text.matchAll(/\btn\(\s*"([a-zA-Z0-9_.-]+)"/gu)) if (!(`${match[1]!}_other` in english)) unknown.push(`${file.replace(SRC, "")}: ${match[1]} (plural)`);
    }
    expect(unknown).toEqual([]);
  });

  it("every message the first screen asks for is in the core catalogue (the rest loads with the other screens)", () => {
    const importRe = /\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']/gu;
    const dynamicRe = /import\(\s*["']([^"']+)["']\s*\)/gu;
    const resolve = (from: string, spec: string): string | undefined => {
      if (!spec.startsWith(".")) return undefined;
      const base = join(dirname(from), spec);
      return [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")].find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
    };
    const reach = (entry: string, dynamic: boolean): Set<string> => {
      const seen = new Set<string>();
      const stack = [entry];
      while (stack.length > 0) {
        const file = stack.pop()!;
        if (seen.has(file)) continue;
        seen.add(file);
        const text = readFileSync(file, "utf8");
        const specs = [...text.matchAll(importRe)].map((match) => match[1] ?? match[2]!);
        if (dynamic) specs.push(...[...text.matchAll(dynamicRe)].map((match) => match[1]!));
        for (const spec of specs) { const target = resolve(file, spec); if (target && /\.tsx?$/u.test(target) && !target.includes(`${join(SRC, "i18n")}`)) stack.push(target); }
      }
      return seen;
    };
    // The first screen is the main bundle plus Today (and what Today pulls in later): the same rule scripts/i18n-add.py's note names.
    const files = new Set([...reach(join(SRC, "main.tsx"), false), ...reach(join(SRC, "routes/pages/TodayPage.tsx"), true)]);
    const coreText = readFileSync(join(SRC, "i18n/en-core.ts"), "utf8");
    const core = new Set([...coreText.matchAll(/^ {2}"([^"]+)":/gmu)].map((match) => match[1]!));
    const missing: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/"([a-z][\w.-]*\.[\w.-]+)"/gu)) {
        for (const candidate of [match[1]!, `${match[1]!}_other`]) if (candidate in english && !core.has(candidate)) missing.push(`${file.replace(SRC, "")}: ${candidate}`);
      }
      for (const match of text.matchAll(/`([a-z][\w.-]*\.)\$\{/gu)) {
        for (const key of Object.keys(english)) if (key.startsWith(match[1]!) && !core.has(key)) missing.push(`${file.replace(SRC, "")}: ${key} (computed)`);
      }
    }
    expect([...new Set(missing)], "move these keys from en-extra.ts to en-core.ts").toEqual([]);
  });

  it("plural families have both one and other", () => {
    const bases = new Set(Object.keys(english).filter((key) => key.endsWith("_other")).map((key) => key.slice(0, -"_other".length)));
    const lonely = [...bases].filter((base) => !(`${base}_one` in english));
    expect(lonely).toEqual([]);
  });
});
