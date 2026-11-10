# re:filter geosite.dat

`geosite.dat` from the re:filter release `07112026`
(https://github.com/1andrevich/Re-filter-lists/releases/tag/07112026), MIT.

- sha256: `891ca95e27d6fad0afdae59c6a9397e636c10510c4690caa18a89e8f0f68d733`
- Category used: `refilter` (domains blocked in Russia).

This file is not shipped in the extension. `node apps/veil/scripts/geosite-ru.js third_party/re-filter/geosite.dat 07112026` (from the repository root)
regenerates `lib/region-blocks.js` from it. To update, replace the file with a newer release asset, update the tag
and checksum here, and rerun the script.
