export interface StoredGeo {
  enabled: boolean;
  countries: string[];
}

export function readStoredGeo(path: string): StoredGeo | null;
export function writeStoredGeo(path: string, enabled: boolean, countries?: readonly string[]): void;
export function applyGeoCli(options?: {
  path?: string;
  env?: { INFINITUM_GEO_ENABLED?: string };
  argv?: readonly string[];
}): { enabled: boolean; countries: string[] };
