/**
 * :\ARCHITECT\ Score: an executable plan with steps, permissions, checkpoints
 * and a definition of success.
 */

export type Autonomy = "rehearsal" | "accompaniment" | "autopilot";

export interface Permission {
  /** Resource the step may touch (app, API, product). */
  resource: string;
  /** Actions allowed (read, write, execute, etc.). */
  actions: string[];
}

export interface Step {
  id: string;
  description: string;
  /** Tool or instrument to call. */
  instrument: string;
  input: Record<string, unknown>;
  /** Permissions required for this step. */
  permissions: Permission[];
  /** Optional checkpoint that must be true before the step runs. */
  checkpoint?: string;
}

export interface Score {
  id: string;
  title: string;
  intent: string;
  autonomy: Autonomy;
  steps: Step[];
  /** What "done" means. */
  success: string;
  createdAt: string;
}

export interface StepResult {
  stepId: string;
  ok: boolean;
  output?: unknown;
  evidence: string[];
  error?: string;
}

export interface Performance {
  scoreId: string;
  results: StepResult[];
  verified: boolean;
  evidence: string[];
}
