# VEIL Packaging

## Unpacked load
Select the `apps/veil` directory in `chrome://extensions` (Developer mode).

## Zip for distribution
From the monorepo root:
```sh
cd apps/veil
zip -r ../../veil-extension.zip . -x "*.ts" "*.test.ts" "NEXT.md"
```

## Icon
Add `icon.png` (48x48 or larger) and restore the `icons` key in `manifest.json`.
A simple SVG can be converted with ImageMagick or online tools.

## CRX (optional)
Use the Chrome Web Store developer dashboard or `crx3` tooling after signing.

Current version: 0.2.0
