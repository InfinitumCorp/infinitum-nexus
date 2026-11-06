/**
 * Architect health aggregation.
 * Checks local and optional Spectre health.
 */
export interface HealthStatus {
  service: string;
  ok: boolean;
  detail?: string;
}

export async function aggregateHealth(spectreUrl?: string): Promise<HealthStatus[]> {
  const out: HealthStatus[] = [{ service: "conductor", ok: true }];
  if (spectreUrl) {
    try {
      const r = await fetch(`${spectreUrl}/health`);
      out.push({ service: "spectre", ok: r.ok });
    } catch (err) {
      out.push({ service: "spectre", ok: false, detail: String(err) });
    }
  }
  return out;
}
