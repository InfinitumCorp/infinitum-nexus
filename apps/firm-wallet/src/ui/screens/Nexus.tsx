import { useState } from "preact/hooks";
import { NEXUS_PRODUCTS, tokensFor } from "../../core/config.ts";
import { parseRequest, reply, siweMessage, type ConnectRequest, type NexusRequest, type PayRequest } from "../../core/connect.ts";
import { errorText, requestApproval, savePrefs, toast, useStore } from "../store.ts";
import { openSend, short } from "./Wallet.tsx";

const allowLocal = import.meta.env.DEV;

export function NexusScreen() {
  const { prefs } = useStore();
  return (
    <div class="stack">
      <p class="eyebrow">VEIL Nexus</p>
      <h1>Connections</h1>
      <p class="muted small">One sign-in for the whole ecosystem. Cumulus://Cloud™, SCALVS.ai™, :\ARCHITECT\™, METATRON¹⁰⁰™ and the other products can ask this wallet to sign you in or to pay. Every request shows exactly what you're approving, and only Infinitum product sites can ask.</p>
      <section class="card stack">
        <h3>Connected products</h3>
        {!prefs.connections.length && <p class="small muted">Nothing connected yet.</p>}
        <table class="list"><tbody>
          {prefs.connections.map((c) => (
            <tr>
              <td><b>{c.name}</b><div class="small muted">{c.origin} · {short(c.address)} · since {new Date(c.connectedAt).toLocaleDateString()}</div></td>
              <td class="r"><button class="btn ghost" onClick={() => savePrefs({ connections: prefs.connections.filter((x) => x.origin !== c.origin) })}>Disconnect</button></td>
            </tr>
          ))}
        </tbody></table>
      </section>
      <section class="card stack small">
        <h3>For product teams</h3>
        <p class="muted">Open <span class="mono">https://firmwallet.app/#/connect?origin=&lt;your origin&gt;&amp;nonce=&lt;random&gt;</span> in a popup. The wallet replies with <span class="mono">postMessage</span> to your exact origin: <span class="mono">{"{ source: \"firm-wallet\", type: \"connect\", address, message, signature }"}</span>, a standard Sign-In with Ethereum (EIP-4361) message your backend can verify. Payments: <span class="mono">#/pay?origin=…&amp;chain=base&amp;asset=USDC&amp;to=0x…&amp;amount=…&amp;memo=…</span>.</p>
        <p class="muted">Allowed sites: {NEXUS_PRODUCTS.map((p) => p.hosts.join(", ")).join(" · ")}.</p>
      </section>
    </div>
  );
}

/** Handles #/connect and #/pay as soon as the wallet is unlocked. */
export function useNexusRequest(): [NexusRequest | { error: string } | null, () => void] {
  const [req, setReq] = useState(() => parseRequest(location.hash, allowLocal));
  return [req, () => { setReq(null); location.hash = "#/wallet"; }];
}

export function NexusRequestCard({ req, onDone }: { req: NexusRequest | { error: string }; onDone: () => void }) {
  const { session, prefs } = useStore();
  const [busy, setBusy] = useState(false);
  if ("error" in req) {
    return (
      <section class="card ink stack narrow">
        <h2>Request refused</h2>
        <p class="warn">{req.error}</p>
        <button class="btn block" onClick={onDone}>Go to wallet</button>
      </section>
    );
  }

  const connect = async (r: ConnectRequest) => {
    setBusy(true);
    try {
      const address = session!.evm.address;
      const message = siweMessage(r, prefs.mode, address);
      const ok = await requestApproval({
        title: `Sign in to ${r.product.name}`,
        details: [["Site", r.product.origin], ["Account", address], ["What this does", "Proves you own this address. It can't move funds or approve spending."], ["Message", message]],
        confirmLabel: "Sign in",
      });
      if (!ok) {
        reply(r.product.origin, { type: "connect", error: "rejected" });
        return onDone();
      }
      const signature = await session!.evm.signMessage({ message });
      const delivered = reply(r.product.origin, { type: "connect", address, message, signature });
      await savePrefs({ connections: [...prefs.connections.filter((c) => c.origin !== r.product.origin), { productId: r.product.id, name: r.product.name, origin: r.product.origin, address, connectedAt: new Date().toISOString() }] });
      toast(delivered ? `Signed in to ${r.product.name}.` : `Connected. Return to ${r.product.name}.`);
      if (delivered) setTimeout(() => window.close(), 400);
      onDone();
    } catch (e) {
      toast(errorText(e), "err");
    } finally {
      setBusy(false);
    }
  };

  const pay = (r: PayRequest) => {
    const token = tokensFor(prefs.mode, r.chain).find((t) => t.symbol === r.asset);
    if (!token) {
      toast(`${r.asset} isn't available on ${r.chain}.`, "err");
      return onDone();
    }
    openSend({
      kind: "send", chain: r.chain, token, to: r.to, amount: r.amount, memo: `${r.product.name}: ${r.memo || "payment"}`,
      onDone: (hash) => reply(r.product.origin, { type: "pay", requestId: r.requestId, chain: r.chain, hash }),
    });
  };

  return (
    <section class="card ink stack narrow">
      <p class="eyebrow">VEIL Nexus request</p>
      <h2>{req.type === "connect" ? `${req.product.name} wants you to sign in` : `${req.product.name} is asking for a payment`}</h2>
      <dl class="kv">
        <dt>Site</dt><dd class="mono">{req.product.origin}</dd>
        {req.type === "pay" && [<dt>Amount</dt>, <dd>{req.amount} {req.asset} on {req.chain}</dd>, <dt>To</dt>, <dd class="mono">{req.to}</dd>, <dt>For</dt>, <dd>{req.memo || "—"}</dd>]}
      </dl>
      <p class="small muted">Nothing happens until you review and approve the next screen.</p>
      <div class="grid two">
        <button class="btn block" onClick={() => { reply(req.product.origin, { type: req.type, error: "rejected" }); onDone(); }}>Decline</button>
        <button class="btn solid block" disabled={busy} onClick={() => (req.type === "connect" ? connect(req) : pay(req))}>Continue</button>
      </div>
    </section>
  );
}
