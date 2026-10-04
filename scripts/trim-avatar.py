"""
把 assets/avatar.png 裁成适合小尺寸显示的头像。

为什么不能只裁掉透明边距：这张图的内容是 244x185 的**横向**胸像，
塞进正方形头像位后，竖向最多只能填 65% —— 46x46 下人物小得几乎看不清。
头像真正要的是**脸**，所以这里对着头部做特写裁切。

评估方式见 scripts/avatar-candidates.py：把候选按 46/64/96 的真实尺寸渲染出来看，
而不是放大看。实测 zoom=0.70 / focus=0.42 在 46px 下最清晰。

原图会先备份到 assets/.original/（目录名以点开头，不在素材扫描范围内），
所以这个脚本可以反复跑、反复调参。

用法：
    python scripts/trim-avatar.py                     # 用实测最优参数
    python scripts/trim-avatar.py --zoom 0.9          # 放松一点，多留身体
    python scripts/trim-avatar.py --zoom 1.0 --focus 0.5   # 退回"整幅内容居中"
"""
import os
import shutil
import sys
from PIL import Image

ASSETS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
BACKUP_DIR = os.path.join(ASSETS, ".original")
NAME = "avatar.png"

zoom = 0.70    # 裁切边长 = max(内容宽, 内容高) * zoom
focus = 0.42   # 裁切中心在内容框内的纵向位置（0=顶, 1=底）；头部大致在 0.42
if "--zoom" in sys.argv:
    zoom = float(sys.argv[sys.argv.index("--zoom") + 1])
if "--focus" in sys.argv:
    focus = float(sys.argv[sys.argv.index("--focus") + 1])

target = os.path.join(ASSETS, NAME)
backup = os.path.join(BACKUP_DIR, NAME)

# 第一次跑：把用户原图存成母版；之后一律从母版重算，保证可反复运行
if not os.path.exists(backup):
    os.makedirs(BACKUP_DIR, exist_ok=True)
    shutil.copy2(target, backup)
    print(f"已备份原图 -> {backup}")

src = Image.open(backup).convert("RGBA")
W, H = src.size
bbox = src.getchannel("A").getbbox()
if bbox is None:
    print("整张图都是透明的，没什么可裁")
    sys.exit(1)

bw, bh = bbox[2] - bbox[0], bbox[3] - bbox[1]
side = max(32, int(round(max(bw, bh) * zoom)))
cx = (bbox[0] + bbox[2]) // 2
cy = bbox[1] + int(bh * focus)
left, top = cx - side // 2, cy - side // 2

# 裁到画布外时用透明补齐，保证输出仍然是正方形
out = Image.new("RGBA", (side, side), (0, 0, 0, 0))
sx0, sy0 = max(0, left), max(0, top)
sx1, sy1 = min(W, left + side), min(H, top + side)
piece = src.crop((sx0, sy0, sx1, sy1))
out.paste(piece, (sx0 - left, sy0 - top), piece)

out.save(target)
print(f"原图 {W}x{H}  内容框 {bbox} ({bw}x{bh})")
print(f"zoom={zoom} focus={focus} -> 裁切 {side}x{side} @ ({left},{top})")
a = out.getchannel("A").getbbox()
print(f"裁后内容占画布 {(a[2]-a[0])/side:.0%} x {(a[3]-a[1])/side:.0%}"
      f"（裁前 {(bw/W):.0%} x {(bh/H):.0%}）")
print(f"写出 {target}  {os.path.getsize(target)/1024:.1f} KB")
