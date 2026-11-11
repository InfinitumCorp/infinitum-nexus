/** A sensor sample that does not exist unless the owner opted in. */
export function consentedSample<T>(consent: string, kind: string, value: T): {
  consent: string;
  kind: string;
  value: T;
} {
  const token = consent.trim();
  if (!token) throw new Error("A sensor sample needs the owner's consent.");
  if (!kind.trim()) throw new Error("A sensor sample needs a kind.");
  return { consent: token, kind, value };
}
