import de from "./locales/de.json";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";
import ptBR from "./locales/pt-BR.json";
import zhHans from "./locales/zh-Hans.json";
import zhHant from "./locales/zh-Hant.json";

export const locales = ["en", "zh-Hans", "zh-Hant", "ja", "ko", "es", "pt-BR", "fr", "de"] as const;
export type Locale = (typeof locales)[number];

const catalogs: Record<Locale, Catalog> = {
  en,
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
  ja,
  ko,
  es,
  "pt-BR": ptBR,
  fr,
  de,
};

type Catalog = Record<string, unknown>;

const primary: Record<string, Locale> = {
  en: "en",
  zh: "zh-Hans",
  ja: "ja",
  ko: "ko",
  es: "es",
  pt: "pt-BR",
  fr: "fr",
  de: "de",
};

/** Map a BCP 47 tag onto a published locale. Unknown languages fall back to English. */
export function resolveLocale(languageTag: string | null | undefined): Locale {
  if (!languageTag) return "en";
  const tag = languageTag.replace(/_/g, "-");
  const lower = tag.toLowerCase();
  const exact = locales.find((locale) => locale.toLowerCase() === lower);
  if (exact) return exact;
  if (lower.startsWith("zh-hant") || lower === "zh-tw" || lower === "zh-hk" || lower === "zh-mo")
    return "zh-Hant";
  if (lower.startsWith("zh")) return "zh-Hans";
  return primary[lower.split("-")[0] ?? ""] ?? "en";
}

export function translate(
  locale: string,
  key: string,
  vars: Record<string, string | number> = {},
): string {
  const resolved = resolveLocale(locale);
  const value = lookup(catalogs[resolved], key) ?? lookup(catalogs.en, key) ?? key;
  return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
    vars[name] === undefined ? "" : String(vars[name]),
  );
}

export function catalogPlaceholderMismatches(): string[] {
  const english = flatten(catalogs.en);
  const issues: string[] = [];
  for (const locale of locales) {
    if (locale === "en") continue;
    const translated = flatten(catalogs[locale]);
    const keys = [...new Set([...Object.keys(english), ...Object.keys(translated)])].sort();
    for (const key of keys) {
      if (!(key in english)) issues.push(`${locale} extra key ${key}`);
      else if (!(key in translated)) issues.push(`${locale} missing key ${key}`);
      else if (placeholders(english[key] ?? "") !== placeholders(translated[key] ?? ""))
        issues.push(
          `${locale} ${key} placeholders ${placeholders(translated[key] ?? "")} !== ${placeholders(english[key] ?? "")}`,
        );
    }
  }
  return issues;
}

export const resources = Object.fromEntries(
  locales.map((locale) => [locale, { translation: catalogs[locale] }]),
) as Record<Locale, { translation: typeof en }>;

function lookup(catalog: Catalog, key: string): string | undefined {
  let current: unknown = catalog;
  for (const part of key.split(".")) {
    if (!current || typeof current !== "object" || !(part in current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

function flatten(catalog: Catalog, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") result[path] = value;
    else if (value && typeof value === "object" && !Array.isArray(value))
      Object.assign(result, flatten(value as Catalog, path));
  }
  return result;
}

function placeholders(value: string): string {
  return [...value.matchAll(/\{\{(\w+)\}\}/g)]
    .map((match) => match[1])
    .sort()
    .join(",");
}
