/**
 * Content-Security-Policy for files the cumulus-id Worker serves from public/.
 * This is the policy https://id.cumuluscloud.app sends today. style-src allows
 * 'unsafe-inline' because the CRM shell sets style attributes. Nothing else is loosened:
 * scripts stay on 'self', and base-uri, form-action and framing stay closed.
 */
export const STATIC_ASSET_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
