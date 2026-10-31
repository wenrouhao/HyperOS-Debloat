#!/usr/bin/env python3
"""Process generated logos into transparent versions, multiple sizes, and favicon."""
import os
from PIL import Image, ImageDraw

ASSETS = "/workspace/assets"


def flood_fill_transparent(img, src_color, tolerance=40):
    """Flood-fill from all 4 corners; make near-src_color connected pixels transparent."""
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()
    visited = [[False] * h for _ in range(w)]

    def near(c):
        return all(abs(c[i] - src_color[i]) <= tolerance for i in range(3))

    stack = []
    # seed from all corners and edges
    for x in range(w):
        stack.append((x, 0))
        stack.append((x, h - 1))
    for y in range(h):
        stack.append((0, y))
        stack.append((w - 1, y))

    while stack:
        x, y = stack.pop()
        if x < 0 or x >= w or y < 0 or y >= h:
            continue
        if visited[x][y]:
            continue
        visited[x][y] = True
        r, g, b, a = px[x, y]
        if not near((r, g, b)):
            continue
        px[x, y] = (r, g, b, 0)
        stack.extend([(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)])

    return img


def trim_transparent(img):
    """Crop to the bounding box of non-transparent content."""
    bbox = img.getbbox()
    if bbox:
        return img.crop(bbox)
    return img


def add_padding(img, pad_ratio=0.05):
    """Add equal padding around the image."""
    w, h = img.size
    pad = int(max(w, h) * pad_ratio)
    new = Image.new("RGBA", (w + 2 * pad, h + 2 * pad), (0, 0, 0, 0))
    new.paste(img, (pad, pad), img)
    return new


def make_transparent(src, dst, tolerance=45):
    img = Image.open(src)
    # sample corner color as background
    corners = [img.getpixel((0, 0)), img.getpixel((0, img.size[1] - 1)),
               img.getpixel((img.size[0] - 1, 0)),
               img.getpixel((img.size[0] - 1, img.size[1] - 1))]
    bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))
    img = flood_fill_transparent(img, bg, tolerance)
    img = trim_transparent(img)
    img = add_padding(img, 0.04)
    img.save(dst, "PNG")
    print(f"  -> {dst}")
    return img


def make_sizes(src, base_name, sizes, out_dir):
    """Generate multiple square sizes from a source image."""
    img = Image.open(src)
    results = {}
    for s in sizes:
        out = os.path.join(out_dir, f"{base_name}_{s}x{s}.png")
        resized = img.resize((s, s), Image.LANCZOS)
        resized.save(out, "PNG")
        results[s] = out
        print(f"  -> {out}")
    return results


def make_ico(icon_sizes, ico_path):
    """Create a multi-size .ico file from PNGs."""
    imgs = [Image.open(p).convert("RGBA") for p in icon_sizes.values()]
    imgs[0].save(ico_path, format="ICO", sizes=[(s, s) for s in icon_sizes.keys()])
    print(f"  -> {ico_path}")


def make_favicon_ico(src_icon, ico_path, sizes=(16, 32, 48)):
    img = Image.open(src_icon).convert("RGBA")
    ico_imgs = []
    for s in sizes:
        ico_imgs.append(img.resize((s, s), Image.LANCZOS))
    ico_imgs[0].save(ico_path, format="ICO", sizes=[(s, s) for s in sizes])
    print(f"  -> {ico_path}")


def main():
    os.makedirs(ASSETS, exist_ok=True)

    # 1. Transparent versions
    print("[1] Creating transparent backgrounds...")
    logo_main_trans = os.path.join(ASSETS, "logo_main_transparent.png")
    logo_icon_trans = os.path.join(ASSETS, "logo_icon_transparent.png")
    make_transparent(os.path.join(ASSETS, "logo_main.jpg"), logo_main_trans, tolerance=40)
    make_transparent(os.path.join(ASSETS, "logo_icon.jpg"), logo_icon_trans, tolerance=40)

    # 2. Multi-size icon set (for app icons, web manifest, etc.)
    print("[2] Generating icon size set from transparent icon...")
    icon_sizes = make_sizes(logo_icon_trans, "logo_icon",
                            [16, 32, 48, 64, 128, 192, 256, 512, 1024], ASSETS)

    # 3. Multi-size main logo set
    print("[3] Generating main logo size set...")
    make_sizes(logo_main_trans, "logo_main", [256, 512, 1024], ASSETS)

    # 4. Favicon ICO (multi-size)
    print("[4] Creating favicon.ico...")
    make_favicon_ico(logo_icon_trans, os.path.join(ASSETS, "favicon.ico"),
                     sizes=(16, 32, 48))

    # 5. Apple touch icon (180x180) - no transparency needed but keep it
    print("[5] Creating apple-touch-icon...")
    ati = Image.open(logo_icon_trans).convert("RGBA").resize((180, 180), Image.LANCZOS)
    ati.save(os.path.join(ASSETS, "apple-touch-icon.png"), "PNG")
    print(f"  -> {os.path.join(ASSETS, 'apple-touch-icon.png')}")

    # 6. Web manifest icons (192, 512) with proper maskable padding
    print("[6] Creating web manifest icons (192/512 maskable)...")
    for s in (192, 512):
        icon = Image.open(logo_icon_trans).convert("RGBA")
        # scale to ~80% to leave safe zone
        target = int(s * 0.8)
        icon = icon.resize((target, target), Image.LANCZOS)
        canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        canvas.paste(icon, ((s - target) // 2, (s - target) // 2), icon)
        out = os.path.join(ASSETS, f"logo_icon_{s}x{s}_maskable.png")
        canvas.save(out, "PNG")
        print(f"  -> {out}")

    print("\nDone! All assets saved to", ASSETS)


if __name__ == "__main__":
    main()
