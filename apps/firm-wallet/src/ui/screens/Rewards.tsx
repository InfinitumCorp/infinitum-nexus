import { tokensFor } from "../../core/config.ts";
import { evmRewards, solanaRewards, type Reward } from "../../core/rewards.ts";
import { useStore } from "../store.ts";
import { num, useAsync } from "../kit.tsx";

export function RewardsScreen() {
  const { session, prefs } = useStore();
  const anyLive = (["ethereum", "base", "solana"] as const).some((c) => tokensFor(prefs.mode, c).some((t) => t.infinitum && t.address));
  const r = useAsync(async () => {
    const lists = await Promise.all([
      evmRewards(prefs.mode, "ethereum", session!.evm.address, tokensFor(prefs.mode, "ethereum")),
      evmRewards(prefs.mode, "base", session!.evm.address, tokensFor(prefs.mode, "base")),
      solanaRewards(prefs.mode, session!.sol.address, tokensFor(prefs.mode, "solana")),
    ]);
    return lists.flat();
  }, [prefs.mode, session?.evm.address]);
  const byProduct = new Map<string, Reward[]>();
  for (const x of r.data ?? []) byProduct.set(x.product, [...(byProduct.get(x.product) ?? []), x]);

  return (
    <div class="stack">
      <p class="eyebrow">Rewards inbox</p>
      <h1>Rewards</h1>
      <p class="muted small">Earnings from VEIL, [HRVST]™, Cumulus://Cloud™, FabriC++™ and every other product land here, with where each one came from. Each reward is a token transfer recorded on chain, so you can check it in the explorer.</p>
      {!anyLive && <p class="note">No Infinitum product tokens are live on this network yet. When they launch, rewards sent to your addresses show up here automatically.</p>}
      <div class="row"><button class="btn ghost" onClick={r.reload} disabled={r.loading}>{r.loading ? "Checking…" : "Check again"}</button></div>
      {r.error && <p class="warn">{r.error}</p>}
      {anyLive && !r.loading && !r.data?.length && <p class="muted">No rewards yet.</p>}
      <div class="grid two">
        {[...byProduct.entries()].map(([product, list]) => (
          <section class="card stack">
            <div class="row between"><h3>{product}</h3><span class="small muted">{list.length} reward{list.length === 1 ? "" : "s"}</span></div>
            <table class="list"><tbody>
              {list.map((x) => (
                <tr>
                  <td>+{num(Number(x.amount))} {x.symbol}<div class="small muted">{x.chain}{x.at ? ` · ${new Date(x.at).toLocaleDateString()}` : ""}</div></td>
                  <td class="r"><a class="small" href={x.explorerUrl} target="_blank" rel="noopener noreferrer">View</a></td>
                </tr>
              ))}
            </tbody></table>
          </section>
        ))}
      </div>
    </div>
  );
}
