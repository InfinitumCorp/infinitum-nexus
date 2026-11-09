import type { CidLabyrinth } from "@infinitum/lbrnth";
import { productPreset } from "@infinitum/conjure";
import type { EvidenceKind } from "@infinitum/conjure";
import { object, exact, num, count, hash, fail } from "./schema.ts";
export interface Evidence {
  kind: EvidenceKind;
  sampleCount: number;
  metrics: Record<string, number>;
  limitations: string[];
}
export function cyberSignals(statuses: readonly number[]) {
  if (statuses.length < 1 || statuses.length > 10000)
    fail("invalid", "Bounded HTTP sample required");
  for (const status of statuses)
    if (count(status, 599) < 100) fail("invalid", "Invalid HTTP status");
  return {
    requests: statuses.length,
    failures: statuses.filter((s) => s >= 500).length,
    denied: statuses.filter((s) => s === 401 || s === 403).length,
  };
}
export function exerciseSignals(checks: readonly boolean[]) {
  if (
    checks.length < 1 ||
    checks.length > 10000 ||
    checks.some((v) => typeof v !== "boolean")
  )
    fail("invalid", "Bounded exercise sample required");
  return {
    trials: checks.length,
    failedTrials: checks.filter((v) => !v).length,
  };
}
export function checkpoint(kind: "cyber" | "exercise", input: unknown) {
  const row = object(input),
    keys =
      kind === "cyber"
        ? ["requests", "failures", "denied"]
        : ["trials", "failedTrials"];
  exact(row, keys);
  const metrics = Object.fromEntries(keys.map((k) => [k, count(row[k])]));
  if (
    kind === "cyber"
      ? metrics.requests! < 1 ||
        metrics.failures! > metrics.requests! ||
        metrics.denied! > metrics.requests!
      : metrics.trials! < 1 || metrics.failedTrials! > metrics.trials!
  )
    fail("invalid", "Inconsistent aggregate counts");
  return metrics;
}
/** Reads selected archive records, but never returns their strings, identities, locations or content. */
export function aggregateArtifacts(
  kind: Exclude<EvidenceKind, "storage">,
  values: unknown[],
  product: string,
  now: Date,
): Evidence {
  productPreset(product, kind);
  if (values.length < 1 || values.length > 16)
    fail("invalid", "Select 1–16 evidence artifacts");
  const rows = values.map(object);
  if (rows.some((r) => r.product !== product))
    fail("invalid", "Evidence product mismatch");
  const metrics: Record<string, number> = {};
  let samples = 0;
  if (kind === "telemetry") {
    let sum = 0,
      known = 0,
      missing = 0,
      min = 100,
      max = 0;
    for (const row of rows) {
      if (!Array.isArray(row.observations) || row.observations.length > 64)
        fail("invalid", "Invalid telemetry archive");
      for (const raw of row.observations as unknown[]) {
        const observation = object(raw);
        if (observation.kind !== "systemStatus") continue;
        samples++;
        const battery = object(observation.data).batteryPct;
        if (battery === null || battery === undefined) {
          missing++;
          continue;
        }
        const n = num(battery, 0, 100);
        sum += n;
        known++;
        min = Math.min(min, n);
        max = Math.max(max, n);
      }
    }
    metrics.systemStatusSamples = samples;
    metrics.missingBatterySamples = missing;
    if (known) {
      metrics.meanBatteryPct = sum / known;
      metrics.minimumBatteryPct = min;
      metrics.maximumBatteryPct = max;
    }
  } else if (kind === "delivery") {
    metrics.pending = 0;
    metrics.delivered = 0;
    metrics.totalAttempts = 0;
    metrics.oldestPendingSeconds = 0;
    for (const row of rows) {
      if (row.delivery !== "pending" && row.delivery !== "delivered")
        fail("invalid", "Invalid delivery receipt");
      metrics[row.delivery as string]!++;
      metrics.totalAttempts! += count(row.attempts, 10);
      if (
        typeof row.createdAt !== "string" ||
        !Number.isFinite(Date.parse(row.createdAt))
      )
        fail("invalid", "Receipt time required");
      if (row.delivery === "pending")
        metrics.oldestPendingSeconds = Math.max(
          metrics.oldestPendingSeconds!,
          Math.max(
            0,
            (now.getTime() - Date.parse(row.createdAt as string)) / 1000,
          ),
        );
      samples++;
    }
  } else if (kind === "orbital") {
    metrics.passCount = 0;
    metrics.clippedPasses = 0;
    metrics.acceptedContacts = 0;
    metrics.rejectedContacts = 0;
    for (const row of rows) {
      if (row.simulationOnly !== true)
        fail("invalid", "Offline orbital artifact required");
      const data = object(row.data);
      if (row.kind === "budgets") {
        const margin = num(data.marginDb, -1000, 1000);
        metrics.minimumIllustrativeMarginDb = Math.min(
          metrics.minimumIllustrativeMarginDb ?? margin,
          margin,
        );
      } else if (row.kind === "passes") {
        if (!Array.isArray(data.passes) || data.passes.length > 64)
          fail("invalid", "Bounded pass artifact required");
        metrics.passCount! += data.passes.length;
        for (const value of data.passes) {
          const p = object(value);
          if (
            typeof p.clippedStart !== "boolean" ||
            typeof p.clippedEnd !== "boolean"
          )
            fail("invalid", "Pass clipping flags required");
          if (p.clippedStart || p.clippedEnd) metrics.clippedPasses!++;
        }
      } else if (row.kind === "schedules") {
        if (
          !Array.isArray(data.accepted) ||
          !Array.isArray(data.rejected) ||
          data.accepted.length > 128 ||
          data.rejected.length > 128
        )
          fail("invalid", "Bounded contact proposal required");
        metrics.acceptedContacts! += data.accepted.length;
        metrics.rejectedContacts! += data.rejected.length;
      } else fail("invalid", "Unsupported orbital evidence kind");
      samples++;
    }
  } else {
    for (const row of rows) {
      if (row.kind !== kind || row.schema !== 1)
        fail("invalid", "Aggregate checkpoint required");
      const counts = checkpoint(kind, row.metrics);
      for (const [key, value] of Object.entries(counts))
        metrics[key] = (metrics[key] ?? 0) + value;
      samples += kind === "cyber" ? counts.requests! : counts.trials!;
    }
  }
  if (samples < 1) fail("invalid", "No usable observations");
  return {
    kind,
    sampleCount: samples,
    metrics,
    limitations: [
      "Selected archived/client-asserted observations only; not a complete live fleet or calibrated predictor.",
      "Qualitative scenario rehearsal; no individual/position/content data and no operational recommendations.",
    ],
  };
}
export type ProductClient = ReturnType<CidLabyrinth["forProduct"]>;
export function collectEvidence(
  client: ProductClient,
  repo: string,
  product: string,
  input: unknown,
  now: Date,
) {
  const source = object(input);
  if (typeof source.kind !== "string")
    fail("invalid", "Evidence kind required");
  const kind = source.kind as EvidenceKind;
  productPreset(product, kind);
  if (kind === "storage") {
    exact(source, ["kind"]);
    const usage = client.usage();
    return {
      source: { kind },
      evidence: {
        kind,
        sampleCount: Math.max(1, usage.repositories),
        metrics: { ...usage },
        limitations: [
          "Shared organization JSON snapshot before this read's own audit entry; includes all products and metadata, not disk usage or a per-product quota.",
          "Single snapshot supports scenario analysis only, not a time-series capacity forecast.",
        ],
      } satisfies Evidence,
    };
  }
  exact(source, ["kind", "commit", "paths"]);
  const commit = hash(source.commit);
  if (
    !Array.isArray(source.paths) ||
    source.paths.length < 1 ||
    source.paths.length > 16 ||
    new Set(source.paths).size !== source.paths.length
  )
    fail("invalid", "Select distinct bounded artifacts");
  const pattern = {
    telemetry:
      /^logs\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.json$/,
    delivery:
      /^ingest\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.json$/,
    orbital:
      /^orbital\/(passes|budgets|schedules)\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.json$/,
    cyber: /^signals\/cyber\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.json$/,
    exercise: /^signals\/exercise\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.json$/,
  }[kind];
  const values = (source.paths as unknown[]).map((path) => {
    if (typeof path !== "string" || !pattern?.test(path))
      return fail("invalid", "Invalid evidence path");
    const bytes = client.load(repo, commit, path);
    if (bytes.length > 131072) fail("capacity", "Evidence artifact too large");
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      return fail("invalid", "Invalid evidence JSON");
    }
  });
  return {
    source: { kind, commit, paths: source.paths as string[] },
    evidence: aggregateArtifacts(
      kind as Exclude<EvidenceKind, "storage">,
      values,
      product,
      now,
    ),
  };
}
