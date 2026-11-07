import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { CidLabyrinth } from "@infinitum/lbrnth";
import { createJob, advanceJob, productPreset } from "@infinitum/conjure";
import type {
  EngineClient,
  ForecastJob,
  EvidenceKind,
} from "@infinitum/conjure";
import { collectEvidence, checkpoint } from "./evidence.ts";
import type { Evidence, ProductClient } from "./evidence.ts";
import { object, exact, id, hash, count, fail } from "./schema.ts";
interface Payload {
  v: 1;
  product: string;
  repo: string;
  id: string;
  source: unknown;
  evidence: Evidence;
  presetId: string;
  job: ForecastJob;
  phase: "idle" | "inflight";
  operationId?: string;
  advances: number;
  createdAt: string;
  expiresAt: string;
  aggregateProcessingConsent: true;
}
export interface ConjureServiceOptions {
  engine: EngineClient;
  integrityKey: Uint8Array;
  clock?: () => Date;
  stepTimeoutMs?: number;
  entitled?: (orgId: string, product: "CONJURE") => boolean;
}
/** Existing CONJURE model only. Private aggregate evidence, no custom prompts or new predictor. */
export class ConjureService {
  readonly #auth: CidLabyrinth;
  readonly #engine: EngineClient;
  readonly #key: Buffer;
  readonly #clock: () => Date;
  readonly #timeout: number;
  readonly #entitled: (orgId: string, product: "CONJURE") => boolean;
  #active = 0;
  constructor(auth: CidLabyrinth, options: ConjureServiceOptions) {
    if (
      !(options.integrityKey instanceof Uint8Array) ||
      options.integrityKey.length !== 32
    )
      throw new Error("Operator state-integrity key required");
    this.#auth = auth;
    this.#entitled = options.entitled ?? (() => false);
    this.#engine = options.engine;
    this.#key = Buffer.from(options.integrityKey);
    this.#clock = options.clock ?? (() => new Date());
    this.#timeout = options.stepTimeoutMs ?? 30000;
    if (
      !Number.isInteger(this.#timeout) ||
      this.#timeout < 10 ||
      this.#timeout > 240000
    )
      throw new Error("Invalid engine deadline");
  }
  #context(token: string, product: string, repo: unknown) {
    productPreset(product, "storage");
    const client = this.#auth.forProduct(token, product);
    client.repositories();
    const decision: unknown = this.#entitled(
      this.#auth.verifiedOrganization(token),
      "CONJURE",
    );
    if (decision instanceof Promise) void decision.catch(() => {});
    if (decision !== true)
      fail("forbidden", "Independent CONJURE plan required");
    return { client, repo: id(repo) };
  }
  #head(client: ProductClient, repo: string, expected: unknown) {
    const head = expected === null ? null : hash(expected),
      latest = client.history(repo, "main", 1)[0];
    if ((latest?.id ?? null) !== head) fail("conflict", "Head changed");
    return latest;
  }
  #signature(payload: Payload) {
    return createHmac("sha256", this.#key)
      .update(JSON.stringify(payload))
      .digest("hex");
  }
  #write(client: ProductClient, payload: Payload, head: string | null) {
    return client.save(
      payload.repo,
      `conjure/jobs/${payload.id}.json`,
      JSON.stringify({ payload, signature: this.#signature(payload) }),
      head,
      "Persist private CONJURE workflow",
    );
  }
  #read(
    client: ProductClient,
    repo: string,
    product: string,
    identifier: string,
  ) {
    const commit = client.history(repo, "main", 1)[0];
    if (!commit) fail("not_found", "Scenario not found");
    const raw = client.load(repo, commit.id, `conjure/jobs/${identifier}.json`);
    if (raw.length > 262144) fail("integrity", "Invalid scenario state");
    let row: Record<string, unknown>;
    try {
      row = object(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
      );
    } catch {
      return fail("integrity", "Invalid scenario state");
    }
    const payload = object(row.payload) as unknown as Payload;
    if (
      typeof row.signature !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.signature) ||
      !timingSafeEqual(
        Buffer.from(row.signature, "hex"),
        Buffer.from(this.#signature(payload), "hex"),
      ) ||
      payload.v !== 1 ||
      payload.product !== product ||
      payload.repo !== repo ||
      payload.id !== identifier ||
      payload.aggregateProcessingConsent !== true
    )
      fail("integrity", "Scenario state signature/context mismatch");
    return { payload, commit };
  }
  #view(payload: Payload, commit: { id: string; parent: string | null }) {
    return {
      id: payload.id,
      model: "CONJURE" as const,
      engine: "mirofish-http" as const,
      calibrated: false as const,
      simulationOnly: true as const,
      requiresOperatorReview: true as const,
      dataSaleAllowed: false as const,
      commit: { id: commit.id, parent: commit.parent },
      source: payload.source,
      evidence: payload.evidence,
      presetId: payload.presetId,
      phase: payload.phase,
      expiresAt: payload.expiresAt,
      status: payload.job.status,
      step: payload.job.step,
      progress: payload.job.progress,
      message: payload.job.message,
      report: payload.job.report,
      error: payload.job.error,
      reportIsUntrusted: true as const,
    };
  }
  create(token: string, product: string, input: unknown) {
    const body = object(input);
    exact(body, ["repo", "id", "expectedHead", "source", "consent", "rounds"]);
    if (body.consent !== true)
      fail("forbidden", "Explicit aggregate inference consent required");
    const { client, repo } = this.#context(token, product, body.repo),
      identifier = id(body.id),
      latest = this.#head(client, repo, body.expectedHead),
      prefix = `products/${product}/conjure/jobs/`,
      paths = latest
        ? Object.keys(latest.tree).filter((p) => p.startsWith(prefix))
        : [];
    if (paths.includes(`${prefix}${identifier}.json`))
      fail("conflict", "Scenario ID exists");
    if (paths.length >= 16) fail("capacity", "Scenario capacity reached");
    const now = this.#clock(),
      { source, evidence } = collectEvidence(
        client,
        repo,
        product,
        body.source,
        now,
      ),
      preset = productPreset(product, evidence.kind),
      rounds = body.rounds === undefined ? 5 : count(body.rounds, 20);
    if (rounds < 5) fail("invalid", "Scenario rounds must be 5–20");
    const seed =
      "Infinitum Corporation® private, numeric aggregate evidence. Analyze baseline and stated increased-load/mitigation assumptions; do not invent calibration or operational recommendations. Do not profile real people or build targets. Measurements may be partial/client-asserted.\n" +
      JSON.stringify({
        kind: evidence.kind,
        sampleCount: evidence.sampleCount,
        metrics: evidence.metrics,
      });
    const result = createJob({
      product,
      title: `${product}: ${evidence.kind} scenario`,
      question: preset.question,
      seed,
      rounds,
      platform: "parallel",
    });
    if (!result.job) fail("invalid", "Invalid scenario input");
    const payload: Payload = {
      v: 1,
      product,
      repo,
      id: identifier,
      source,
      evidence,
      presetId: preset.id,
      job: result.job,
      phase: "idle",
      advances: 0,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 86400000).toISOString(),
      aggregateProcessingConsent: true,
    };
    return this.#view(
      payload,
      this.#write(client, payload, latest?.id ?? null),
    );
  }
  load(token: string, product: string, repo: string, identifier: string) {
    const { client } = this.#context(token, product, repo),
      state = this.#read(client, repo, product, id(identifier));
    return this.#view(state.payload, state.commit);
  }
  record(token: string, product: string, input: unknown) {
    const body = object(input);
    exact(body, ["repo", "id", "expectedHead", "kind", "metrics"]);
    if (body.kind !== "cyber" && body.kind !== "exercise")
      fail("invalid", "Numeric checkpoint kind required");
    productPreset(product, body.kind);
    const metrics = checkpoint(body.kind, body.metrics),
      { client, repo } = this.#context(token, product, body.repo),
      latest = this.#head(client, repo, body.expectedHead),
      identifier = id(body.id),
      commit = client.save(
        repo,
        `signals/${body.kind}/${identifier}.json`,
        JSON.stringify({
          schema: 1,
          product,
          kind: body.kind,
          metrics,
          recordedAt: this.#clock().toISOString(),
        }),
        latest?.id ?? null,
        "Record aggregate CONJURE evidence checkpoint",
      );
    return { id: commit.id, parent: commit.parent };
  }
  async advance(token: string, product: string, input: unknown, stop = false) {
    const body = object(input);
    exact(body, ["repo", "id", "expectedHead"]);
    const { client, repo } = this.#context(token, product, body.repo),
      identifier = id(body.id);
    this.#head(client, repo, body.expectedHead);
    const { payload, commit } = this.#read(client, repo, product, identifier);
    if (payload.phase !== "idle")
      fail(
        "conflict",
        "Step already claimed; operator reconciliation required",
      );
    if (payload.job.status !== "running") return this.#view(payload, commit);
    if (
      Date.parse(payload.expiresAt) <= this.#clock().getTime() ||
      payload.advances >= 128
    )
      fail("capacity", "Scenario lifetime or call budget exhausted");
    if (this.#active >= 4)
      fail("capacity", "Engine concurrency capacity reached");
    payload.phase = "inflight";
    payload.operationId = randomUUID();
    payload.advances++;
    const claim = this.#write(client, payload, commit.id);
    this.#active++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = stop
        ? (async () => {
            if (payload.job.ids.simulation_id)
              await this.#engine.stop(payload.job.ids.simulation_id);
            return {
              ...payload.job,
              status: "stopped" as const,
              message: "Stopped",
            };
          })()
        : advanceJob(payload.job, this.#engine);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Engine deadline exceeded")),
          this.#timeout,
        );
      });
      const job = await Promise.race([work, timeout]);
      // Retained product handles reauthenticate here: revoke/consent/plan changes deny results after await.
      this.#context(token, product, repo);
      const current = this.#read(client, repo, product, identifier);
      if (
        current.commit.id !== claim.id ||
        current.payload.operationId !== payload.operationId
      )
        fail(
          "conflict",
          "Workflow head changed during the step; do not replay",
        );
      payload.job = job;
      payload.phase = "idle";
      delete payload.operationId;
      return this.#view(payload, this.#write(client, payload, claim.id));
    } finally {
      clearTimeout(timer);
      this.#active--;
    }
  }
}
