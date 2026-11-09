/**
 * Conductor-facing Architect API. This entry does not load the Labyrinth proxy.
 */
export { perform, registerInstrument } from "./executor.ts";
export type { Instrument } from "./executor.ts";
export type { Autonomy, Performance, Score, Step, StepResult } from "./score.ts";
export { registerDefaultInstruments } from "./instruments.ts";
export { recordEvidence } from "./firmament.ts";
export { planScore } from "./plan.ts";
