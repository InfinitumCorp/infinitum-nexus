# Drone backend scope, research and provenance

Infinitum Corporation® — research checked 2026-11-07. Repository work only.
No marketing-site modifications, Vercel changes, deployment or merge.

## Infinitum product mapping

Evidence: [`hardware/catalog.ts`](../packages/hardware/src/catalog.ts),
[`autonomy/platforms.ts`](../packages/autonomy/src/platforms.ts),
[`PRODUCT-DELIVERY.md`](../PRODUCT-DELIVERY.md).

| Product | Existing definition | Backend capability in this PR |
|---|---|---|
| DAEMON | Autonomous aircraft family | Air-domain inventory, selected observation archival, historical reads and provenance |
| SLUG | Autonomous land drone | Same, land-domain registration |
| ORBIS | Collision-tolerant spherical drone | Same, air-domain registration; no indoor localization implementation |
| POLLEN | Palm-sized drone swarm | Same, per-unit records only; no swarm-control implementation |
| Flower | Smart base station for POLLEN | Same, base-domain registration; no charging/docking firmware implementation |

NEMESIS appears among hardware concepts in the delivery document, but has no
concrete catalog/profile or planning envelope. No interface or purpose is invented
for it. EON is a wearable and ARGUS a separate sensor product, not fleet vehicles.
The supplied website-source product pages are now generic references rather than
usable specifications; only existing repository product definitions are used.

## Public Ukraine-war platform inventory — background only

This is a high-level, non-exhaustive inventory, not procurement, tactical advice
or operational analysis. It records public reporting, not independently verified
current deployment/availability. No combat source code was pulled or integrated.
“No verified stack found” means this review found none; it does not prove absence.

| Publicly reported platform | Maker / attribution | Public reusable aircraft stack verified in this review? | Evidence / repository |
|---|---|---|---|
| SHARK / PD-2 | Ukrspecsystems | No permissively licensed model-specific stack verified | [Reported makers](https://kyivindependent.com/10-ukrainian-drone-makers-to-watch/); [2026 reporting](https://www.france24.com/en/live-news/20260312-from-kyiv-to-uk-ukrainian-drone-production-spans-europe) |
| Raybird | Skyeton | No permissively licensed model-specific stack verified | [Reported makers](https://kyivindependent.com/10-ukrainian-drone-makers-to-watch/) |
| Vampire, often called Baba Yaga | Skyfall | No permissively licensed model-specific stack verified | [Reported makers](https://kyivindependent.com/10-ukrainian-drone-makers-to-watch/) |
| Vector | Quantum Systems | No permissively licensed model-specific stack verified | [Public reporting](https://www.politico.eu/article/germany-drone-quantum-systems-ukraine/); this is not a claim that Vector uses our selected upstream stacks |
| Lancet | ZALA | No reusable permissive aircraft stack verified; no code sought | [Reuters inventory](https://www.reuters.com/world/europe/russia-parade-drones-it-uses-against-ukraine-red-square-state-tv-reports-2025-05-09/) |
| Orlan-10 / Orlan-30; Geran-2 | Russian systems; model/vendor mapping not independently established here | No reusable permissive aircraft stack verified; no code sought | [Reuters inventory](https://www.reuters.com/world/europe/russia-parade-drones-it-uses-against-ukraine-red-square-state-tv-reports-2025-05-09/) |

The implementation below is generic administrative inventory and retrospective
telemetry storage. It does not extend combat drones, operational reconnaissance,
EW-resilient flight, targeting, guidance, autonomy or weapons delivery.

## Public stack review and exact provenance

Only public PX4 and MAVSDK repositories were cloned, sparsely, into a research
scratch directory outside Nexus; no submodules/vendor code were imported. We
studied telemetry unit conventions and unknown-value handling, not operational
control plugins. No upstream runtime dependency was added.

| Source | Revision / license reviewed | What was applied |
|---|---|---|
| [PX4/PX4-Autopilot](https://github.com/PX4/PX4-Autopilot) | `95a0c23482329183d932ac99da00faa7e8d63143`, root BSD-3-Clause; individual file header reviewed | [GLOBAL_POSITION_INT stream](https://github.com/PX4/PX4-Autopilot/blob/95a0c23482329183d932ac99da00faa7e8d63143/src/modules/mavlink/streams/GLOBAL_POSITION_INT.hpp) confirms degree/metre/NED wire scaling. No code copied. |
| [mavlink/MAVSDK](https://github.com/mavlink/MAVSDK) | `3bde667fc2bf5f621bd14a48451a467f3efe6a38`, BSD-3-Clause | [Telemetry implementation](https://github.com/mavlink/MAVSDK/blob/3bde667fc2bf5f621bd14a48451a467f3efe6a38/cpp/src/mavsdk/plugins/telemetry/telemetry_impl.cpp) confirms position units and unknown-heading handling. Independent TS decoder uses null. No code copied. |
| [MAVLink serialization specification](https://mavlink.io/en/guide/serialization.html) and [common messages](https://mavlink.io/en/messages/common.html) | Published wire-format facts; [FAQ](https://mavlink.io/en/about/faq.html) distinguishes MIT generated headers | Independent bounded v1/v2 parsing with CRC_EXTRA and v2 zero restoration. No generated headers, XML files or generator code vendored. Test CRC oracle uses a separate bit-at-a-time recurrence and standard check value. |
| [ArduPilot](https://github.com/ArduPilot/ardupilot) | GPLv3 family; excluded | No source copied, dependency added or firmware adaptation made. |
| [QGroundControl](https://github.com/mavlink/qgroundcontrol) / [Auterion](https://github.com/Auterion) | Not assumed permissive as a whole; review file-specific licenses before any future reuse | No source/dependency imported and no proprietary Auterion product code sought. |

Root repo licensing does not guarantee every submodule is identically licensed.
The two research checkouts were not vendored. Attribution here acknowledges source
review, not endorsement or aircraft compatibility certification.

## Requested company survey: public does not mean reusable

| Company | Verified public surface | Decision |
|---|---|---|
| Palantir | [Official collection](https://palantir.github.io/), [Blueprint Apache-2.0 license](https://github.com/palantir/blueprint/blob/master/LICENSE) | Blueprint is UI and irrelevant to backend-only work. No Palantir dependency/source copied. Simple typed inventory records and commit lineage are independent generic data-management patterns, not a Foundry/Ontology implementation. |
| Anduril | [Public organization](https://github.com/anduril), [Lattice SDK license](https://raw.githubusercontent.com/anduril/lattice-sdk-python/master/LICENSE) | Reviewed license limits SDK use to compatible Lattice implementations; not a permissive open-source license. No SDK or military task/entity application code copied, cloned or integrated. |
| SpaceX | [SpaceExplorationTechnologies](https://github.com/SpaceExplorationTechnologies), [Starlink router repository](https://github.com/SpaceExplorationTechnologies/starlink-wifi) | Search results identify GPL router releases; the indexed gen2 release URL and raw-file lookups returned 404 during direct checks, so current gen2 contents were not verified. No router code is imported or treated as permissive; no proprietary payload application code was sought. `github.com/spacex` is an unrelated personal account, not provenance for SpaceX technology. No Starlink/mesh-routing implementation claimed. |
| Mach Industries | [Public verified organization](https://github.com/machindustries) showed zero public repositories in this review | No code available to reuse was verified; no similarly named company/person repository substituted. |

## Capability-level provenance

- Inventory and product namespaces: existing Infinitum hardware catalog plus
  independent JSON schema/API code; no third-party implementation copied.
- Selected flight observations: published MAVLink protocol facts, cross-checked
  against permissive PX4/MAVSDK telemetry source; independent decoder, no new
  external dependency or license notice copied into production source.
- Versioned storage and provenance: existing CID/Labyrinth commit/CAS model from
  PR #26; independent product-filtered lineage view. Not Palantir or Anduril code.
- Authorization: existing opaque CID session verification plus explicit repository
  roles, consent and separate paid-plan authority. No identity-header shortcuts.

Operational mission planning, autonomous deconfliction, swarm control, combat
sensor/entity fusion, EW-resilient communications and weapon-specific adaptations
are deliberately not implemented. Existing autonomy packages remain unchanged.

## Verification and remaining work

The new package tests protocol corruption/length/signature rejection, units,
sentinels, caps, real CID passkey sessions, revocation/expiry, paid-plan denial,
consent denial, cross-org/product isolation, CAS conflicts and historical artifact
reads. Two real HTTP host regressions cover mounted routes and unconfigured fail-
closed behavior. Final verification: **449 workspace tests pass**, including **18**
new package tests and **2** new host-route tests; all workspace typechecks pass.
Semgrep `p/typescript` + `p/security-audit`: **0 findings**, 89 applicable rules
across all 9 changed/new TypeScript files; no scan errors. Commands exited 0.

No aircraft, radio, device, fleet, SITL or external CID service was contacted.
Only simulator/admin backend behavior is verified. Hardware gateway enrollment,
protocol signing support, other dialects, `.ulg`/`.bin` import, durable distributed
storage, KMS/backups, ingress controls and production operations remain gaps.
