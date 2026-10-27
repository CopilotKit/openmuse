import assert from "node:assert/strict";
import test from "node:test";
import { formatDate } from "../src/i18n/format.ts";
import { catalogPlaceholderMismatches, resolveLocale } from "../src/i18n/locale.ts";

test("device language tags map onto the published locales", () => {
  assert.equal(resolveLocale("en-US"), "en");
  assert.equal(resolveLocale("en-GB"), "en");
  assert.equal(resolveLocale("zh-CN"), "zh-Hans");
  assert.equal(resolveLocale("zh-SG"), "zh-Hans");
  assert.equal(resolveLocale("zh-Hans"), "zh-Hans");
  assert.equal(resolveLocale("zh-TW"), "zh-Hant");
  assert.equal(resolveLocale("zh-HK"), "zh-Hant");
  assert.equal(resolveLocale("zh-Hant"), "zh-Hant");
  assert.equal(resolveLocale("ja-JP"), "ja");
  assert.equal(resolveLocale("ko-KR"), "ko");
  assert.equal(resolveLocale("es-MX"), "es");
  assert.equal(resolveLocale("pt-BR"), "pt-BR");
  assert.equal(resolveLocale("pt-PT"), "pt-BR");
  assert.equal(resolveLocale("fr-CA"), "fr");
  assert.equal(resolveLocale("de-AT"), "de");
  assert.equal(resolveLocale("ar"), "en");
  assert.equal(resolveLocale(null), "en");
  assert.equal(resolveLocale("zh_TW"), "zh-Hant");
});

test("every published locale has the same keys and interpolation placeholders as English", () => {
  assert.deepEqual(catalogPlaceholderMismatches(), []);
});

test("dates follow the requested locale instead of a fixed English format", () => {
  const iso = "2026-10-05T12:00:00Z";
  const options = { month: "short", day: "numeric" } as const;
  const english = formatDate(iso, "en", options);
  const chinese = formatDate(iso, "zh-Hans", options);
  assert.equal(english, new Date(iso).toLocaleDateString("en", options));
  assert.equal(chinese, new Date(iso).toLocaleDateString("zh-Hans", options));
  assert.notEqual(english, chinese);
});
