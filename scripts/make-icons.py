"""
מייצר את אייקוני האפליקציה מתוך assets-src/icon-source.jpg.

שתי החלטות שלא ברורות מאליהן:

1. התמונה המקורית היא אריח כחול מעוגל על רקע לבן. חיתוך פשוט היה משאיר
   פינות לבנות — ואייפון מחיל מסכה מעוגלת משלו, אז הפינות האלה נראות
   כמו משולשים לבנים סביב האייקון. לכן הפינות נצבעות בכחול של האריח
   עצמו, והתוצאה היא ריבוע מלא שהמסכה של המערכת חותכת יפה.

2. maskable הוא קובץ נפרד שבו הציור מוקטן ל-80%. אנדרואיד חותך את
   האייקון לצורה שהמשתמש בחר, ומה שמחוץ למעגל הפנימי עלול להיחתך.

הרצה:  python scripts/make-icons.py
"""

import os
from PIL import Image, ImageDraw

SRC = "assets-src/icon-source.jpg"
OUT = "public/icons"

# גבולות האריח בתוך הקובץ המקורי, נמדדו ולא נוחשו.
BBOX = (120, 111, 1133, 1148)
CORNER_RATIO = 0.22      # רדיוס הפינה של האריח, כשבר מהצלע
SAFE = 0.8               # אזור בטוח ל-maskable


def tile_color(im, box):
    """הכחול של האריח — נדגם מבפנים, הרחק מהפינות ומהציור שבמרכז."""
    left, top, right, bottom = box
    y = (top + bottom) // 2
    x = left + int((right - left) * 0.03)
    return im.convert("RGB").getpixel((x, y))


def rounded_mask(side, radius):
    mask = Image.new("L", (side, side), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, side - 1, side - 1], radius=radius, fill=255)
    return mask


def save_png(img, path):
    """Pillow מאפס את הקובץ לפני שהוא כותב, אז שגיאה באמצע משאירה קובץ
    ריק במקום את הקודם. כותבים לקובץ זמני ומחליפים רק אחרי הצלחה."""
    tmp = path + ".tmp"
    img.save(tmp, "PNG", optimize=True)
    os.replace(tmp, path)
    print(f"  {path}  {img.size[0]}x{img.size[1]}")


def main():
    os.makedirs(OUT, exist_ok=True)
    src = Image.open(SRC).convert("RGB")

    navy = tile_color(src, BBOX)
    left, top, right, bottom = BBOX
    cx, cy = (left + right) // 2, (top + bottom) // 2
    side = max(right - left, bottom - top)
    half = side // 2
    art = src.crop((cx - half, cy - half, cx + half, cy + half)).resize((1024, 1024), Image.LANCZOS)

    # הפינות הלבנות מוחלפות בכחול של האריח
    base = Image.new("RGB", (1024, 1024), navy)
    base.paste(art, (0, 0), rounded_mask(1024, int(1024 * CORNER_RATIO)))

    print(f"צבע האריח: {navy}")
    for size in (512, 192, 180):
        save_png(base.resize((size, size), Image.LANCZOS), f"{OUT}/icon-{size}.png")

    # maskable: אותו ציור, מוקטן, על רקע מלא
    inner = int(512 * SAFE)
    maskable = Image.new("RGB", (512, 512), navy)
    maskable.paste(base.resize((inner, inner), Image.LANCZOS), ((512 - inner) // 2, (512 - inner) // 2))
    save_png(maskable, f"{OUT}/icon-maskable-512.png")


if __name__ == "__main__":
    main()
