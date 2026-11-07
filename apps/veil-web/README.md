# VEIL web app

Static PWA (no framework, no build step on Vercel), live at https://veil-web-nine.vercel.app (Vercel project `i-nfinitum-corporation/veil-web`).

- Downloads: the Android APK and the Chrome extension zip (`public/downloads/`).
- Tor connection check (links to the Tor Project's own check page) and Orbot.
- Link cleaner using the extension's tracker list.
- The $VEIL rewards summary and the ecosystem apps.
- The page also ships inside the Android app as its offline Hub. It detects when it runs there and switches to in-app mode.

`node scripts/build.js` regenerates `public/lib/trackers.js` (from `apps/veil/lib/privacy.js`) and the icons. Deploy from this folder with `vercel deploy --prod`. `vercel.json` sets a strict CSP, `no-referrer`, HSTS and the APK content type.
