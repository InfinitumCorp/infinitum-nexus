/**
 * CyberArk Conjur resource id, same split as Resource.from_full_id
 * in third_party/cyberark-conjur/resource.py (Python split with maxsplit 2).
 */
export function conjurResource(fullId: string): { kind: string; identifier: string } {
  const first = fullId.indexOf(":");
  if (first < 0) throw new Error(`Resource ID missing 'kind:' prefix: ${fullId}`);
  const second = fullId.indexOf(":", first + 1);
  if (second < 0) return { kind: fullId.slice(0, first), identifier: fullId.slice(first + 1) };
  return { kind: fullId.slice(first + 1, second), identifier: fullId.slice(second + 1) };
}
