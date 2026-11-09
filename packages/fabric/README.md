# @infinitum/fabric

FABRIC++ encrypted messaging. Message bodies use AES-256-GCM. A string key is stretched with scrypt (`encrypt` / `decrypt`). A 32-byte key uses `seal` / `open`, and optional associated data is bound into the authentication tag.

The running service and web client live in `apps/fabric`.

## Domain

The product domain is `infinitumfabric.app`, hosted at Cloudflare. `fabricRootDomain()` reads `FABRIC_ROOT_DOMAIN`. When that variable is unset, the default is `infinitumfabric.app`.

The value must be a bare hostname, such as `infinitumfabric.app`. A scheme, port, path, query, userinfo, wildcard, or IP address is rejected. The public origin is the exact `https://` URL of that hostname. The default origin is `https://infinitumfabric.app`. It is never a wildcard origin.

```sh
pnpm --filter @infinitum/fabric test
pnpm --filter @infinitum/fabric typecheck
```
