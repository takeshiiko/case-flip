#!/usr/bin/env python3
import argparse
import csv
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


DEFAULT_HEAVY_FONT = "/System/Library/Fonts/Supplemental/Arial Black.ttf"
DEFAULT_BOLD_FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"


def parse_box(value):
    box = tuple(int(v.strip()) for v in value.split(","))
    if len(box) != 4:
        raise ValueError("box must be x1,y1,x2,y2")
    return box


def scale_box(box, scale):
    return tuple(round(v * scale) for v in box)


def fit_font(text, font_path, max_width, max_height, start_size, stroke_width=0):
    size = start_size
    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    while size > 8:
        font = ImageFont.truetype(font_path, size)
        box = probe.textbbox((0, 0), text, font=font, stroke_width=stroke_width)
        if box[2] - box[0] <= max_width and box[3] - box[1] <= max_height:
            return font
        size -= 2
    return ImageFont.truetype(font_path, size)


def centered_text(draw, text, box, font, fill, stroke_width=0, stroke_fill=None):
    x1, y1, x2, y2 = box
    text_box = draw.textbbox((0, 0), text, font=font, stroke_width=stroke_width)
    text_w = text_box[2] - text_box[0]
    text_h = text_box[3] - text_box[1]
    x = x1 + ((x2 - x1) - text_w) / 2 - text_box[0]
    y = y1 + ((y2 - y1) - text_h) / 2 - text_box[1]
    draw.text((x, y), text, font=font, fill=fill, stroke_width=stroke_width, stroke_fill=stroke_fill)


def reward_label(reward):
    value = str(reward).strip()
    if value in ("", "0", "$0"):
        return "$0"
    return value if value.startswith("$") else f"${value}"


def draw_reward(image, token_id, reward, reward_box, serial_box, heavy_font, bold_font, digits, show_serial):
    reward_text = reward_label(reward)
    reward_layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    shadow_layer = Image.new("RGBA", image.size, (0, 0, 0, 0))

    is_no_prize = reward_text == "$0"
    max_reward_h = reward_box[3] - reward_box[1]
    max_reward_w = reward_box[2] - reward_box[0]
    reward_font = fit_font(
        reward_text,
        heavy_font,
        int(max_reward_w * 0.9),
        int(max_reward_h * 0.52),
        int(max_reward_h * (0.36 if is_no_prize else 0.58)),
        stroke_width=5,
    )

    shadow_draw = ImageDraw.Draw(shadow_layer)
    centered_text(
        shadow_draw,
        reward_text,
        (reward_box[0] + 8, reward_box[1] + 10, reward_box[2] + 8, reward_box[3] + 10),
        reward_font,
        (0, 0, 0, 210),
        stroke_width=max(3, reward_font.size // 22),
        stroke_fill=(0, 0, 0, 210),
    )
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=max(2, reward_font.size * 0.035)))
    image.alpha_composite(shadow_layer)

    reward_draw = ImageDraw.Draw(reward_layer)
    centered_text(
        reward_draw,
        reward_text,
        reward_box,
        reward_font,
        (232, 255, 0, 255) if not is_no_prize else (225, 228, 210, 255),
        stroke_width=max(3, reward_font.size // 24),
        stroke_fill=(8, 10, 6, 255),
    )
    image.alpha_composite(reward_layer)

    if show_serial:
        serial_text = f"CASE #{str(token_id).zfill(digits)}"
        serial_font = fit_font(serial_text, bold_font, serial_box[2] - serial_box[0], serial_box[3] - serial_box[1], 42)
        draw = ImageDraw.Draw(image)
        centered_text(
            draw,
            serial_text,
            serial_box,
            serial_font,
            (8, 10, 6, 238),
            stroke_width=2,
            stroke_fill=(220, 225, 205, 170),
        )


def save_image(image, path, output_format, quality):
    if output_format in ("jpg", "jpeg"):
        image.convert("RGB").save(path, quality=quality, optimize=True, progressive=True)
    elif output_format == "webp":
        image.convert("RGB").save(path, quality=quality, method=6)
    else:
        image.save(path, optimize=True)


def load_rewards(path):
    rewards = {}
    with Path(path).open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            rewards[int(row["token_id"])] = row["reward"]
    return rewards


def write_metadata(out_dir, token_id, image_name, name_prefix, description, digits):
    # Must match the sealed set's padding, or a token renames itself on reveal.
    metadata = {
        "name": f"{name_prefix} #{str(token_id).zfill(digits)}",
        "description": description,
        "image": image_name,
    }
    metadata_path = out_dir / "metadata" / f"{token_id}.json"
    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=True, indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Generate revealed case NFT images.")
    parser.add_argument("--base", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--rewards", required=True, help="CSV with token_id,reward")
    parser.add_argument("--start", type=int, default=1)
    parser.add_argument("--end", type=int, default=10000)
    parser.add_argument("--digits", type=int, default=2)
    parser.add_argument("--size", type=int, default=1024)
    parser.add_argument("--format", choices=["png", "jpg", "jpeg", "webp"], default="jpg")
    parser.add_argument("--quality", type=int, default=92)
    parser.add_argument("--reward-box", default="270,250,985,705")
    parser.add_argument("--serial-box", default="420,870,835,945")
    parser.add_argument("--show-serial", action="store_true")
    parser.add_argument("--metadata", action="store_true")
    parser.add_argument("--metadata-only", action="store_true", help="Skip rendering; rewrite metadata only (use after the image CID is known).")
    parser.add_argument("--image-base", default="ipfs://REVEALED_CID/", help="Prefix for the metadata image field.")
    parser.add_argument("--name-prefix", default="Case Flip")
    parser.add_argument(
        "--description",
        default="Case Flip is a 20,000-piece mystery case collection on Robinhood Chain. Each NFT starts sealed and can be revealed after sellout to uncover a prize result, with eligible rewards paid automatically to the holder's wallet.",
    )
    args = parser.parse_args()

    out_dir = Path(args.out)
    image_dir = out_dir / "images"
    image_dir.mkdir(parents=True, exist_ok=True)

    base_source = Image.open(args.base).convert("RGBA")
    original_size = base_source.size
    base = base_source.resize((args.size, args.size), Image.Resampling.LANCZOS) if args.size else base_source
    scale = (args.size / max(original_size)) if args.size else 1
    reward_box = scale_box(parse_box(args.reward_box), scale)
    serial_box = scale_box(parse_box(args.serial_box), scale)
    rewards = load_rewards(args.rewards)
    extension = "jpg" if args.format == "jpeg" else args.format

    image_base = args.image_base if args.image_base.endswith("/") else args.image_base + "/"
    write_meta = args.metadata or args.metadata_only

    for token_id in range(args.start, args.end + 1):
        image_name = f"{token_id}.{extension}"
        if not args.metadata_only:
            image = base.copy()
            draw_reward(
                image,
                token_id,
                rewards.get(token_id, "0"),
                reward_box,
                serial_box,
                DEFAULT_HEAVY_FONT,
                DEFAULT_BOLD_FONT,
                args.digits,
                args.show_serial,
            )
            save_image(image, image_dir / image_name, args.format, args.quality)
        if write_meta:
            write_metadata(out_dir, token_id, f"{image_base}{image_name}", args.name_prefix, args.description, args.digits)

        if token_id % 250 == 0 or token_id == args.end:
            print(f"generated {token_id}")


if __name__ == "__main__":
    main()
