# ÆTHER™ threat model — v0

Scope: the mesh protocol in `src/` (packet format, flooding, store-and-forward).
Apps, relays, tokens and ÆTHER™ MIL get their own threat models when built.

## Assets

1. Message integrity and sender authenticity.
2. Message confidentiality (not yet provided — see gaps).
3. Delivery: the mesh keeps carrying messages under churn and abuse.
4. Metadata: who talks to whom, when, and where.
5. Device keys.

## Adversaries

| Adversary | Can | Cannot (by design) |
| --- | --- | --- |
| Passive listener in radio range | Read every packet, see src, dst, size, timing | Forge or alter packets |
| Malicious relay node | Drop, delay, replay, lower TTL, lie about hops | Forge sender, change dst or payload |
| Flooder | Send many valid packets from its own keys | Exhaust honest nodes beyond the per-source rate limit |
| Sybil (many keys) | Bypass the per-source limit with fresh keys | — gap, see below |
| Thief with an unlocked device | Use the device key | — gap, see below |

## Controls in v0

| Threat | Control |
| --- | --- |
| Forged sender, altered payload | Ed25519 signature over everything except ttl/hops |
| Forged copy blocking the real message | Seen cache updated only after the signature verifies |
| Replay of old packets | Seen cache (24 h) plus timestamp window: older than the store window is dropped |
| Packets from the far future | Rejected beyond 5 minutes of clock skew |
| Flooding from one key | Token-bucket limit per source key |
| Memory exhaustion | Bounded seen cache, bounded store, 4096-byte payload cap |
| Endless forwarding | TTL capped at 32, decremented every hop |
| Relay raising ttl to force re-floods | A copy is re-forwarded only when its ttl beats the best seen, so at most 32 times per id per node; acknowledged messages never |

## Known gaps (must close before public beta, M6)

1. **No confidentiality.** Anyone in range reads payloads. Fix: Noise XX link
   layer and audited end-to-end encryption library.
2. **Metadata in clear.** src and dst are visible. Mitigation later: per-session
   ephemeral addresses; full protection is out of scope for v1.
3. **Sybil flooding.** Fresh keys reset the rate limit. Fix: per-link limits,
   proof-of-work or enrolled-key priority, decided in M2.
4. **Relay misbehaviour.** A relay can drop everything. Flooding over multiple
   paths limits the damage; there is no reputation system yet.
5. **Key storage.** Keys live in process memory in tests. Apps must use the
   Android Keystore / Secure Enclave (M2).
6. **Receipts leak delivery timing.** Acceptable for v1; receipts will be
   optional per conversation.

## Review

The external security review in M6 covers this document, the spec and the code.
