/**
 * HRVST privacy filter stub.
 * In production this would strip PII, faces, license plates, etc.
 * For now it redacts obvious patterns and returns a cleaned observation.
 */

export function privacyFilter(observation: string): { cleaned: string; redactions: string[] } {
  const redactions: string[] = [];
  let cleaned = observation;

  // Redact email-like strings
  cleaned = cleaned.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, (m) => {
    redactions.push("email");
    return "[redacted-email]";
  });

  // Redact phone-like strings
  cleaned = cleaned.replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, (m) => {
    redactions.push("phone");
    return "[redacted-phone]";
  });

  return { cleaned, redactions };
}
