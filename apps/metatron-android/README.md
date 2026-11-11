# METATRON¹⁰⁰ for Android

A full-screen WebView app for https://mttrn.app (`com.infinitum.metatron`).

- Pages on mttrn.app are served from the bundled copy in `assets/site`, under the real `https://mttrn.app` origin. The app therefore opens on networks where Cloudflare is unreachable, such as Russia without a VPN. Anything not bundled goes to the network.
- Cumulus://ID sign-in and Stripe checkout stay in the app. Other sites open in the browser.
- To refresh the bundled site, copy the metatron-site `public/` folder over `assets/site/`.

## Build

Gradle-free: aapt2 → javac → d8 → zipalign → apksigner, using the debug keystore.

```bash
bash build.sh
```

The output is `build/metatron.apk`.

## Icon

The icon is M¹⁰⁰™ in Arial, ink #111820 on white, as an adaptive icon. Regenerate it with `tools/m100.mjs` (needs `opentype.js` and `@resvg/resvg-js`):

```bash
node tools/m100.mjs res preview.png
```

`tools/m100mark.mjs` renders the same path as a tight black-on-transparent PNG. THRONE][OS uses that PNG for its `ic_mark_metatron`.
