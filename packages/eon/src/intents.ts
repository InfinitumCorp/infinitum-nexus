/**
 * E(O)N on-device intents.
 * Spoken commands are parsed on the wearable so the words never leave it.
 * Only the structured intent is acted on. Destructive intents (wipe) need a
 * confirmation step before they run.
 */
export type EonIntent =
  | { type: "call"; contact: string }
  | { type: "message"; contact: string; body: string }
  | { type: "read_messages" }
  | { type: "mute"; on: boolean }
  | { type: "status" }
  | { type: "wipe"; requiresConfirmation: true }
  | { type: "unknown"; text: string };

const WAKE = /^\s*(hey\s+)?e\s*\(?o\)?\s*n[,.\s]*/i;

function clean(s: string): string {
  return s.trim().replace(/[.!?]+$/, "").trim();
}

export function parseIntent(utterance: string): EonIntent {
  const text = clean(utterance.replace(WAKE, ""));
  const lower = text.toLowerCase();
  let m: RegExpMatchArray | null;

  if ((m = text.match(/^(?:message|text|tell)\s+(.+?)\s+(?:saying|that)\s+(.+)$/i))) {
    return { type: "message", contact: clean(m[1]!), body: clean(m[2]!) };
  }
  if ((m = text.match(/^(?:call|ring|dial)\s+(.+)$/i))) {
    return { type: "call", contact: clean(m[1]!) };
  }
  if (/^(read|play)\s+(my\s+)?messages$/.test(lower)) return { type: "read_messages" };
  if (/^(mute|go quiet)$/.test(lower)) return { type: "mute", on: true };
  if (/^unmute$/.test(lower)) return { type: "mute", on: false };
  if (/^(status|battery|how are you)$/.test(lower)) return { type: "status" };
  if (/^(wipe|panic wipe|erase everything)$/.test(lower)) return { type: "wipe", requiresConfirmation: true };
  return { type: "unknown", text };
}
