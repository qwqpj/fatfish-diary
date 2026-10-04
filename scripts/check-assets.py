"""核验 assets/ 里的图：格式、尺寸、帧数、真实透明通道。"""
import os
import sys
from PIL import Image, ImageSequence

d = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets"
)

for f in sorted(os.listdir(d)):
    p = os.path.join(d, f)
    if not os.path.isfile(p):
        continue
    if not f.lower().endswith((".png", ".webp", ".gif", ".jpg", ".jpeg", ".apng")):
        continue
    try:
        im = Image.open(p)
    except Exception as e:
        print(f"{f:16} 打不开: {e}")
        continue

    frames = sum(1 for _ in ImageSequence.Iterator(im))
    im2 = im.convert("RGBA")
    alpha = im2.getchannel("A")
    amin, amax = alpha.getextrema()
    w, h = im2.size
    corners = [
        im2.getpixel((0, 0)),
        im2.getpixel((w - 1, 0)),
        im2.getpixel((0, h - 1)),
        im2.getpixel((w - 1, h - 1)),
    ]
    corner_a = [c[3] for c in corners]

    # 全透明像素占比 —— 判断是不是真的抠干净了
    hist = alpha.histogram()
    total = w * h
    fully_transparent = hist[0] / total

    print(f"{f:16} {im.format:5} {im.mode:5} {w}x{h}  frames={frames:3}  "
          f"alpha={amin}-{amax}  corners={corner_a}  全透明占比={fully_transparent:.1%}")
    if frames > 1:
        print(f"{'':16} duration={im.info.get('duration')}ms  loop={im.info.get('loop')}  "
              f"n_frames={im.n_frames}")

    # 主体是否偏心（抠图常见问题）
    bbox = alpha.getbbox()
    if bbox:
        print(f"{'':16} 不透明区域 bbox={bbox}  占画布 "
              f"{(bbox[2]-bbox[0])/w:.0%} x {(bbox[3]-bbox[1])/h:.0%}  "
              f"水平中心={(bbox[0]+bbox[2])/2/w:.0%} 垂直中心={(bbox[1]+bbox[3])/2/h:.0%}")
