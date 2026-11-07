/** Conjure™: the swarm prediction feature built into Infinitum products. */
export {
  createSimulation, step as conjureStep, inject as conjureInject, fork as conjureFork, writeReport as conjureReport,
  interview as conjureInterview, estimateCalls as conjureEstimate, claudeComplete, parseJson, ConjureError,
} from "./conjure.ts";
export type { Simulation, Persona, Post, Report as ConjureReport, RoundStats, Complete, Entity, Relation } from "./conjure.ts";

export { createConjureLabyrinth } from "./labyrinth.ts";

export {conjureClient,createJob,advanceJob,isWaiting,STAGES as CONJURE_STAGES,stageOf,UpstreamError} from "./engine.ts";
export type {ForecastJob,EngineClient,EngineOptions} from "./engine.ts";
export {CONJURE_PRODUCT_PRESETS,productPreset} from "./product-presets.ts";
export type {EvidenceKind} from "./product-presets.ts";
