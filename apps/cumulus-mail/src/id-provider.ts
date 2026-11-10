/**
 * Mail's copy of "Sign in with Cumulus://ID".
 *
 * The client list and the routes live in @infinitum/cid so id.cumuluscloud.app and this host
 * agree on who may receive a code. This host does not pass a signing key: tokens stay opaque
 * session bearers, which is what buttons already deployed against mail.cumuluscloud.app expect.
 *
 * Identities created here are Mail's own store. A Cumulus://ID created at id.cumuluscloud.app
 * lives in that Worker's NexusStore. Products that want one cid should call
 * https://id.cumuluscloud.app (see docs/cumulus-id.md). This alias keeps working either way.
 */
export { ID_CLIENTS, idClientFor, type IdClient } from "@infinitum/cid";
export { registerProductIdp as registerIdProvider, type ProductIdpHelpers } from "@infinitum/cid";
