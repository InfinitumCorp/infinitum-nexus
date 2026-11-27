// © Infinitum Corporation®. All rights reserved.
/**
 * Typed client for the Cumulus privacy gateway's product APIs, as declared in
 * infra/data-platform/conjure/platform.yml: collection, catalog, event search, erasure,
 * data-quality runs, differentially private releases (and their budget) and Superset guest tokens.
 *
 * - Authenticates with the product's token (PLATFORM_PRODUCT_TOKENS on the gateway).
 * - Turns Conjure errors into {@link PlatformApiError}, keeping `errorName`, `errorCode` and
 *   the safe parameters.
 * - Retries 429 (daily quota) and 503 (storage guard, not configured yet) honouring
 *   Retry-After, and network failures with backoff. Ingest is safe to retry because every
 *   event carries its own eventId.
 *
 * Runs server-side only: it holds the product token.
 */

export type Region = "EU" | "US" | "RU";
export type Consent = "ESSENTIAL" | "ANALYTICS" | "AI_IMPROVEMENT" | "EXCHANGE";
export type Classification = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "PERSONAL" | "SPECIAL_CATEGORY";
export type FieldRuleName = "KEEP" | "TEXT" | "PSEUDONYMIZE" | "DROP";

export interface EventEnvelope {
  eventId: string;
  product: string;
  tenant: string;
  cid?: string;
  eventType: string;
  schemaVersion: number;
  occurredAt: string;
  region: Region;
  consent: Consent[];
  objectType?: string;
  objectId?: string;
  payload: Record<string, unknown>;
}

export interface IngestResponse {
  accepted: number;
  duplicates: number;
  rejected: { eventId: string; reason: string }[];
}

export interface FieldSpec {
  name: string;
  type: string;
  classification: Classification;
  rule: FieldRuleName;
  description?: string;
}

export interface DatasetSpec {
  name: string;
  product: string;
  owners: string[];
  description: string;
  fields: FieldSpec[];
  upstream: string[];
  retentionDays: number;
  region: Region;
  glossaryTerms: string[];
}

export interface DatasetRef {
  name: string;
  urn: string;
}

export interface SearchQuery {
  tenant: string;
  product?: string;
  eventType?: string;
  objectType?: string;
  objectId?: string;
  from: string;
  to: string;
  text?: string;
  pageSize?: number;
  pageToken?: string;
}

export interface SearchHit {
  eventId: string;
  product: string;
  eventType: string;
  occurredAt: string;
  objectType?: string | null;
  objectId?: string | null;
  payload: Record<string, unknown>;
}

export interface SearchResponse {
  hits: SearchHit[];
  nextPageToken?: string | null;
}

export interface StoredReleaseRequest {
  from: string;
  to: string;
  metric: "COUNT" | "SUM";
  groupBy: string;
  publicGroups: string[];
  valueField?: string;
  lower?: number;
  upper?: number;
  epsilon: number;
  maxPartitions?: number;
  suppressBelow?: number;
}

export interface StoredReleaseResponse {
  dataset: string;
  metric: "COUNT" | "SUM";
  from: string;
  to: string;
  epsilon: number;
  groups: Record<string, number>;
  suppressed: string[];
  remainingEpsilon: number;
}

export interface DatasetCheckResult {
  kind: string;
  target: string;
  ok: boolean;
  metric: number;
  message: string;
}

export interface QualityRun {
  dataset: string;
  checkedAt: string;
  rows: number;
  ok: boolean;
  metrics: Record<string, number>;
  results: DatasetCheckResult[];
}

export interface PrivacyBudgetStatus {
  dataset: string;
  totalEpsilon: number;
  spentEpsilon: number;
  remainingEpsilon: number;
  maxEpsilonPerRelease: number;
}

export interface GuestTokenResponse {
  token: string;
  expiresAt: string;
}

/** A Conjure SerializableError from the gateway. */
export class PlatformApiError extends Error {
  readonly status: number;
  readonly errorCode: string;
  /** "DataPlatform:DatasetNotFound" and so on. */
  readonly errorName: string;
  readonly parameters: Record<string, unknown>;
  /** Seconds, from Retry-After, on 429 and 503. */
  readonly retryAfter: number | null;

  constructor(status: number, errorCode: string, errorName: string, parameters: Record<string, unknown>,
    retryAfter: number | null) {
    super(`${errorName} (${status}): ${String(parameters.message ?? errorCode)}`);
    this.name = "PlatformApiError";
    this.status = status;
    this.errorCode = errorCode;
    this.errorName = errorName;
    this.parameters = parameters;
    this.retryAfter = retryAfter;
  }

  /** The error name without the namespace, e.g. "DatasetNotFound". */
  get shortName(): string {
    return this.errorName.includes(":") ? this.errorName.split(":")[1] : this.errorName;
  }
}

export interface FetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<FetchResponse>;

export interface PlatformClientOptions {
  /** e.g. https://data-api.example.com */
  baseUrl: string;
  productToken: string;
  /** Retries after the first attempt, for 429, 503 and network failures. Default 3. */
  maxRetries?: number;
  /** Backoff for network failures, doubled each time. Default 500 ms. */
  baseDelayMs?: number;
  /** Longest Retry-After the client will wait for in-process; longer ones are thrown. Default 60 s. */
  maxRetryAfterSeconds?: number;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_STATUSES = new Set([429, 503]);

function enc(segment: string): string {
  if (!segment) throw new Error("path segment must not be empty");
  return encodeURIComponent(segment);
}

export class PlatformClient {
  private readonly base: string;
  private readonly o: Required<Omit<PlatformClientOptions, "baseUrl" | "fetch" | "sleep">> & {
    fetch: Fetch;
    sleep: (ms: number) => Promise<void>;
  };

  constructor(options: PlatformClientOptions) {
    const base = options.baseUrl.replace(/\/+$/, "");
    if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) {
      throw new Error("baseUrl must use https");
    }
    if (!options.productToken || options.productToken.length < 32) {
      throw new Error("productToken must be the product's gateway token (32+ characters)");
    }
    this.base = base;
    this.o = {
      productToken: options.productToken,
      maxRetries: options.maxRetries ?? 3,
      baseDelayMs: options.baseDelayMs ?? 500,
      maxRetryAfterSeconds: options.maxRetryAfterSeconds ?? 60,
      fetch: options.fetch ?? ((url, init) => fetch(url, init)),
      sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init = {
      method,
      headers: {
        Authorization: `Bearer ${this.o.productToken}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    for (let attempt = 0; ; attempt++) {
      let res: FetchResponse;
      try {
        res = await this.o.fetch(this.base + path, init);
      } catch (e) {
        if (attempt >= this.o.maxRetries) throw e;
        await this.o.sleep(this.o.baseDelayMs * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      if (res.status >= 200 && res.status < 300) return (text ? JSON.parse(text) : null) as T;

      const retryAfterRaw = res.headers.get("Retry-After");
      const retryAfter = retryAfterRaw !== null && /^\d+$/.test(retryAfterRaw) ? Number(retryAfterRaw) : null;
      let err: Record<string, unknown> = {};
      try {
        err = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // not a Conjure error body (a proxy, say); keep the status
      }
      const error = new PlatformApiError(
        res.status,
        String(err.errorCode ?? "INTERNAL"),
        String(err.errorName ?? `HTTP:${res.status}`),
        (err.parameters as Record<string, unknown>) ?? {},
        retryAfter,
      );
      const wait = retryAfter ?? Math.ceil((this.o.baseDelayMs * 2 ** attempt) / 1000);
      if (!RETRY_STATUSES.has(res.status) || attempt >= this.o.maxRetries || wait > this.o.maxRetryAfterSeconds) {
        throw error;
      }
      await this.o.sleep(retryAfter !== null ? retryAfter * 1000 : this.o.baseDelayMs * 2 ** attempt);
    }
  }

  /** CollectionService.ingest. Give every event its own eventId so retries are idempotent. */
  ingest(events: EventEnvelope[]): Promise<IngestResponse> {
    return this.call("POST", "/api/v1/collect/events", { events });
  }

  /** CatalogService.registerDataset */
  registerDataset(spec: DatasetSpec): Promise<DatasetRef> {
    return this.call("PUT", `/api/v1/catalog/datasets/${enc(spec.name)}`, spec);
  }

  /** CatalogService.getDataset */
  getDataset(name: string): Promise<DatasetSpec> {
    return this.call("GET", `/api/v1/catalog/datasets/${enc(name)}`);
  }

  /** SearchService.search */
  searchEvents(query: SearchQuery): Promise<SearchResponse> {
    return this.call("POST", "/api/v1/search/events", query);
  }

  /** Every page of a search, following nextPageToken. Stops after `maxPages`. */
  async *searchAllEvents(query: SearchQuery, maxPages = 100): AsyncGenerator<SearchHit> {
    let pageToken: string | undefined = query.pageToken;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.searchEvents({ ...query, ...(pageToken ? { pageToken } : {}) });
      yield* res.hits;
      if (!res.nextPageToken) return;
      pageToken = res.nextPageToken;
    }
  }

  /** ErasureService.eraseSubject: this product's events about one person, in every tenant. */
  eraseSubject(cid: string): Promise<{ deleted: number }> {
    return this.call("POST", "/api/v1/erasure/subjects", { cid });
  }

  /** QualityService.getRuns: the 30 newest quality runs for one of this product's datasets. */
  async getQualityRuns(name: string): Promise<QualityRun[]> {
    const res: { runs: QualityRun[] } = await this.call("GET", `/api/v1/quality/datasets/${enc(name)}/runs`);
    return res.runs;
  }

  /** ReleaseService.getBudget: epsilon left for a dataset. Reading it spends nothing. */
  getReleaseBudget(name: string): Promise<PrivacyBudgetStatus> {
    return this.call("GET", `/api/v1/releases/datasets/${enc(name)}/budget`);
  }

  /** ReleaseService.releaseDataset: a DP count or sum over this product's stored events. */
  releaseDataset(name: string, request: StoredReleaseRequest): Promise<StoredReleaseResponse> {
    return this.call("POST", `/api/v1/releases/datasets/${enc(name)}`, request);
  }

  /** EmbedService.createGuestToken: for the Superset embedded SDK's fetchGuestToken. */
  createGuestToken(dashboardId: string, tenant: string, cid: string): Promise<GuestTokenResponse> {
    return this.call("POST", `/api/v1/embed/dashboards/${enc(dashboardId)}/guest-token`, { tenant, cid });
  }
}
