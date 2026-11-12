/** METATRON¹⁰⁰'s canonical public site. */
export const METATRON_URL = "https://mttrn.app";

export { predict } from "./predict.ts";
export type { Prediction, PredictionInput } from "./predict.ts";
export { sum, avg, window } from "./analytics.ts";
export type { Series, Point } from "./analytics.ts";
export { project, forecast, drift, seasonalNaive, holtWinters, normalQuantile } from "./forecast.ts";
export type { ForecastResult, ForecastOptions } from "./forecast.ts";
export { anomalies, changePoints, digest } from "./signals.ts";
export type { Anomaly, AnomalyOptions, ChangePoint, DigestItem } from "./signals.ts";

export { createMetatronLabyrinth } from "./labyrinth.ts";

export { evaluate, brier, logLoss, auc, calibration, forecastError } from "./evaluate.ts";
export type { Scored, Evaluation, CalibrationBin, ForecastError } from "./evaluate.ts";
export { train, predictWith } from "./learn.ts";
export type { LearnedModel, TrainingRow, TrainOptions } from "./learn.ts";
export { backtestProbability, backtestSeries, naive, lastDelta, holt } from "./backtest.ts";
export type { TimedRow, ProbabilityBacktest, Forecaster } from "./backtest.ts";

// "What if?" scenario engine.
export { simulate, compare, sensitivity, validateModel, LIMITS } from "./simulate.ts";
export type {
  ScenarioModel, AgentSpec, Intervention, SimulateOptions, ScenarioResult, Band, Summary,
  EventResult, Comparison, Delta, SensitivityRow,
} from "./simulate.ts";
export type { Dist, DistInput } from "./distributions.ts";
export { compile, ExprError, FUNCTION_NAMES } from "./expr.ts";
export { createRng } from "./rng.ts";
export type { Rng } from "./rng.ts";
