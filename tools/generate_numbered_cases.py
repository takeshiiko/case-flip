#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


DEFAULT_FONT = "/System/Library/Fonts/Supplemental/Arial Black.ttf"


def fit_font(text, font_path, max_width, max_height, start_size):
    size = start_size
    while size > 8:
        font = ImageFont.truetype(font_path, size)
        box = ImageDraw.Draw(Image.new("RGBA", (1, 1))).textbbox((0, 0), text, font=font, stroke_width=max(2, size // 34))
        if box[2] - box[0] <= max_width and box[3] - box[1] <= max_height:
            return font
        size -= 2
    return ImageFont.truetype(font_path, size)


def draw_centered_number(image, number, box, font_path, pad_ratio, digits):
    draw = ImageDraw.Draw(image)
    x1, y1, x2, y2 = box
    width = x2 - x1
    height = y2 - y1
    pad_x = int(width * pad_ratio)
    pad_y = int(height * pad_ratio)
    text = str(number).zfill(digits)

    font = fit_font(
        text,
        font_path,
        width - pad_x * 2,
        height - pad_y * 2,
        int(height * 0.9),
    )

    stroke = max(2, font.size // 32)
    text_box = draw.textbbox((0, 0), text, font=font, stroke_width=stroke)
    text_w = text_box[2] - text_box[0]
    text_h = text_box[3] - text_box[1]
    tx = x1 + (width - text_w) / 2 - text_box[0]
    ty = y1 + (height - text_h) / 2 - text_box[1]

    shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.text((tx + stroke * 1.2, ty + stroke * 1.2), text, font=font, fill=(0, 0, 0, 165), stroke_width=stroke, stroke_fill=(0, 0, 0, 180))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=max(1.2, stroke * 0.55)))
    image.alpha_composite(shadow)

    draw = ImageDraw.Draw(image)
    draw.text(
        (tx, ty),
        text,
        font=font,
        fill=(5, 6, 4, 255),
        stroke_width=stroke,
        stroke_fill=(210, 215, 196, 210),
    )


def write_metadata(out_dir, token_id, image_name, name_prefix, description, include_attributes, digits):
    # `digits` drives both the number printed on the case and the name here, so
    # the artwork and the metadata cannot drift apart again.
    serial = str(token_id).zfill(digits)
    metadata = {
        "name": f"{name_prefix} #{serial}",
        "description": description,
        "image": image_name,
    }
    if include_attributes:
        metadata["attributes"] = [
            {"trait_type": "Serial", "value": serial},
            {"trait_type": "State", "value": "Unrevealed"},
        ]
    metadata_path = out_dir / "metadata" / f"{token_id}.json"
    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=True, indent=2), encoding="utf-8")


def save_image(image, path, output_format, quality):
    if output_format in ("jpg", "jpeg"):
        image.convert("RGB").save(path, quality=quality, optimize=True, progressive=True)
    elif output_format == "webp":
        image.convert("RGB").save(path, quality=quality, method=6)
    else:
        image.save(path, optimize=True)


def main():
    parser = argparse.ArgumentParser(description="Generate numbered case NFT images.")
    parser.add_argument("--base", required=True, help="Path to a blank base PNG without the old number.")
    parser.add_argument("--out", required=True, help="Output directory.")
    parser.add_argument("--start", type=int, default=1)
    parser.add_argument("--end", type=int, default=10000)
    parser.add_argument("--digits-box", default="595,448,940,610", help="x1,y1,x2,y2 number placement box.")
    parser.add_argument("--font", default=DEFAULT_FONT)
    parser.add_argument("--pad-ratio", type=float, default=0.04)
    parser.add_argument("--digits", type=int, default=4)
    parser.add_argument("--size", type=int, default=0, help="Resize square output to this size, e.g. 1024.")
    parser.add_argument("--format", choices=["png", "jpg", "jpeg", "webp"], default="png")
    parser.add_argument("--quality", type=int, default=92)
    parser.add_argument("--metadata", action="store_true")
    parser.add_argument("--metadata-only", action="store_true", help="Skip rendering; rewrite metadata only (use after the image CID is known).")
    parser.add_argument("--image-base", default="ipfs://REPLACE_CID/", help="Prefix for the metadata image field, e.g. ipfs://<cid>/ or ipfs://<cid>/images/")
    parser.add_argument("--include-attributes", action="store_true")
    parser.add_argument("--name-prefix", default="Case Flip")
    parser.add_argument(
        "--description",
        default="Case Flip is a 20,000-piece mystery case collection on Robinhood Chain. Each NFT starts sealed and can be revealed after sellout to uncover a prize result, with eligible rewards paid automatically to the holder's wallet.",
    )
    args = parser.parse_args()

    base_path = Path(args.base)
    out_dir = Path(args.out)
    image_dir = out_dir / "images"
    image_dir.mkdir(parents=True, exist_ok=True)

    box = tuple(int(v.strip()) for v in args.digits_box.split(","))
    if len(box) != 4:
      raise ValueError("--digits-box must be x1,y1,x2,y2")

    base = Image.open(base_path).convert("RGBA")
    if args.size:
        base = base.resize((args.size, args.size), Image.Resampling.LANCZOS)
        scale = args.size / max(Image.open(base_path).size)
        box = tuple(round(v * scale) for v in box)

    extension = "jpg" if args.format == "jpeg" else args.format
    image_base = args.image_base if args.image_base.endswith("/") else args.image_base + "/"
    write_meta = args.metadata or args.metadata_only

    for token_id in range(args.start, args.end + 1):
        image_name = f"{token_id}.{extension}"
        if not args.metadata_only:
            image = base.copy()
            draw_centered_number(image, token_id, box, args.font, args.pad_ratio, args.digits)
            save_image(image, image_dir / image_name, args.format, args.quality)
        if write_meta:
            write_metadata(
                out_dir,
                token_id,
                f"{image_base}{image_name}",
                args.name_prefix,
                args.description,
                args.include_attributes,
                args.digits,
            )

        if token_id % 250 == 0 or token_id == args.end:
            print(f"generated {token_id}")


if __name__ == "__main__":
    main()
