import { DriveError } from "./errors.ts";

const CONTROL_OR_SLASH = /[\u0000-\u001f\u007f/\\]/;

/** Folder and file names are a single path segment. They never become filesystem paths. */
export function cleanName(input: string): string {
  const name = input.normalize("NFC").trim();
  if (!name || name === "." || name === ".." || name.length > 255 || CONTROL_OR_SLASH.test(name)) {
    throw new DriveError(400, "bad_name", "Names cannot be empty, be . or .., or contain slashes or control characters");
  }
  return name;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function cleanId(input: string, label = "Identifier"): string {
  const id = input.trim().toLowerCase();
  if (!UUID.test(id) || id === "00000000-0000-0000-0000-000000000000") {
    throw new DriveError(400, "invalid_id", `${label} is not valid`);
  }
  return id;
}

export function optionalId(input: unknown, label = "Identifier"): string | null {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input !== "string") throw new DriveError(400, "invalid_id", `${label} is not valid`);
  return cleanId(input, label);
}

/** Client-declared type is stored for reference. Downloads use the sniffed type. */
export function declaredType(input: unknown): string {
  const raw = String(input ?? "application/octet-stream").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(raw) || raw.length > 120) {
    return "application/octet-stream";
  }
  return raw;
}

export function cleanSha256(input: unknown): string | null {
  if (input === undefined || input === null || input === "") return null;
  const hex = String(input).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new DriveError(400, "bad_checksum", "SHA-256 must be 64 hex characters");
  return hex;
}
