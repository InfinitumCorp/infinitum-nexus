export interface LocaleInfo { code: string; name: string; dir: "ltr" | "rtl" }
export type Catalog = Record<string, string>;
export type Catalogs = Record<string, Catalog>;
export type Vars = Record<string, string | number>;

export declare const LOCALES: LocaleInfo[];
export declare const DEFAULT_STORAGE_KEY: string;
export declare function baseLanguage(tag: string | null | undefined): string;
export declare function directionOf(code: string): "ltr" | "rtl";
export declare function detectLocale(options?: {
  supported?: string[]; fallback?: string; storageKey?: string; languages?: readonly string[];
}): string;
export declare function format(template: string, vars?: Vars): string;

export interface I18n {
  readonly locale: string;
  readonly dir: "ltr" | "rtl";
  readonly supported: string[];
  readonly locales: LocaleInfo[];
  t(key: string, vars?: Vars): string;
  /** Translation of an exact English UI string (or a {0}-pattern match) in the current language, or null. */
  lookup(text: string): string | null;
  dom?: { stop(): void; refresh(): void };
  has(key: string): boolean;
  setLocale(code: string | null): void;
  subscribe(fn: (locale: string) => void): () => void;
  apply(root: ParentNode | Document): void;
}
export declare function createI18n(options: {
  catalogs: Catalogs; fallback?: string; storageKey?: string; supported?: string[];
  locale?: string; autoApply?: boolean;
}): I18n;
export declare function languageSwitcher(i18n: I18n, options?: {
  className?: string; label?: string; document?: Document;
}): HTMLSelectElement;
export declare function translateDom(i18n: I18n, root?: ParentNode): { stop(): void; refresh(): void };
export declare function startI18n(options: {
  catalogs: Catalogs; fallback?: string; storageKey?: string; supported?: string[];
  locale?: string; root?: ParentNode; switcher?: string | Element | null;
}): I18n;
