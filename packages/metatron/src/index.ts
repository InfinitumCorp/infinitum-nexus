export { predict } from "./predict.ts";
export type { Prediction, PredictionInput } from "./predict.ts";
export { sum, avg, window } from "./analytics.ts";
export type { Series, Point } from "./analytics.ts";
export { project } from "./forecast.ts";

export { createMetatronLabyrinth } from "./labyrinth.ts";

export { evaluate, brier, logLoss, auc, calibration, forecastError } from "./evaluate.ts";
export type { Scored, Evaluation, CalibrationBin, ForecastError } from "./evaluate.ts";
export { train, predictWith } from "./learn.ts";
export type { LearnedModel, TrainingRow, TrainOptions } from "./learn.ts";
export { backtestProbability, backtestSeries, naive, lastDelta, holt } from "./backtest.ts";
export type { TimedRow, ProbabilityBacktest, Forecaster } from "./backtest.ts";
