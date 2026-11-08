"""Draws the Cumulus://Mail icon (the "://" mark) as PNGs for the web app and the Android app.

    python apps/cumulus-mail/scripts/make-icons.py

Same shapes as public/icon.svg. Writes public/icon-192.png, public/icon-512.png,
public/icon-maskable-512.png and the Android launcher icons under android/res/mipmap-*.
"""
import math
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
INK = (20, 22, 25, 255)
WHITE = (255, 255, 255, 255)
SS = 4  # supersampling for smooth edges


def mark(draw, size, scale=1.0):
    """The "://" glyph centred in a size x size canvas, shrunk by scale (for maskable safe zones)."""
    u = size / 512 * scale
    off = size * (1 - scale) / 2
    p = lambda x, y: (off + x * u, off + y * u)
    for cy in (200, 312):
        x, y = p(150, cy)
        r = 30 * u
        draw.ellipse([x - r, y - r, x + r, y + r], fill=WHITE)
    for cx in (248, 340):
        # A rounded bar 44 x 240, rotated 22 degrees about its centre.
        a = math.radians(22)
        half_len, half_w = 120 * u, 22 * u
        dx, dy = math.sin(a) * half_len, -math.cos(a) * half_len
        x, y = p(cx, 256)
        draw.line([(x - dx, y - dy), (x + dx, y + dy)], fill=WHITE, width=round(2 * half_w))
        for ex, ey in ((x - dx, y - dy), (x + dx, y + dy)):
            draw.ellipse([ex - half_w, ey - half_w, ex + half_w, ey + half_w], fill=WHITE)


def icon(size, rounded=True, scale=1.0, round_full=False):
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if round_full:
        d.ellipse([0, 0, big - 1, big - 1], fill=INK)
    elif rounded:
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=round(big * 112 / 512), fill=INK)
    else:
        d.rectangle([0, 0, big, big], fill=INK)
    mark(d, big, scale)
    return img.resize((size, size), Image.LANCZOS)


def save(img, *parts):
    path = os.path.join(APP, *parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True)
    print("wrote", os.path.relpath(path, APP))


save(icon(192), "public", "icon-192.png")
save(icon(512), "public", "icon-512.png")
save(icon(512, rounded=False, scale=0.72), "public", "icon-maskable-512.png")
for name, px in {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}.items():
    save(icon(px), "android", "res", f"mipmap-{name}", "ic_launcher.png")
    save(icon(px, round_full=True, scale=0.9), "android", "res", f"mipmap-{name}", "ic_launcher_round.png")
