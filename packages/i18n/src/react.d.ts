import type { I18n, LocaleInfo, Vars } from "./i18n.js";
export declare function useI18n(i18n: I18n): {
  t: (key: string, vars?: Vars) => string;
  locale: string;
  dir: "ltr" | "rtl";
  setLocale: (code: string | null) => void;
  locales: LocaleInfo[];
};
