export interface Cidr {
  ip: Uint8Array;
  prefix: number;
}

export interface GeoIPEntry {
  code: string;
  cidrs: Cidr[];
  reverse: boolean;
}

export interface GeoSiteDomain {
  kind: string;
  value: string;
}

export interface GeoSiteEntry {
  code: string;
  domains: GeoSiteDomain[];
}

export interface ProtobufField {
  field: number;
  wire: number;
  value: number | Uint8Array;
}

export interface GeoFlag {
  present: boolean;
  enabled: boolean;
}

export interface GeoHook {
  enabled: boolean;
  lookupCountry(ip: string): string | null;
  lookupSite(host: string): string[];
  blockHosts(categories: readonly string[]): string[];
  bypassHosts(categories: readonly string[]): string[];
}

export const GEO_ROUTING_STORAGE_KEY: "infinitum.geoRouting";

export function protobufFields(buf: Uint8Array): ProtobufField[];
export function decodeGeoIPList(buf: Uint8Array): GeoIPEntry[];
export function decodeGeoSiteList(buf: Uint8Array): GeoSiteEntry[];
export function parseIP(input: string): Uint8Array | null;
export function cidrContains(cidr: Cidr, ip: Uint8Array): boolean;
export function countryForIP(entries: readonly GeoIPEntry[], ip: string | Uint8Array): string | null;
export function hostsInCategories(
  entries: readonly GeoSiteEntry[],
  categories: readonly string[],
  options?: { rejectOnion?: boolean },
): string[];
export function isOnionHost(host: string): boolean;
export function geoEnabledFromValue(value: unknown): boolean;
export function geoEnabledFromEnv(env?: { INFINITUM_GEO_ENABLED?: string }): boolean;
export function geoFlagFromArgv(argv?: readonly string[]): GeoFlag;
export function resolveGeoEnabled(options?: {
  env?: { INFINITUM_GEO_ENABLED?: string };
  argv?: readonly string[];
  stored?: boolean | null;
}): boolean;
export function createGeoHook(options?: {
  enabled?: boolean;
  geoip?: Uint8Array | null;
  geosite?: Uint8Array | null;
}): GeoHook;
