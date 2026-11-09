export class ValidationError extends Error {}
export function invalid(message: string): never {
  throw new ValidationError(message);
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid("Object required");
  return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).some((k) => !keys.includes(k)))
    invalid("Unknown field");
}
export function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)
  )
    return invalid("Invalid identifier");
  return value;
}
export function number(value: unknown, min: number, max: number): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" &&
          /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n) || n < min || n > max)
    return invalid("Number outside supported range");
  return n;
}
export function integer(value: unknown, min: number, max: number): number {
  const n = number(value, min, max);
  if (!Number.isInteger(n)) return invalid("Integer required");
  return n;
}
export function utc(value: unknown, allowNoZone = false): string {
  if (
    typeof value !== "string" ||
    !(
      allowNoZone
        ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z?$/
        : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
    ).test(value)
  )
    return invalid("UTC timestamp with at most millisecond precision required");
  const s = value.replace(/Z$/, ""),
    parts = s.split("."),
    normalized = parts[0] + "." + (parts[1] ?? "").padEnd(3, "0") + "Z",
    d = new Date(normalized);
  if (
    !Number.isFinite(d.getTime()) ||
    d.toISOString() !== normalized ||
    d.getUTCFullYear() < 1957 ||
    d.getUTCFullYear() > 2099
  )
    return invalid("Invalid or unsupported UTC date");
  return normalized;
}
