/**
 * Hardware / physical product interface stub.
 * DAEMON, SLUG, ORBIS, POLLEN, Flower, NEMESIS, EON, ARGUS, ODIN°.
 * Software cannot fully build these; this is the tasking/telemetry/evidence interface.
 */
export interface HardwareTask {
  id: string;
  product: string;
  command: string;
  createdAt: string;
}

export interface HardwareTelemetry {
  taskId: string;
  status: string;
  data: Record<string, unknown>;
  recordedAt: string;
}

export function task(product: string, command: string): HardwareTask {
  return { id: `hw_${Date.now()}`, product, command, createdAt: new Date().toISOString() };
}

export function telemetry(taskId: string, status: string, data: Record<string, unknown> = {}): HardwareTelemetry {
  return { taskId, status, data, recordedAt: new Date().toISOString() };
}
