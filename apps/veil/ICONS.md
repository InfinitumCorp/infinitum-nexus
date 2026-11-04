# VEIL Icons

Manifest references:
- icon16.png
- icon32.png
- icon48.png
- icon128.png

Source SVG: `icon.svg`

PNG generation (local):
```bash
magick icon.svg -resize 16x16 icon16.png
magick icon.svg -resize 32x32 icon32.png
magick icon.svg -resize 48x48 icon48.png
magick icon.svg -resize 128x128 icon128.png
```

If the PNGs in the repo were uploaded as base64 text, regenerate them locally with ImageMagick and replace the files before loading the extension.
