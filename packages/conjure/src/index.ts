/** Conjure™: the swarm prediction feature built into Infinitum products. */
export {
  createSimulation, step as conjureStep, inject as conjureInject, fork as conjureFork, writeReport as conjureReport,
  interview as conjureInterview, estimateCalls as conjureEstimate, routerComplete, parseJson, ConjureError,
} from "./conjure.ts";
export type { Simulation, Persona, Post, Report as ConjureReport, RoundStats, Complete, Entity, Relation } from "./conjure.ts";

export { createConjureLabyrinth } from "./labyrinth.ts";

/** Seed a forecast from the web with Infinitum Search when no material was given. */
export { webSeed } from "./web-seed.ts";
export type { WebSeed } from "./web-seed.ts";

/** @conjure: reach Conjure from any product by mentioning it. */
export {
  parseConjureMention, hasConjureMention, formatForecast, createConjureLive, conjureLiveFromEnv, handleConjureMention, ConjureApiError,
} from "./mention.ts";
export type { ConjureMention, LivePrediction, PredictOptions, ConjureLiveClient } from "./mention.ts";
