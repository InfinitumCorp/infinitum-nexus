# Cumulus dashboards as code

`build_bundle.py` writes the Superset v1 import bundle for the platform's dashboards. UUIDs are
fixed, so every environment has the same ones and re-importing updates in place.

| Dashboard | UUID | Data | Embeddable |
|---|---|---|---|
| Product activity | `3690a391-0b11-5f9a-a2f2-59cd7e2e570a` | `data_platform.events_bi` (no text, payload or CID) | Yes |
| Data quality | `3d83ccfe-0c46-52c2-aedf-dc3a0fadcc12` | `data_platform.quality_runs` (check names and numbers) | No, Cumulus ID sign-in only |
| Documents | `03578c58-943e-579a-b6e3-3c15537a9b48` | `data_platform.documents_bi` (counts and dates; no titles, bodies or people) | No, Cumulus ID sign-in only |

Datasets on an embeddable dashboard must have `product` and `tenant` columns, because the
gateway's guest tokens pin `product = .. AND tenant = ..` to every chart. A test
(`privacy-gateway/tests/test_superset_bundle.py`) enforces it, and CI imports the bundle into
Superset 6.1 on every change.

## Import (needs William's OK for a shared Superset)

```sh
python3 superset/dashboards/build_bundle.py cumulus-dashboards.zip
docker compose --profile bi cp cumulus-dashboards.zip superset:/tmp/
docker compose --profile bi exec superset superset import-dashboards -p /tmp/cumulus-dashboards.zip -u <your Superset user>
```

The bundle connects as `data_platform_reader` with **no password** (the repo is public). Set
the host with `CUMULUS_BI_DATABASE_URI` (without a password), and the password once in
Superset under Settings > Database connections.

## Embed in a product

1. In Superset, open **Product activity** > ... > Embed dashboard. Add the product's origin and
   copy the **embedded** ID (it differs from the dashboard UUID).
2. Add it to the gateway: `PLATFORM_EMBED_DASHBOARDS="spectre=<embedded id>"`.
3. The product backend calls `createGuestToken(<embedded id>, tenant, cid)` (TypeScript client)
   and hands the token to the Superset embedded SDK's `fetchGuestToken`.
