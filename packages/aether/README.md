# @infinitum/aether

ÆTHER™ mesh protocol core (milestones M0–M1 of the ÆTHER™ Build Plan).

**Deployed:** not deployed. This is a library; device apps and relays that use it will deploy on their own (relays on Cloudflare Workers, per //RULES//).

- `docs/SPEC.md` — wire format v1 and node behaviour
- `docs/THREAT-MODEL.md` — what v0 protects, and the gaps to close before beta
- `src/identity.ts` — Ed25519 device keys; the public key is the node address
- `src/packet.ts` — signed packet codec (ttl/hops left unsigned for relays)
- `src/node.ts` — `MeshNode`: flooding with TTL and dedup, ttl upgrades, store-and-forward, receipts, rate limits
- `src/transport.ts` — the interface BLE, Wi-Fi Direct, LoRa and relay transports implement
- `src/sim/` — deterministic radio simulator and scenarios

```sh
pnpm --filter @infinitum/aether test
pnpm --filter @infinitum/aether sim -- --nodes 100 --churn 0.2 --min-hops 6 --seed 7
```

M1 exit result: 100 nodes, 20% of them offline at any moment, 2% frame loss, sender and
recipient 6–13 hops apart: 1,100 of 1,100 messages delivered across 11 seeds, p95 delivery
time 2.5–5.6 minutes (the time is spent waiting for offline relays to come back).

**Not encrypted yet.** Payloads are signed, not confidential. Noise XX link encryption and an
audited end-to-end library come next; do not carry private content until then.
