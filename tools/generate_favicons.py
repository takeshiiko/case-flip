#!/usr/bin/env python3
"""Favicons drawn at each target size rather than downscaled from the 1024 mark.

Downscaling the full mark turns to mush at 16px: the outer frame, the briefcase
outline and the glow all collapse into each other. So the small sizes drop the
frame and the glow and thicken the strokes, and the tiniest one switches to a
filled silhouette, which is the only thing that stays legible in a browser tab.
"""

from PIL import Image, ImageDraw, ImageFilter
from pathlib import Path

OUT = Path("/Users/metin/robinhood-mint-site/assets")
VOLT = (232, 255, 0, 255)
INK = (3, 5, 0, 255)


def briefcase_outline(d, ox, oy, size, stroke):
    """The same 24-unit geometry as the site's SVG."""
    s = size / 24.0
    p = lambda vx, vy: (ox + vx * s, oy + vy * s)
    d.rectangle([p(2.5, 7.5), p(21.5, 19.5)], outline=VOLT, width=stroke)
    d.line([p(9, 7.5), p(9, 5.5), p(15, 5.5), p(15, 7.5)], fill=VOLT, width=stroke, joint="curve")
    d.line([p(2.5, 13.5), p(21.5, 13.5)], fill=VOLT, width=stroke)


def briefcase_filled(d, ox, oy, size):
    """Solid silhouette — the only version that survives 16px."""
    s = size / 24.0
    p = lambda vx, vy: (ox + vx * s, oy + vy * s)
    d.rectangle([p(2.5, 7.5), p(21.5, 19.5)], fill=VOLT)
    d.rectangle([p(9, 5), p(15, 7.5)], fill=VOLT)
    # dark seam so the shape still reads as a case, not a blob
    d.rectangle([p(2.5, 12.8), p(21.5, 14.2)], fill=INK)
    # Hollowing the grip only helps if the hole lands on real pixels. At 16px the
    # handle is barely a pixel tall, so the hole antialiases into a grey gap that
    # reads as a detached bar — a solid tab is clearer there.
    if (7.5 - 5) * s >= 3:
        d.rectangle([p(10.2, 5.9), p(13.8, 6.9)], fill=INK)


def make(size, framed, glow):
    img = Image.new("RGBA", (size, size), INK)
    ink = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(ink)

    if framed:
        box = round(size * 0.70)
        o = (size - box) // 2
        d.rectangle([o, o, o + box - 1, o + box - 1], outline=VOLT, width=max(1, round(size * 0.016)))
        art = box * 0.80
        s = art / 24.0
        briefcase_outline(d, (size - 19 * s) / 2 - 2.5 * s, (size - 14 * s) / 2 - 5.5 * s,
                          art, max(1, round(size * 0.026)))
    else:
        art = size * 0.86
        s = art / 24.0
        ox, oy = (size - 19 * s) / 2 - 2.5 * s, (size - 14 * s) / 2 - 5.5 * s
        if size <= 20:
            briefcase_filled(d, ox, oy, art)
        else:
            briefcase_outline(d, ox, oy, art, max(2, round(size * 0.075)))

    if glow:
        tint = Image.new("RGBA", (size, size), VOLT[:3] + (0,))
        a = ink.getchannel("A").filter(ImageFilter.GaussianBlur(size * 0.035))
        tint.putalpha(a.point(lambda v: int(v * 0.4)))
        img = Image.alpha_composite(img, tint)

    return Image.alpha_composite(img, ink)


def write_ico(path, images):
    """Pillow's ICO writer rescales one source image for every entry, which is
    exactly what ruins the small sizes. Modern .ico can embed PNGs directly, so
    the container is assembled by hand and each entry keeps its own render."""
    import io, struct

    blobs = []
    for im in images:
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        blobs.append(buf.getvalue())

    header = struct.pack("<HHH", 0, 1, len(images))
    offset = len(header) + 16 * len(images)
    entries, body = b"", b""
    for im, blob in zip(images, blobs):
        w = 0 if im.width >= 256 else im.width
        h = 0 if im.height >= 256 else im.height
        entries += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
        body += blob

    path.write_bytes(header + entries + body)


# small = no frame, no glow (they only add noise); large = full brand mark
ico_sizes = [16, 24, 32, 48]
write_ico(OUT / "favicon.ico", [make(s, framed=False, glow=False) for s in ico_sizes])

make(32, framed=False, glow=False).save(OUT / "favicon-32.png")
make(180, framed=True, glow=True).save(OUT / "apple-touch-icon.png")
make(192, framed=True, glow=True).save(OUT / "icon-192.png")
make(512, framed=True, glow=True).save(OUT / "icon-512.png")

for f in ["favicon.ico", "favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png"]:
    p = OUT / f
    print(f"  {f:<22} {p.stat().st_size // 1024 if p.stat().st_size > 1024 else p.stat().st_size}{'KB' if p.stat().st_size > 1024 else 'B'}")
