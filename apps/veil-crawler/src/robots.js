/**
 * robots.txt (RFC 9309) for VEILBot. The group for "VEILBot" applies if there is one,
 * otherwise the "*" group. Longest matching rule wins; Allow wins a tie. "*" matches any
 * characters and "$" anchors the end. Crawl-delay is honoured (capped at 60 s).
 */
export const BOT_TOKEN = "veilbot";
export const MAX_ROBOTS_BYTES = 500 * 1024;

export function parseRobots(body) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(body ?? "").slice(0, MAX_ROBOTS_BYTES).split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [], delay: null }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      if (value === "" && key === "disallow") continue; // "Disallow:" with no path allows everything
      current.rules.push({ allow: key === "allow", path: value });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.delay = Math.min(n, 60);
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a.split("/")[0].trim() === BOT_TOKEN));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  return {
    rules: chosen.flatMap((g) => g.rules),
    delay: chosen.map((g) => g.delay).find((d) => d !== null) ?? null,
  };
}

function ruleMatches(rulePath, path) {
  let pattern = "";
  for (const ch of rulePath) pattern += ch === "*" ? ".*" : ch === "$" ? "$" : ch.replace(/[.+?^{}()|[\]\\]/g, "\\$&");
  // "$" is only an anchor at the very end; elsewhere it is literal.
  if (pattern.includes("$") && !pattern.endsWith("$")) pattern = pattern.replace(/\$(?!$)/g, "\\$");
  return new RegExp("^" + pattern).test(path);
}

/** Whether VEILBot may fetch this path (path + query, e.g. "/a/b?c=1"). */
export function isAllowed(robots, pathAndQuery) {
  let best = null;
  for (const r of robots.rules) {
    if (!ruleMatches(r.path, pathAndQuery)) continue;
    const len = r.path.replace(/\*/g, "").length;
    if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}

/** robots.txt allowing everything (used when the file is missing: 4xx). */
export const ALLOW_ALL = Object.freeze({ rules: [], delay: null });
