/**
 * E(O)N usage meter.
 * Keeps only counts and durations: no audio, transcripts, contacts or
 * location. The aggregate matches the EonCollector schema in
 * @infinitum/data-exchange ("sessionCount,avgDuration") and is withheld
 * until enough sessions exist to avoid describing a single conversation.
 */
import type { FrameKind } from "./channel.ts";

export interface EonUsageAggregate {
  sessionCount: number;
  avgDuration: number;
  framesByKind: Record<FrameKind, number>;
}

export const MIN_SESSIONS_FOR_EXPORT = 5;

export class UsageMeter {
  private open = new Map<string, number>();
  private durations: number[] = [];
  private frames: Record<FrameKind, number> = { voice: 0, text: 0, control: 0 };

  start(sessionId: string, atMs: number): void {
    if (this.open.has(sessionId)) throw new Error(`session ${sessionId} already open`);
    this.open.set(sessionId, atMs);
  }

  frame(kind: FrameKind): void {
    this.frames[kind]++;
  }

  end(sessionId: string, atMs: number): void {
    const started = this.open.get(sessionId);
    if (started === undefined) throw new Error(`session ${sessionId} not open`);
    this.open.delete(sessionId);
    this.durations.push(Math.max(0, (atMs - started) / 1000));
  }

  /** Returns null until there are enough sessions to export safely. */
  aggregate(): EonUsageAggregate | null {
    const n = this.durations.length;
    if (n < MIN_SESSIONS_FOR_EXPORT) return null;
    const avg = this.durations.reduce((a, b) => a + b, 0) / n;
    return { sessionCount: n, avgDuration: Math.round(avg * 10) / 10, framesByKind: { ...this.frames } };
  }
}
