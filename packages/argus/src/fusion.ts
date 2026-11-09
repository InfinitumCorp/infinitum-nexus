/**
 * >_ARGUS sensor fusion.
 * Detections from many sensors (radar, EO/IR, acoustic, RF) are associated
 * to tracks with a chi-square gate and global-nearest-neighbour assignment,
 * filtered with a constant-velocity Kalman filter, and published as one
 * picture. Every track keeps its provenance: which sensors saw it and when.
 *
 * Track lifecycle: tentative → confirmed (after `confirmHits` updates)
 * → coasting (missed a scan) → dropped (after `dropAfterMisses` misses).
 */
import { initState, mahalanobis2, predict, update, type KalmanState } from "./kalman.ts";

export interface Sensor {
  id: string;
  kind: "radar" | "eo_ir" | "acoustic" | "rf" | "other";
  /** 1-sigma position error in metres. */
  sigmaM: number;
}

export interface Detection {
  sensorId: string;
  /** Seconds since an epoch shared by all sensors. */
  t: number;
  x: number;
  y: number;
  label?: string;
}

export type TrackStatus = "tentative" | "confirmed" | "coasting";

export interface Track {
  id: string;
  status: TrackStatus;
  state: KalmanState;
  t: number;
  hits: number;
  misses: number;
  sensors: Set<string>;
  labels: Map<string, number>;
}

export interface PictureEntry {
  id: string;
  status: TrackStatus;
  t: number;
  position: [number, number];
  velocity: [number, number];
  speed: number;
  headingDeg: number;
  /** 1-sigma position uncertainty (metres, from the covariance trace). */
  sigmaM: number;
  sensors: string[];
  label: string | null;
}

export interface FusionConfig {
  /** Chi-square gate for 2 dof. 9.21 ≈ 99%. */
  gate: number;
  /** Process noise (m²/s³). */
  q: number;
  confirmHits: number;
  dropAfterMisses: number;
}

export const DEFAULT_CONFIG: FusionConfig = { gate: 9.21, q: 1, confirmHits: 3, dropAfterMisses: 3 };

export class FusionEngine {
  private readonly sensors = new Map<string, Sensor>();
  private readonly tracks = new Map<string, Track>();
  private nextId = 1;
  private readonly cfg: FusionConfig;
  readonly dropped: string[] = [];

  constructor(sensors: Sensor[], cfg: Partial<FusionConfig> = {}) {
    for (const s of sensors) this.sensors.set(s.id, s);
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
  }

  /**
   * Ingest one scan: a batch of detections taken at (about) the same time.
   * Each detection updates at most one track; each track takes at most one
   * detection per sensor per scan.
   */
  ingest(scan: Detection[]): void {
    if (scan.length === 0) return;
    for (const d of scan) {
      if (!this.sensors.has(d.sensorId)) throw new Error(`unknown sensor ${d.sensorId}`);
    }
    const t = Math.max(...scan.map((d) => d.t));

    // Group by sensor so each sensor's detections are assigned independently.
    const bySensor = new Map<string, Detection[]>();
    for (const d of scan) bySensor.set(d.sensorId, [...(bySensor.get(d.sensorId) ?? []), d]);

    const updated = new Set<string>();
    for (const [sensorId, dets] of bySensor) {
      const r = this.sensors.get(sensorId)!.sigmaM ** 2;
      const candidates: { track: Track; det: Detection; d2: number }[] = [];
      for (const track of this.tracks.values()) {
        for (const det of dets) {
          const predicted = predict(track.state, det.t - track.t, this.cfg.q);
          const d2 = mahalanobis2(predicted, det.x, det.y, r);
          if (d2 <= this.cfg.gate) candidates.push({ track, det, d2 });
        }
      }
      candidates.sort((a, b) => a.d2 - b.d2);
      const usedTracks = new Set<string>();
      const usedDets = new Set<Detection>();
      for (const c of candidates) {
        if (usedTracks.has(c.track.id) || usedDets.has(c.det)) continue;
        usedTracks.add(c.track.id);
        usedDets.add(c.det);
        this.applyUpdate(c.track, c.det, r);
        updated.add(c.track.id);
      }
      for (const det of dets) {
        if (!usedDets.has(det)) updated.add(this.spawn(det, r).id);
      }
    }

    for (const track of [...this.tracks.values()]) {
      if (updated.has(track.id)) continue;
      track.misses++;
      if (track.status === "tentative" || track.misses >= this.cfg.dropAfterMisses) {
        this.tracks.delete(track.id);
        this.dropped.push(track.id);
      } else {
        track.status = "coasting";
        track.state = predict(track.state, t - track.t, this.cfg.q);
        track.t = t;
      }
    }
  }

  private spawn(det: Detection, r: number): Track {
    const track: Track = {
      id: `ARG-${String(this.nextId++).padStart(4, "0")}`,
      status: "tentative",
      state: initState(det.x, det.y, r),
      t: det.t,
      hits: 1,
      misses: 0,
      sensors: new Set([det.sensorId]),
      labels: new Map(det.label ? [[det.label, 1]] : []),
    };
    this.tracks.set(track.id, track);
    return track;
  }

  private applyUpdate(track: Track, det: Detection, r: number): void {
    const predicted = predict(track.state, det.t - track.t, this.cfg.q);
    track.state = update(predicted, det.x, det.y, r);
    track.t = Math.max(track.t, det.t);
    track.hits++;
    track.misses = 0;
    track.sensors.add(det.sensorId);
    if (det.label) track.labels.set(det.label, (track.labels.get(det.label) ?? 0) + 1);
    if (track.hits >= this.cfg.confirmHits) track.status = "confirmed";
    else if (track.status === "coasting") track.status = "tentative";
  }

  /** The fused picture. Tentative tracks are hidden unless asked for. */
  picture(opts: { includeTentative?: boolean } = {}): PictureEntry[] {
    return [...this.tracks.values()]
      .filter((t) => opts.includeTentative || t.status !== "tentative")
      .map((t) => {
        const [x, y, vx, vy] = t.state.x;
        const label = [...t.labels.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        return {
          id: t.id,
          status: t.status,
          t: t.t,
          position: [x, y],
          velocity: [vx, vy],
          speed: Math.hypot(vx, vy),
          headingDeg: ((Math.atan2(vx, vy) * 180) / Math.PI + 360) % 360,
          sigmaM: Math.sqrt((t.state.P[0][0] + t.state.P[1][1]) / 2),
          sensors: [...t.sensors].sort(),
          label,
        } satisfies PictureEntry;
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
