from __future__ import annotations

import hashlib
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public" / "images"
NAMES = [line.strip() for line in (PUBLIC / "university-names.txt").read_text(encoding="utf-8").splitlines() if line.strip()]
OUTPUT = ROOT / ".media-audit"


def average_hash(image: Image.Image) -> str:
    pixels = list(ImageOps.grayscale(image).resize((16, 16)).getdata())
    mean = sum(pixels) / len(pixels)
    return "".join("1" if value >= mean else "0" for value in pixels)


def audit_folder(folder: str, extensions: tuple[str, ...]):
    base = PUBLIC / folder
    records = []
    for name in NAMES:
        matches = [base / f"{name}{extension}" for extension in extensions]
        path = next((candidate for candidate in matches if candidate.exists()), None)
        if not path:
            records.append({"name": name, "status": "missing"})
            continue
        try:
            with Image.open(path) as image:
                image.load()
                records.append({
                    "name": name,
                    "status": "ok",
                    "path": str(path.relative_to(ROOT)),
                    "width": image.width,
                    "height": image.height,
                    "mode": image.mode,
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    "average_hash": average_hash(image),
                })
        except Exception as error:
            records.append({"name": name, "status": "invalid", "error": str(error)})
    return records


def contact_sheet(records, filename: str, size=(260, 170), columns=4):
    valid = [record for record in records if record["status"] == "ok"]
    rows = (len(valid) + columns - 1) // columns
    sheet = Image.new("RGB", (columns * size[0], rows * (size[1] + 46)), "white")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()
    for index, record in enumerate(valid):
        x = (index % columns) * size[0]
        y = (index // columns) * (size[1] + 46)
        with Image.open(ROOT / record["path"]) as image:
            image = ImageOps.contain(image.convert("RGB"), (size[0] - 12, size[1] - 12))
            sheet.paste(image, (x + (size[0] - image.width) // 2, y + (size[1] - image.height) // 2))
        label = record["name"]
        lines = [label[i:i + 38] for i in range(0, len(label), 38)][:2]
        draw.multiline_text((x + 6, y + size[1] + 3), "\n".join(lines), fill="black", font=font, spacing=2)
    sheet.save(OUTPUT / filename, quality=88)


def duplicates(records, key: str):
    grouped = {}
    for record in records:
        if record["status"] == "ok":
            grouped.setdefault(record[key], []).append(record["name"])
    return [names for names in grouped.values() if len(names) > 1]


def main():
    OUTPUT.mkdir(exist_ok=True)
    covers = audit_folder("university-covers", (".jpg", ".jpeg", ".png", ".webp"))
    logos = audit_folder("university-logos", (".png", ".jpg", ".jpeg", ".webp"))
    report = {
        "university_count": len(NAMES),
        "covers": covers,
        "logos": logos,
        "cover_exact_duplicates": duplicates(covers, "sha256"),
        "logo_exact_duplicates": duplicates(logos, "sha256"),
        "cover_visual_duplicates": duplicates(covers, "average_hash"),
        "logo_visual_duplicates": duplicates(logos, "average_hash"),
        "small_covers": [record["name"] for record in covers if record["status"] == "ok" and (record["width"] < 600 or record["height"] < 300)],
        "small_logos": [record["name"] for record in logos if record["status"] == "ok" and (record["width"] < 96 or record["height"] < 96)],
    }
    (OUTPUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    contact_sheet(covers, "covers-contact-sheet.jpg")
    contact_sheet(logos, "logos-contact-sheet.jpg", size=(220, 150), columns=5)
    print(json.dumps({
        "universities": len(NAMES),
        "covers_ok": sum(record["status"] == "ok" for record in covers),
        "logos_ok": sum(record["status"] == "ok" for record in logos),
        "missing_covers": [record["name"] for record in covers if record["status"] != "ok"],
        "missing_logos": [record["name"] for record in logos if record["status"] != "ok"],
        "cover_exact_duplicates": report["cover_exact_duplicates"],
        "logo_exact_duplicates": report["logo_exact_duplicates"],
        "small_covers": report["small_covers"],
        "small_logos": report["small_logos"],
        "output": str(OUTPUT),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
