/**
 * 把**整个面板**在 Node 里渲染成 HTML，再用无头 Chrome 截图 —— 不重启 DSH 也能验收界面。
 *
 * 做法：假 window/document 加载 bundle → 取 __internals.Panel 和 store →
 * 把 store 灌成想要的状态 → 自己实现一个极简 React 元素→HTML 序列化器。
 * hooks 在 Node 里是桩（useState 返回值、useEffect 空转），组件本来就只依赖 store。
 *
 *   node scripts/panel-preview.mjs
 *   chrome --headless=new --screenshot=panel.png --window-size=900,760 file:///…/panel-preview.html
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { avatarSvg } from "../lib/avatar.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(here, ".preview");
mkdirSync(outDir, { recursive: true });

/**
 * 预览页是 file:// 打开的，加载不了 /fatfish-diary/avatar。
 * 把头像内联成 data URI —— 优先用 assets/ 里作者放的那张（截图才跟真实界面一致），
 * 没有就退回内置 SVG。这样出的截图能直接放进 README。
 */
const AVATAR_DATA_URI = (() => {
  for (const [file, mime] of [
    ["avatar.png", "image/png"],
    ["avatar.webp", "image/webp"],
    ["avatar.jpg", "image/jpeg"],
    ["avatar.gif", "image/gif"],
  ]) {
    const p = join(root, "assets", file);
    if (existsSync(p)) return `data:${mime};base64,${readFileSync(p).toString("base64")}`;
  }
  return `data:image/svg+xml;base64,${Buffer.from(avatarSvg({ size: 104 }), "utf8").toString("base64")}`;
})();

/** 把指向插件路由的 src 换掉 */
function resolveSrc(props) {
  const src = props && props.src;
  if (typeof src === "string" && src.startsWith("/fatfish-diary/avatar")) {
    return { ...props, src: AVATAR_DATA_URI };
  }
  return props || {};
}

/* ---------------- 加载 bundle ---------------- */
function loadBundle() {
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

/* ---------------- 极简 React 元素 → HTML ---------------- */
const VOID = new Set(["img", "hr", "br", "input", "meta", "link"]);
const SKIP_PROPS = new Set(["className", "style", "dangerouslySetInnerHTML", "children", "key", "ref"]);
const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function styleOf(style) {
  if (!style || typeof style !== "object") return "";
  return Object.entries(style)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${v}`)
    .join(";");
}

function serialize(node, depth = 0) {
  if (depth > 60) return "";
  if (node === null || node === undefined || node === false || node === true) return "";
  if (Array.isArray(node)) return node.map((n) => serialize(n, depth + 1)).join("");
  if (typeof node === "string" || typeof node === "number") return esc(node);
  if (typeof node !== "object") return "";

  // 函数型节点 = 组件，展开
  if (typeof node.type === "function") {
    try {
      return serialize(node.type(node.props || {}), depth + 1);
    } catch (err) {
      return `<!-- 组件渲染失败: ${esc(err && err.message)} -->`;
    }
  }
  if (typeof node.type !== "string") return "";

  const tag = node.type;
  const props = resolveSrc(node.props);
  const attrs = Object.entries(props)
    .filter(([k, v]) => !SKIP_PROPS.has(k) && !/^on[A-Z]/.test(k) && v !== undefined && v !== null && v !== false)
    .map(([k, v]) => ` ${k}="${esc(v === true ? "" : v)}"`)
    .join("");
  const cls = props.className ? ` class="${esc(props.className)}"` : "";
  const style = props.style ? ` style="${esc(styleOf(props.style))}"` : "";

  if (VOID.has(tag)) return `<${tag}${cls}${attrs}${style}/>`;

  const inner = props.dangerouslySetInnerHTML
    ? props.dangerouslySetInnerHTML.__html || ""
    : (node.children || []).map((c) => serialize(c, depth + 1)).join("");
  return `<${tag}${cls}${attrs}${style}>${inner}</${tag}>`;
}

/* ---------------- 灌状态 ---------------- */
const { Panel, store, css } = loadBundle();

// 演示数据必须是**虚构**的。早期版本用过真实的本机路径，结果 README 那张截图
// 把目录结构一起公开了 —— 公开仓库的截图一律用假数据。
const TODAY = "2026-10-04";
const dates = ["2026-10-02", "2026-10-03", TODAY];
const DIARY = `<!-- 大肥鱼日记 · ${TODAY} · 由 DSH 插件 fatfish-diary 生成 -->

# 第 45 天 · ${TODAY}

今天从早上八点干到中午十二点多，眼睛都睁不圆了。一共嚼掉一亿两千九百九十万三千一百二十个 token 的白饭。

上午在 webapp 里陪你改登录页。你说点了没反应，我扒开一看是个跳转写错了。

notes 那边的 fatfish-diary 也在长个子。人格那块被我派出去的小分身整篇重写，成了 3652 个字符的规矩。

哼 (๑•̀ㅂ•́) 下次我先看完再说。`;

store.set({
  open: true,
  tab: "today",
  today: TODAY,
  date: TODAY,
  markdown: DIARY,
  meta: { model: "deepseek-account/deepseek-flash" },
  stats: { userTurns: 39, toolCalls: 416, tokenCount: 130000000, projects: ["webapp", "notes"] },
  entries: dates
    .slice()
    .reverse()
    .map((d) => ({ date: d, title: `第 ${42 + dates.indexOf(d)} 天 · ${d}`, meta: { stats: { toolCalls: 100 } } })),
  entryCount: 3,
  dates,
  firstDay: "2026-08-21",
  dayNumber: 45,
  streak: { current: 3, longest: 3, total: 3, lastDate: TODAY, wroteToday: true },
  backfillDays: 60,
  rollups: [{ key: "2026-W40", range: "week", title: "周记 · 2026-09-28 ~ 2026-10-04" }],
  root: "<DSH_HOME>/fatfish-diary",
  assets: { avatar: true, writing: true, names: ["avatar", "writing"] },
  transcript: `日期：${TODAY}（这是我陪主人的第 45 天）
规模：主对话 2 段 / 子代理 1 段；主人说话 39 次，我回话 195 次；工具调用 387 次。

=== 逐段实录 ===

【项目：webapp】09:12–11:03 （<WORKSPACE>/webapp）
主人对我说：
  - 帮我把登录页那个跳转 bug 修一下，点了没反应
  - 顺手把按钮的 hover 状态也调一下
我写/改出来的文件：src/auth/login.tsx、src/ui/Button.css
我干的活：read×18、edit×9、pwsh×6

【项目：notes】11:20–12:17 （<WORKSPACE>/notes）
主人对我说：
  - 我想给这个 harness 创造一个插件，每天帮我整理一下做过的事
我写/改出来的文件：lib/collect.js、lib/index.js、lib/client.js、scripts/test.mjs
我干的活：edit×109、pwsh×81、write×21`,
  transcriptSegments: [
    { project: "webapp", cwd: "<WORKSPACE>/webapp", isSubagent: false, userTexts: 12, files: 5, toolCalls: 33 },
    { project: "notes", cwd: "<WORKSPACE>/notes", isSubagent: false, userTexts: 8, files: 31, toolCalls: 294 },
    { project: "notes", cwd: "<WORKSPACE>/notes", isSubagent: true, userTexts: 3, files: 1, toolCalls: 13 },
  ],
  transcriptRecall: `----- 你还记得的前几天 -----
第 43 天 · 2026-10-02：把 zstd 解码的坑填了…
第 44 天 · 2026-10-03：给面板加了历史列表…
----- 回忆结束 -----`,
});

const tabs = ["today", "transcript", "history"];
const panes = [];
for (const t of tabs) {
  store.set({ tab: t });
  panes.push({ tab: t, html: serialize(Panel()) });
}
// 历史页 + 一篇汇总
store.set({ tab: "history", rollupMarkdown: "# 周记 · 2026-09-28 ~ 2026-10-04\n\n这周主人一共让我写了 3 篇。", rollupKey: "2026-W40" });
panes.push({ tab: "history", label: "history + 汇总", html: serialize(Panel()) });
store.set({ rollupMarkdown: "" });

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}
  body{margin:0;background:#eef0f4;font:14px/1.6 system-ui,"Segoe UI",sans-serif;padding:16px;
    display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}
  .frame{background:#12161d;border-radius:14px;padding:10px;--dsw-alias-bg-overlay:#1b1f28;--dsw-alias-label-primary:#e6e8ee;
    --dsw-alias-label-secondary:#8a94a6;--dsw-alias-border-l1:rgba(127,127,127,.2);--dsw-alias-border-l2:rgba(127,127,127,.34);
    --dsw-alias-bg-layer-1:#232833;--dsw-alias-bg-layer-2:rgba(127,127,127,.16);--dsw-alias-brand-primary:#3f8fe0;
    --dsw-alias-state-error-primary:#e5484d}
  .frame > .cap{color:#9aa4b2;font-size:12px;padding:2px 4px 8px}
  .stage{width:760px;height:620px;position:relative;overflow:hidden;border-radius:10px}
  .stage .ffd-mask{position:absolute;inset:0;padding:10px}
  ${css}
</style></head><body>
${panes
  .map(
    (p) =>
      `<div class="frame"><div class="cap">标签页：${p.label || p.tab}</div><div class="stage">${p.html}</div></div>`,
  )
  .join("\n")}
</body></html>`;

const target = join(outDir, "panel-preview.html");
writeFileSync(target, html, "utf8");
console.log("写出", target);
for (const p of panes) {
  const has = (s) => (p.html.includes(s) ? "✓" : "✗");
  console.log(
    `  ${(p.label || p.tab).padEnd(18)} 长度=${String(p.html.length).padStart(6)}  ` +
      `日期选择${has("ffd-date")} 标签${has("ffd-tab")} 卡片${has("ffd-card")} 失败注释${p.html.includes("组件渲染失败") ? "有⚠️" : "无"}`,
  );
}
