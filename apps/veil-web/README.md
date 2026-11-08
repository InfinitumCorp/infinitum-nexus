# VEIL web app

A static PWA (no framework) for infinitumveil.app. It is hosted as a Cloudflare Worker with static assets (`cloudflare.config.ts`, `wrangler.config.ts`, assets in `public/`).

- Downloads: the Android APK and the Chrome extension zip (`public/downloads/`).
- Tor connection check (links to the Tor Project's own check page) and Orbot.
- Link cleaner using the extension's tracker list.
- The $VEIL rewards summary and the ecosystem apps.
- The page also ships inside the Android app as its offline Hub. It detects when it runs there and switches to in-app mode.

`node scripts/build.js` regenerates `public/lib/trackers.js` (from `apps/veil/lib/privacy.js`) and the icons. Security headers are in `public/_headers`: strict CSP, `no-referrer`, `nosniff`, `X-Frame-Options: DENY`, HSTS, and the APK content type.

## Deploy (needs approval: production)

    pnpm --filter @infinitum/veil-web deploy     # build.js + cf deploy -> Worker "infinitum-veil-web"

Then attach the custom domain `infinitumveil.app` to the Worker (Workers & Pages -> infinitum-veil-web -> Settings -> Domains & Routes). This creates the DNS record in the Cloudflare zone. `/api/veil/*` (the control plane, part of Spectre) isn't served here yet.

Until the cutover, a temporary copy runs on Vercel (https://veil-web-nine.vercel.app). `vercel.json` stays in the repo until the domain is live on Cloudflare.
