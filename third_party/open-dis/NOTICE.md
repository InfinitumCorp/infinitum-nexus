# Open-DIS JavaScript

Upstream: https://github.com/open-dis/open-dis-javascript
License: BSD-2-Clause (see LICENSE). Copyright (c) 2014, mcgredonps. The PDU sources also carry the Naval Postgraduate School MOVES Institute copyright.

`dis6.js` is the upstream `src/dis` and `src/disSupporting` sources concatenated in the same order as their build. The two `require('long')` calls point at `long.js`, which is `long@3.2.0` (Apache-2.0, see LONG-LICENSE).

`@infinitum/autonomy` uses this for IEEE 1278.1 entity-state position reports only. Fire, detonation, minefield, and designator PDUs are in the library because they are part of the protocol, and nothing in Infinitum calls them.
