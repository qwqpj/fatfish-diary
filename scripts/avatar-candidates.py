"""
把几种候选裁切按**真实显示尺寸**渲染出来对比。

头像在界面里就是 46x46（标题栏）和 96x96（空状态），
所以必须在那个尺寸下看，而不是放大看 —— 小图里能看清的只有脸。

用法： python scripts/avatar-candidates.py
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
OUT = os.path.join(ROOT, "scripts", ".preview")
os.makedirs(OUT, exist_ok=True)

src = Image.open(os.path.join(ASSETS, ".original", "avatar.png")).convert("RGBA")
W, H = src.size
bbox = src.getchannel("A").getbbox()          # (23, 63, 267, 248)
bw, bh = bbox[2] - bbox[0], bbox[3] - bbox[1]
cx, cy = (bbox[0] + bbox[2]) // 2, (bbox[1] + bbox[3]) // 2


def square_crop(side, center=(cx, cy)):
    """以 center 为中心取正方形，越界用透明补齐"""
    left, top = center[0] - side // 2, center[1] - side // 2
    out = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sx0, sy0 = max(0, left), max(0, top)
    sx1, sy1 = min(W, left + side), min(H, top + side)
    piece = src.crop((sx0, sy0, sx1, sy1))
    out.paste(piece, (sx0 - left, sy0 - top), piece)
    return out


# 头部大致在内容框上部：先用内容高度估一个"脸中心"
head_center = (cx, bbox[1] + int(bh * 0.42))

def square_at(side, focus):
    """以内容框的 (水平中心, 纵向 focus) 为中心取正方形"""
    cx2 = (bbox[0] + bbox[2]) // 2
    cy2 = bbox[1] + int(bh * focus)
    return square_crop(side, (cx2, cy2))


maxdim = max(bw, bh)
candidates = [
    ("A 全内容", square_crop(int(maxdim * 1.16))),
    ("E zoom.70 f.42", square_at(int(maxdim * 0.70), 0.42)),
    ("F zoom.75 f.50", square_at(int(maxdim * 0.75), 0.50)),
    ("G zoom.82 f.52", square_at(int(maxdim * 0.82), 0.52)),
]

SIZES = [46, 64, 96]
PAD = 14
ROW_H = PAD * 2 + 200
LABEL_W = 150
cell_w = sum(s + PAD * 2 for s in SIZES)
sheet_w = LABEL_W + cell_w * 2
sheet = Image.new("RGB", (sheet_w, ROW_H * len(candidates)), (255, 255, 255))
d = ImageDraw.Draw(sheet)

for r, (label, im) in enumerate(candidates):
    y0 = r * ROW_H
    # 左半浅色、右半深色
    d.rectangle([0, y0, sheet_w, y0 + ROW_H], fill=(255, 255, 255))
    d.rectangle([LABEL_W + cell_w, y0, sheet_w, y0 + ROW_H], fill=(27, 31, 40))
    d.text((10, y0 + ROW_H // 2 - 6), label, fill=(20, 20, 20))

    for half, bg in ((0, (255, 255, 255)), (1, (27, 31, 40))):
        x = LABEL_W + half * cell_w
        # 底板
        d.rectangle([x, y0, x + cell_w, y0 + ROW_H], fill=bg)
        for s in SIZES:
            thumb = im.resize((s, s), Image.LANCZOS)
            px = x + PAD
            py = y0 + (ROW_H - s) // 2
            sheet.paste(thumb, (px, py), thumb)
            x += s + PAD * 2

sheet.save(os.path.join(OUT, "avatar-candidates.png"))
print("->", os.path.join(OUT, "avatar-candidates.png"))
print(f"原图 {W}x{H}  内容框 {bbox}")
print("各候选内容占比：")
for label, im in candidates:
    a = im.getchannel("A").getbbox()
    if a:
        print(f"  {label:18} {im.width}x{im.height}  内容占 {((a[2]-a[0])/im.width):.0%} x {((a[3]-a[1])/im.height):.0%}")
