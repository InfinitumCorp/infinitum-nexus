import type { CidLabyrinth } from "@infinitum/lbrnth";
import { conjureClient } from "@infinitum/conjure";
import { ConjureService } from "./service.ts";
/** Trusted operator configuration only; never consume engine URLs/keys from request JSON. */
export function conjureFromEnvironment(
  auth: CidLabyrinth | undefined,
  env: NodeJS.ProcessEnv,
) {
  if (!env.CONJURE_URL) return undefined;
  if (!auth) throw new Error("Configured CONJURE requires CID/Labyrinth");
  if (
    !env.CONJURE_STATE_KEY ||
    !/^[a-fA-F0-9]{64}$/.test(env.CONJURE_STATE_KEY)
  )
    throw new Error(
      "CONJURE requires a persistent 32-byte state-integrity key",
    );
  const entitledOrgs = new Set(
    (env.CONJURE_ENTITLED_ORGS ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  );
  return new ConjureService(auth, {
    entitled: (org, product) => product === "CONJURE" && entitledOrgs.has(org),
    engine: conjureClient({
      baseUrl: env.CONJURE_URL,
      token: env.CONJURE_TOKEN,
    }),
    integrityKey: Buffer.from(env.CONJURE_STATE_KEY, "hex"),
  });
}
