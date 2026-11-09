/**
 * VEIL workspaces.
 *
 * Anonymous: Tor-first browsing with no account, no AI, no wallet, no sync
 *   and no rewards. Nothing links browsing to a person.
 * Authenticated: Cumulus://ID, Cumulus://Mail, FIRM Wallet, SCALVS.ai,
 *   :\ARCHITECT\ and $VEIL rewards. Never described as anonymous.
 *
 * Switching is always a deliberate, labeled action, and it clears site data
 * so identifying state never moves silently from one workspace to the other.
 */

export const ANONYMOUS = "anonymous";
export const AUTHENTICATED = "authenticated";

export const DEFAULT_WORKSPACE = ANONYMOUS;

const CAPABILITIES = {
  [ANONYMOUS]: new Set(["browse", "tor", "trackers", "newIdentity"]),
  [AUTHENTICATED]: new Set([
    "browse", "tor", "trackers", "newIdentity",
    "signin", "ai", "wallet", "rewards", "sync",
  ]),
};

export const LABELS = {
  [ANONYMOUS]: "Anonymous workspace",
  [AUTHENTICATED]: "Signed-in workspace",
};

export function isWorkspace(value) {
  return value === ANONYMOUS || value === AUTHENTICATED;
}

/** Unknown or missing values fall back to anonymous (fail closed). */
export function normalize(value) {
  return isWorkspace(value) ? value : DEFAULT_WORKSPACE;
}

export function can(workspace, capability) {
  return CAPABILITIES[normalize(workspace)].has(capability);
}

/**
 * Describe what a switch will do, so the UI can show it before confirming.
 * @returns {{ from: string, to: string, clearSiteData: boolean, warning: string } | null}
 *   null when there is nothing to switch.
 */
export function planSwitch(from, to) {
  from = normalize(from);
  if (!isWorkspace(to)) throw new Error(`Unknown workspace: ${to}`);
  if (from === to) return null;
  return {
    from,
    to,
    clearSiteData: true,
    warning:
      to === ANONYMOUS
        ? "Leaving the signed-in workspace clears cookies and site data and turns off AI, wallet and rewards."
        : "Entering the signed-in workspace clears anonymous cookies and site data first. Signed-in browsing is not anonymous.",
  };
}

/** Site data VEIL clears on a switch or New Identity. History, passwords and downloads are left alone. */
export const SITE_DATA_TYPES = Object.freeze({
  cookies: true,
  cache: true,
  cacheStorage: true,
  localStorage: true,
  indexedDB: true,
  serviceWorkers: true,
  fileSystems: true,
  webSQL: true,
});
