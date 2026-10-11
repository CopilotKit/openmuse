import AsyncStorage from "@react-native-async-storage/async-storage";
import { getLocales } from "expo-localization";
import i18n from "i18next";
import { useEffect } from "react";
import { initReactI18next, useTranslation } from "react-i18next";
import { Platform } from "react-native";
import { glossary } from "./glossary.ts";
import { type Locale, locales, resolveLocale, resources } from "./locale.ts";
import type en from "./locales/en.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof en };
    returnNull: false;
  }
}

export const LANGUAGE_KEY = "openmuse.language";

/** Language names stay in their own script, whichever interface language is active. */
export const languageNames: Record<Locale, string> = {
  en: "English",
  "zh-Hans": "中文",
  "zh-Hant": "繁體中文",
  ja: "日本語",
  ko: "한국어",
  es: "Español",
  "pt-BR": "Português (Brasil)",
  fr: "Français",
  de: "Deutsch",
};

const deviceLocale = resolveLocale(getLocales()[0]?.languageTag);

void i18n.use(initReactI18next).init({
  resources,
  lng: deviceLocale,
  fallbackLng: "en",
  supportedLngs: [...locales],
  interpolation: { escapeValue: false },
  returnNull: false,
  react: { useSuspense: false },
});

export function applyDocumentLanguage(locale: string) {
  if (Platform.OS === "web" && typeof document !== "undefined")
    document.documentElement.lang = locale;
}

export async function setLocale(locale: Locale) {
  await AsyncStorage.setItem(LANGUAGE_KEY, locale);
  await i18n.changeLanguage(locale);
}

/** Restore a saved choice after startup, and keep the web document language in sync. */
export function useLocaleSync() {
  const { i18n: instance } = useTranslation();
  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(LANGUAGE_KEY)
      .then((saved) => {
        if (active && saved) return instance.changeLanguage(resolveLocale(saved));
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [instance]);
  useEffect(() => {
    applyDocumentLanguage(instance.language);
    const apply = (locale: string) => applyDocumentLanguage(locale);
    instance.on("languageChanged", apply);
    return () => {
      instance.off("languageChanged", apply);
    };
  }, [instance]);
}

export { names } from "./glossary.ts";
export type { Locale };
export { glossary, i18n, locales, resolveLocale };
