/**
 * 把**真实的日记**跑一遍客户端的 markdown 渲染器，生成一张可截图的预览页。
 *
 * 目的：渲染器不经过任何导出的入口，光靠单测只能证断言、看不出"长得对不对"。
 * 这里复用 bundle 里的 renderMarkdown + 同一份 CSS，再把无头 Chrome 截图当验收。
 *
 *   node scripts/render-preview.mjs [YYYY-MM-DD]
 *   chrome --headless=new --screenshot=out.png --window-size=980,1200 file:///…/diary-preview.html
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(here, ".preview");
mkdirSync(outDir, { recursive: true });

/* ---- 用假的 window/document 把 bundle 加载起来，取内部渲染器 ---- */
function loadBundleInternals() {
  const code = readFileSync(join(root, "lib", "client.js"), "utf8");
  let spec = null;
  const fakeWindow = { __ModuleLoader__: { load: (s) => { spec = s; } }, addEventListener() {}, removeEventListener() {} };
  const fakeDocument = {
    head: { appendChild() {} },
    body: { appendChild() {} },
    createElement: () => ({ textContent: "", dataset: {}, parentNode: null, setAttribute() {}, appendChild() {}, removeChild() {} }),
    getElementById: () => null,
  };
  // eslint-disable-next-line no-new-func
  new Function("window", "document", "console", code)(fakeWindow, fakeDocument, console);
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (i) => [typeof i === "function" ? i() : i, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useCallback: (fn) => fn,
  };
  const mod = spec.factory((name) => (name === "react" ? reactStub : undefined));
  return mod.__internals;
}

/* ---- 找一篇真实日记 ---- */
const home = process.env.DSH_HOME || join(process.env.USERPROFILE || "", ".dsh");
const diaryDir = join(home, "fatfish-diary", "diary");
let date = process.argv[2];
if (!date) {
  const files = existsSync(diaryDir) ? readFileSync : null;
  const { readdirSync } = await import("node:fs");
  const md = existsSync(diaryDir) ? readdirSync(diaryDir).filter((f) => f.endsWith(".md")).sort() : [];
  date = md.length ? md.at(-1).slice(0, -3) : null;
}
if (!date) {
  console.error("没有找到任何日记，先让插件写一篇再用这个脚本");
  process.exit(1);
}
const mdPath = join(diaryDir, `${date}.md`);
const markdown = readFileSync(mdPath, "utf8");

const { renderMarkdown, css } = loadBundleInternals();
const body = renderMarkdown(markdown);

console.log(`日记：${mdPath}`);
console.log(`原始 markdown 前 90 字：${JSON.stringify(markdown.slice(0, 90))}`);
console.log(`渲染结果前 90 字    ：${JSON.stringify(body.slice(0, 90))}`);
console.log(`渲染结果里还有注释吗：${body.includes("<!--") || body.includes("&lt;!--") ? "有 ⚠️" : "没有 ✓"}`);

// 深色 + 浅色并排，模拟两种主题
const page = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}
  body{margin:0;display:flex;font:14px/1.6 system-ui,"Segoe UI",sans-serif}
  .pane{flex:1;min-width:0;padding:20px}
  .pane.dark{--dsw-alias-bg-overlay:#1b1f28;--dsw-alias-label-primary:#e6e8ee;--dsw-alias-label-secondary:#8a94a6;
    --dsw-alias-border-l1:rgba(127,127,127,.2);--dsw-alias-border-l2:rgba(127,127,127,.3);
    --dsw-alias-bg-layer-2:rgba(127,127,127,.16);background:#12161d}
  .pane.light{--dsw-alias-bg-overlay:#ffffff;--dsw-alias-label-primary:#1a1f2b;--dsw-alias-label-secondary:#66707f;
    --dsw-alias-border-l1:rgba(0,0,0,.12);--dsw-alias-border-l2:rgba(0,0,0,.2);
    --dsw-alias-bg-layer-2:rgba(0,0,0,.06);background:#f4f5f7}
  .card{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);
    border:1px solid var(--dsw-alias-border-l2);border-radius:16px;overflow:hidden}
  ${css}
</style></head><body>
  <div class="pane light"><div class="card"><div class="ffd-body">${body}</div></div></div>
  <div class="pane dark"><div class="card"><div class="ffd-body">${body}</div></div></div>
</body></html>`;

const target = join(outDir, "diary-preview.html");
writeFileSync(target, page, "utf8");
console.log("写出", target);
