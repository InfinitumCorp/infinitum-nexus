/**
 * Conductor production configuration.
 */
export const config = {
  port: Number(process.env.PORT ?? 3001),
  logLevel: process.env.LOG_LEVEL ?? "info",
  spectreUrl: process.env.SPECTRE_URL ?? "http://localhost:3000",
};

export function log(level: string, msg: string, extra?: Record<string, unknown>) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  const current = levels[config.logLevel as keyof typeof levels] ?? 1;
  const requested = levels[level as keyof typeof levels] ?? 1;
  if (requested >= current) {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra });
    console.log(line);
  }
}
