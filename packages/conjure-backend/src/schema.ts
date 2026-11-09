import { LabyrinthError } from "@infinitum/lbrnth";
export function fail(code: LabyrinthError["code"], message: string): never {
  throw new LabyrinthError(code, message);
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("invalid", "Object required");
  return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((k) => !keys.includes(k)))
    fail("invalid", "Unknown field");
}
export function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)
  )
    return fail("invalid", "Invalid identifier");
  return value;
}
export function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    return fail("invalid", "Invalid commit");
  return value;
}
export function num(value: unknown, min = 0, max = 1e9): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    return fail("invalid", "Invalid numeric metric");
  return value;
}
export function count(value: unknown, max = 1e9): number {
  const n = num(value, 0, max);
  if (!Number.isInteger(n)) return fail("invalid", "Integer count required");
  return n;
}
