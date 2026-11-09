/**
 * HRVST privacy filter stub.
 * In production this would strip PII, faces, license plates, etc.
 * For now it redacts obvious patterns and returns a cleaned observation.
 */

const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
/** US-style numbers, with or without a country code, spaces, dots, dashes or parentheses. */
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]*)\d{3}[\s.-]*\d{4}\b/g;

export function privacyFilter(observation: string): { cleaned: string; redactions: string[] } {
  const redactions: string[] = [];
  let cleaned = observation.replace(EMAIL, () => {
    redactions.push("email");
    return "[redacted-email]";
  });
  cleaned = cleaned.replace(PHONE, () => {
    redactions.push("phone");
    return "[redacted-phone]";
  });
  return { cleaned, redactions };
}
