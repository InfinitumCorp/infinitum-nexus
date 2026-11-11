// React binding for @infinitum/i18n: re-render when the language changes.
import { useSyncExternalStore } from "react";

/** const { t, locale } = useI18n(i18n); */
export function useI18n(i18n) {
  const locale = useSyncExternalStore(
    (onChange) => i18n.subscribe(onChange),
    () => i18n.locale,
    () => i18n.locale,
  );
  return { t: i18n.t, locale, dir: i18n.dir, setLocale: i18n.setLocale, locales: i18n.locales };
}
