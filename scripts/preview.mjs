/**
 * 预览生成器：把自画像和图标渲染成一张对照图，供人工/无头浏览器检查。
 *   node scripts/preview.mjs            → 写出 scripts/.preview/avatar.html
 * 然后（Windows）用无头 Chrome 截图：
 *   chrome --headless --screenshot=preview.png --window-size=980,760 file:///.../avatar.html
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { avatarSvg, iconSvg } from "../lib/avatar.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, ".preview");
mkdirSync(outDir, { recursive: true });

const sizes = [160, 96, 64, 44, 32];

function row(bg, fg, label) {
  return `<div class="cell" style="background:${bg};color:${fg}">
    <div class="lbl" style="color:${fg}">${label}</div>
    <div class="row">
      ${sizes.map((s) => `<div class="item"><div>${avatarSvg({ size: s })}</div><span>${s}px</span></div>`).join("")}
      <div class="item icos">
        ${[28, 22, 18, 14].map((s) => `<div class="icoBox" style="color:${fg}">${iconSvg(s)}</div>`).join("")}
        <span>icon</span>
      </div>
    </div>
  </div>`;
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}
  body{margin:0;font:13px/1.4 system-ui,"Segoe UI",sans-serif}
  .cell{padding:16px 20px}
  .lbl{font-size:12px;opacity:.7;margin-bottom:10px;letter-spacing:.5px}
  .row{display:flex;align-items:flex-end;gap:22px}
  .item{display:flex;flex-direction:column;align-items:center;gap:6px}
  .item span{font-size:11px;opacity:.55}
  .icos{flex-direction:row;align-items:center;gap:14px;border-left:1px solid currentColor;padding-left:22px;margin-left:6px}
  .icoBox{display:flex;align-items:center;justify-content:center}
  svg{display:block}
</style></head><body>
  ${row("#ffffff", "#1a1a1a", "LIGHT 浅色主题")}
  ${row("#1b1f28", "#e6e8ee", "DARK 深色主题")}
  ${row("#f4f5f7", "#2a2f3a", "LIGHT CARD 面板浅底")}
  ${row("#12161d", "#cfd6e4", "DARK CARD 面板深底")}
</body></html>`;

const target = join(outDir, "avatar.html");
writeFileSync(target, html, "utf8");
console.log("wrote", target);
