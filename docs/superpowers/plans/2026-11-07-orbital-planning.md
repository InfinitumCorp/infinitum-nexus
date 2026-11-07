# Offline Orbital Planning Backend Plan

**Base:** PR #28. New branch feat/orbital-planning.
**Goal:** Validated public orbital elements, SGP4-based offline states/passes, deterministic proposed station schedules, illustrative free-space budgets and private STAC-style artifact metadata for Firmament Network and ORBIS.
**Architecture:** Pin MIT satellite.js; strict independent input validation and bounded pure planners; CID/Labyrinth-authenticated backend plus explicit-bearer host route. Propagation uses fresh satellite records, labels TEME correctly and limits time distance from element epoch. All proposed schedules remain simulation-only and require operator review.

- [x] Pin dependency/license and reference-vector provenance; include NOTICE/MIT license.
- [x] Write failing element/propagation tests using published Vallado vectors. Implement checksum/range/epoch/OMM-convention validation; reject unsupported precision/catalog formats rather than silently coerce.
- [x] Write tests then implement bounded pass prediction with refined threshold crossings, clipped-window flags and coarse-peak refinement.
- [x] Implement deterministic priority/interval proposal scheduling with station/satellite conflicts and turnaround guard; free-space link-budget calculator with explicit assumptions.
- [x] Implement CID/plan/consent/role-gated artifact commands and STAC-style catalog links to verified private Labyrinth artifacts; product namespaces only firmament/orbis.
- [x] Mount explicit-bearer backend route in existing CID host; add callable client and real HTTP/security tests. No cyclic dependency from base Firmament package.
- [x] Run complete tests, typecheck, dependency audit and Semgrep. Document numerical/operational limitations and prepare the stacked PR for publication; publication status is reported separately. Never merge/deploy or change the site.
