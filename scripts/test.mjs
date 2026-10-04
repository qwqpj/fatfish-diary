/**
 * 回归测试：不需要 DSH 运行就能验证插件的核心逻辑。
 *   node scripts/test.mjs
 *
 * 覆盖：多帧 zstd 解码、按自然日归档、噪音过滤、digest 折叠、
 *       日记落盘/读取、CSRF 判定、兜底模板的健壮性。
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import zlib from "node:zlib";

import {
  decodeZstdFrames,
  parseSessionBytes,
  localDayWindow,
  todayStr,
  toDateStr,
  daysBetween,
  isInjectedNoise,
  buildDigest,
  renderTranscript,
  isEmptyDigest,
  digestSummary,
  collectDay,
  dayNumberOf,
  estimateFirstDay,
  extractArtifacts,
  pickSpread,
  pickSnippets,
} from "../lib/collect.js";
import { isCrossSite } from "../lib/index.js";
import {
  PERSONA_SYSTEM,
  FALLBACK_TEMPLATE,
  ROLLUP_SYSTEM,
  buildRecall,
  FALLBACK_ROLLUP,
} from "../lib/persona.js";
import { avatarSvg, iconSvg, WHALE_PATHS } from "../lib/avatar.js";
import {
  writeEntry,
  readEntry,
  listEntries,
  deleteEntry,
  hasEntry,
  storeState,
  archiveExisting,
  listHistory,
  historyDir,
  readMeta,
  writeMeta,
  resolveFirstDay,
  streakOf,
  listDates,
  condenseMarkdown,
  recentEntries,
  rollupKeyFor,
  rollupWindow,
  writeRollup,
  readRollup,
  listRollups,
} from "../lib/store.js";

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(name + (detail ? `  → ${detail}` : ""));
    console.log(`FAIL  ${name}${detail ? `  → ${detail}` : ""}`);
  }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
function group(title) {
  console.log(`\n── ${title} ──`);
}

/* ============================================================
 * 1. 多帧 zstd 解码
 * ============================================================ */
group("多帧 zstd 解码");

const hasZstd = typeof zlib.zstdCompressSync === "function";
if (!hasZstd) {
  console.log("  (本机 Node 无 zstdCompressSync，跳过合成的多帧用例)");
} else {
  const L1 = '{"type":"session","version":4,"id":"s1","createdAt":1,"cwd":"C:\\\\tmp"}\n';
  const L2 = '{"type":"user/message","seq":1,"time":1000,"data":{"content":[{"type":"text","text":"你好"}],"role":"user"}}\n';
  const L3 = '{"type":"assistant/message","seq":2,"time":2000,"data":{"message":{"role":"assistant","content":[{"type":"text","text":"在的"}]}}}\n';

  // 三个独立帧拼在一起 —— 这正是 DSH 会话日志的真实形态
  const multi = Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(L1, "utf8")),
    zlib.zstdCompressSync(Buffer.from(L2, "utf8")),
    zlib.zstdCompressSync(Buffer.from(L3, "utf8")),
  ]);

  // 先证明"天真解整个 buffer"确实会丢数据——这是我踩过的坑
  const naive = zlib.zstdDecompressSync(multi).toString("utf8");
  ok("朴素解压只拿到第 1 帧（记录这个坑）", naive.split("\n").filter(Boolean).length === 1, `实际 ${naive.split("\n").filter(Boolean).length} 行`);

  const decoded = decodeZstdFrames(multi);
  eq("decodeZstdFrames 三帧全解", decoded.split("\n").filter(Boolean).length, 3);

  const events = parseSessionBytes(multi);
  eq("parseSessionBytes 事件数", events.length, 3);
  eq("首个事件是会话头", events[0].type, "session");
  eq("第三个事件是 assistant", events[2].type, "assistant/message");

  // 覆盖：多段拼接（一个帧里多行）
  const batched = zlib.zstdCompressSync(Buffer.from(L1 + L2, "utf8"));
  const both = Buffer.concat([batched, zlib.zstdCompressSync(Buffer.from(L3, "utf8"))]);
  eq("帧内多行 + 多帧", parseSessionBytes(both).length, 3);

  // 健壮性：垃圾数据不该抛
  ok("空 buffer 不抛", decodeZstdFrames(Buffer.alloc(0)) === "");
  ok("随机垃圾不抛", (() => {
    try {
      decodeZstdFrames(Buffer.from("not a zstd stream at all, just text"));
      return true;
    } catch {
      return false;
    }
  })());
  ok("半截帧不抛", (() => {
    try {
      decodeZstdFrames(zlib.zstdCompressSync(Buffer.from(L1, "utf8")).subarray(0, 8));
      return true;
    } catch {
      return false;
    }
  })());
}

/* ============================================================
 * 2. 时间窗
 * ============================================================ */
group("时间与自然日");

{
  const { start, end } = localDayWindow("2026-10-04");
  eq("一天是 24 小时", (end - start) / 3600000, 24);
  eq("窗口起点是本地零点", new Date(start).getHours(), 0);
  eq("窗口起点日期正确", toDateStr(start), "2026-10-04");
  eq("窗口终点属于次日", toDateStr(end - 1), "2026-10-04");
  eq("窗口终点是次日零点", toDateStr(end), "2026-10-05");

  ok("非法日期抛错", (() => {
    try {
      localDayWindow("2026/10/04");
      return false;
    } catch {
      return true;
    }
  })());

  eq("daysBetween 同日", daysBetween("2026-10-04", "2026-10-04"), 0);
  eq("daysBetween 跨月", daysBetween("2026-09-30", "2026-10-02"), 2);
  eq("第 N 天至少为 1", dayNumberOf("2026-10-04", "2026-10-04"), 1);
  eq("第 N 天跨日累加", dayNumberOf("2026-08-21", "2026-10-04"), 45);

  ok("todayStr 是 YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(todayStr()));
}

/* ============================================================
 * 3. 噪音过滤
 * ============================================================ */
group("运行时上下文过滤");

{
  const noise = [
    "<turn-trigger>go</turn-trigger>",
    "Current runtime context. This snapshot supersedes",
    "Time sampled while preparing turn 1, step 1: 2026-10-04T08:09:20+08:00",
    "background job pwsh-10 (pwsh: & x) finished [status: completed, exit code: 0]. Read its output with job_output.",
    "This snapshot supersedes earlier runtime-context snapshots.",
    "<path>C:\\a\\b.png</path> <type>image</type> <content> image/jpeg </content>",
    "<path>C:\\a\\b.png</path> <type>image</type> <content> image/jpeg image, 1814x2311 px, 822442 bytes (downscaled from 1896x2416 px; multiply coordinates by 1.05 to locate features in the original file) </content>",
    "   ",
    "",
  ];
  const real = [
    "我想给这个harness创造一个插件",
    "帮我修一下这个脚本，跑不起来",
    "话说krea2的提示词写中文就行是不是？",
    // 带附件但主人确实说了话 —— 不能误杀
    "<path>C:\\a\\b.png</path> 这张图你觉得怎么样？",
    "<path>C:\\a\\b.png</path> <type>image</type> <content> image/jpeg </content> 帮我把它改成竖版",
  ];
  for (const s of noise) ok(`噪音被滤掉: ${JSON.stringify(s.slice(0, 34))}`, isInjectedNoise(s) === true);
  for (const s of real) ok(`人话保留: ${JSON.stringify(s.slice(0, 20))}`, isInjectedNoise(s) === false);
}

/* ============================================================
 * 4. digest 折叠
 * ============================================================ */
group("digest 折叠与实录渲染");

function mkSessions(date) {
  const { start } = localDayWindow(date);
  const t = start + 3600_000;
  const ev = [];
  ev.push({ type: "turn/start", seq: 1, time: t, data: { turn: 1 } });
  ev.push({
    type: "user/message",
    seq: 2,
    time: t + 1000,
    data: { content: [{ type: "text", text: "把那个脚本修一下" }], role: "user" },
  });
  ev.push({
    type: "user/message",
    seq: 3,
    time: t + 1100,
    data: { content: [{ type: "text", text: "Current runtime context. blah" }], role: "user" },
  });
  ev.push({
    type: "assistant/message",
    seq: 4,
    time: t + 2000,
    data: {
      message: { role: "assistant", content: [{ type: "text", text: "好的，我看看" }] },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    },
  });
  ev.push({ type: "tool/call", seq: 5, time: t + 3000, data: { name: "read", arguments: '{"file_path":"C:\\\\a\\\\b\\\\run.py"}' } });
  ev.push({ type: "tool/call", seq: 6, time: t + 3100, data: { name: "edit", arguments: '{"file_path":"C:\\\\a\\\\b\\\\run.py"}' } });
  ev.push({ type: "tool/call", seq: 7, time: t + 3200, data: { name: "pwsh", arguments: '{"command":"python run.py"}' } });
  ev.push({ type: "tool/result", seq: 8, time: t + 3300, data: { message: {}, error: { name: "E", code: "x" } } });
  return [
    { id: "s1", cwd: "C:\\work\\demo", createdAt: t, origin: null, delegationDepth: 0, events: ev, source: "disk" },
  ];
}

{
  const date = "2026-10-04";
  const digest = buildDigest({ date, dayNumber: 45, sessions: mkSessions(date) });

  eq("userTurns 只数人话", digest.userTurns, 1);
  eq("assistantTurns", digest.assistantTurns, 1);
  eq("toolCalls", digest.toolCalls, 3);
  eq("token 合计", digest.tokenCount, 120);
  eq("tokens 别名与 tokenCount 一致", digest.tokens, digest.tokenCount);
  eq("错误计数", digest.errorCount, 1);
  eq("projects", digest.projects, ["demo"]);
  eq("dayNumber 透传", digest.dayNumber, 45);
  ok("topTools 降序", digest.topTools.every((e, i, a) => i === 0 || a[i - 1][1] >= e[1]));
  ok("artifacts 抽到文件路径", digest.items[0].artifacts.some((a) => a.includes("run.py")));

  const tr = renderTranscript(digest);
  ok("实录含日期", tr.includes(date));
  ok("实录含人话", tr.includes("把那个脚本修一下"));
  ok("实录不含运行时噪音", !tr.includes("Current runtime context"));
  ok("实录含项目名", tr.includes("demo"));
  ok("实录长度有界", tr.length < 60000, `len=${tr.length}`);

  const sum = digestSummary(digest);
  ok("summary 带 assistantTurns", sum.assistantTurns === 1);
  ok("summary 带 tokens 别名", sum.tokens === 120);
  ok("summary 不含长文本", sum.items === undefined);

  ok("非空 digest 判定", isEmptyDigest(digest) === false);
  ok("空 digest 判定", isEmptyDigest(buildDigest({ date, dayNumber: 1, sessions: [] })) === true);
}

/* ============================================================
 * 5. 落盘 / 读取
 * ============================================================ */
group("日记落盘与读取");

const home = mkdtempSync(join(tmpdir(), "fatfish-test-"));
try {
  ok("初始无日记", hasEntry("2026-10-04", home) === false);
  eq("初始列表为空", listEntries(home), []);

  writeEntry(
    { date: "2026-10-04", markdown: "# 第 45 天 · 2026-10-04\n\n今天很困。\n", meta: { stats: { toolCalls: 7 } } },
    home,
  );
  writeEntry({ date: "2026-10-02", markdown: "## 旧的一篇\n", meta: {} }, home);

  ok("写完能读到", hasEntry("2026-10-04", home) === true);
  const e = readEntry("2026-10-04", home);
  ok("正文含标题", e.markdown.includes("第 45 天"));
  ok("注入了来源注释", e.markdown.startsWith("<!--"));
  eq("元信息保留", e.meta.stats.toolCalls, 7);

  const list = listEntries(home);
  eq("列表条数", list.length, 2);
  eq("列表新的在前", list[0].date, "2026-10-04");
  eq("列表解析出标题", list[0].title, "第 45 天 · 2026-10-04");

  const st = storeState(home);
  eq("storeState count", st.count, 2);
  eq("storeState firstDate", st.firstDate, "2026-10-02");
  eq("storeState lastDate", st.lastDate, "2026-10-04");

  eq("删除返回 true", deleteEntry("2026-10-02", home), true);
  eq("删除后剩 1 篇", listEntries(home).length, 1);
  eq("重复删除返回 false", deleteEntry("2026-10-02", home), false);

  ok("非法日期写盘抛错", (() => {
    try {
      writeEntry({ date: "../evil", markdown: "x", meta: {} }, home);
      return false;
    } catch {
      return true;
    }
  })());
  ok("读取不存在的日期返回 null", readEntry("1999-01-01", home) === null);

  // 目录不存在时不该抛
  const emptyHome = mkdtempSync(join(tmpdir(), "fatfish-empty-"));
  eq("空目录 listEntries", listEntries(emptyHome), []);
  eq("空目录 storeState count", storeState(emptyHome).count, 0);
  rmSync(emptyHome, { recursive: true, force: true });
} finally {
  rmSync(home, { recursive: true, force: true });
}

/* ============================================================
 * 6. collectDay 端到端（合成一个假的 DSH_HOME）
 * ============================================================ */
group("collectDay 端到端（合成 DSH_HOME）");

if (hasZstd) {
  const fakeHome = mkdtempSync(join(tmpdir(), "fatfish-home-"));
  try {
    const date = todayStr();
    const { start } = localDayWindow(date);
    const now = start + 3600_000;

    const sdir = join(fakeHome, "sessions", "--C-fake--", "session-abc");
    mkdirSync(sdir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "session", version: 4, id: "session-abc", createdAt: now, cwd: "C:\\fake", isSeeded: false }),
      JSON.stringify({ type: "user/message", seq: 1, time: now + 10, data: { content: [{ type: "text", text: "今天干点啥" }] } }),
      JSON.stringify({ type: "tool/call", seq: 2, time: now + 20, data: { name: "read", arguments: '{"file_path":"C:\\\\fake\\\\a.txt"}' } }),
    ];
    // 每一行单独一帧 —— 复刻真实的追加式写入
    const buf = Buffer.concat(lines.map((l) => zlib.zstdCompressSync(Buffer.from(l + "\n", "utf8"))));
    writeFileSync(join(sdir, "session.v4.jsonl.zstd"), buf);

    const raw = collectDay({ homeDir: fakeHome, date });
    eq("collectDay 找到 1 段会话", raw.sessions.length, 1);
    eq("采集到 2 条当日事件（不含会话头）", raw.sessions[0].events.length, 2);

    const d2 = buildDigest({ date, dayNumber: 3, sessions: raw.sessions });
    eq("端到端 userTurns", d2.userTurns, 1);
    eq("端到端 projects", d2.projects, ["fake"]);
    ok("estimateFirstDay 可用", /^\d{4}-\d{2}-\d{2}$/.test(estimateFirstDay(fakeHome)));

    // 别的日期应该采不到
    eq("别的日期采集为空", collectDay({ homeDir: fakeHome, date: "1999-01-01" }).sessions.length, 0);

    // 内存会话叠加：磁盘空 + live 有数据
    const liveRaw = collectDay({
      homeDir: mkdtempSync(join(tmpdir(), "fatfish-nohome-")),
      date,
      liveSessions: [{ id: "live-1", cwd: "C:\\live", createdAt: now, events: [
        { type: "user/message", seq: 1, time: now + 5, data: { content: [{ type: "text", text: "内存里的话" }] } },
      ] }],
    });
    eq("内存会话被采到", liveRaw.sessions.length, 1);
    eq("内存会话来源标记", liveRaw.sessions[0].source, "live");
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
} else {
  console.log("  (跳过：需要 zstdCompressSync)");
}

/* ============================================================
 * 7. CSRF 判定
 * ============================================================ */
group("CSRF 判定");

{
  const cases = [
    ["cross-site", { headers: { "sec-fetch-site": "cross-site" } }, true],
    ["same-origin", { headers: { "sec-fetch-site": "same-origin" } }, false],
    ["same-site", { headers: { "sec-fetch-site": "same-site" } }, false],
    ["none", { headers: { "sec-fetch-site": "none" } }, false],
    ["大写也拦", { headers: { "sec-fetch-site": "Cross-Site" } }, true],
    ["evil Origin", { headers: { origin: "https://evil.example" } }, true],
    ["loopback", { headers: { origin: "http://127.0.0.1:19387" } }, false],
    ["localhost", { headers: { origin: "http://localhost:19387" } }, false],
    ["ipv6 loopback", { headers: { origin: "http://[::1]:19387" } }, false],
    ["dsh-app", { headers: { origin: "dsh-app://app" } }, false],
    ["无头", { headers: {} }, false],
    ["空 req", {}, false],
    ["null req", null, false],
    ["cross-site 优先于同源 Origin", { headers: { "sec-fetch-site": "cross-site", origin: "http://127.0.0.1:1" } }, true],
    ["origin: null", { headers: { origin: "null" } }, true],
  ];
  for (const [name, req, want] of cases) {
    let got;
    try {
      got = isCrossSite(req);
    } catch (err) {
      got = `THREW ${err.message}`;
    }
    ok(`CSRF: ${name}`, got === want, `got=${got} want=${want}`);
  }
}

/* ============================================================
 * 8. 人格模块
 * ============================================================ */
group("人格模块");

{
  ok("PERSONA_SYSTEM 够长", PERSONA_SYSTEM.length > 1500, `len=${PERSONA_SYSTEM.length}`);
  ok("提示词含第一人称约束", /第一人称|"我"/.test(PERSONA_SYSTEM));
  ok("提示词含第 N 天标题格式", PERSONA_SYSTEM.includes("第") && PERSONA_SYSTEM.includes("天"));
  ok("提示词含禁编造条款", /编造|不许编|绝不/.test(PERSONA_SYSTEM));
  ok("提示词无裸反引号", !PERSONA_SYSTEM.includes("`"));

  const good = {
    date: "2026-10-04",
    dayNumber: 7,
    userTurns: 12,
    assistantTurns: 30,
    toolCalls: 48,
    tokens: 349000,
    sessions: 2,
    projects: ["Create"],
    topTools: [["pwsh", 20], ["read", 9]],
    items: [{ project: "Create", userTexts: ["帮我修一下这个脚本"], toolNames: ["read", "edit"] }],
  };
  const md = FALLBACK_TEMPLATE(good);
  ok("兜底含标题", md.includes("# 第 7 天 · 2026-10-04"));
  ok("兜底引用了真实 token 数", /34\.9 万|349000|34\.9/.test(md), md.slice(0, 120));
  ok("兜底引用了真实项目", md.includes("Create"));
  ok("兜底引用了真实原话", md.includes("帮我修一下这个脚本"));

  // 健壮性：各种烂输入都不许抛
  const bad = [undefined, null, {}, 0, "", [], { date: 123, projects: "x", topTools: [null, [null, "x"], ["a", -1]], items: [null, {}, 5] }];
  for (let i = 0; i < bad.length; i++) {
    ok(`兜底模板抗烂输入 #${i}`, (() => {
      try {
        return typeof FALLBACK_TEMPLATE(bad[i]) === "string";
      } catch {
        return false;
      }
    })());
  }
}

/* ============================================================
 * 9. 覆盖留档（误点"重写"不能丢稿）
 * ============================================================ */
group("覆盖留档");

{
  const h2 = mkdtempSync(join(tmpdir(), "fatfish-hist-"));
  try {
    eq("初始没有历史", listHistory("2026-10-04", h2), []);

    writeEntry({ date: "2026-10-04", markdown: "# 第一版\n\n今天很困。\n", meta: { v: 1 } }, h2);
    const first = readEntry("2026-10-04", h2).markdown;

    // 覆盖写：旧稿应该被挪进 history/
    const r = writeEntry({ date: "2026-10-04", markdown: "# 第二版\n\n今天更困。\n", meta: { v: 2 } }, h2);
    ok("覆盖时返回了留档路径", typeof r.archived === "string" && r.archived.length > 0);

    const hist = listHistory("2026-10-04", h2);
    eq("历史里有 1 稿", hist.length, 1);
    const old = readFileSync(hist[0].file, "utf8");
    ok("旧稿内容完整保留", old.includes("第一版") && old.includes("今天很困"));
    ok("当前稿是新的", readEntry("2026-10-04", h2).markdown.includes("第二版"));

    // 再覆盖一次 → 两稿
    writeEntry({ date: "2026-10-04", markdown: "# 第三版\n", meta: { v: 3 } }, h2);
    ok("第二次覆盖后历史累加到 2 或以上", listHistory("2026-10-04", h2).length >= 2);

    // 首次写入不该产生留档
    const h3 = mkdtempSync(join(tmpdir(), "fatfish-hist2-"));
    writeEntry({ date: "2026-10-05", markdown: "# 全新\n", meta: {} }, h3);
    eq("首次写入不留档", listHistory("2026-10-05", h3), []);
    ok("historyDir 路径正确", historyDir(h3).endsWith("history"));
    ok("archiveExisting 无稿时返回 null", archiveExisting("2026-10-06", h3) === null);
    rmSync(h3, { recursive: true, force: true });
  } finally {
    rmSync(h2, { recursive: true, force: true });
  }
}

/* ============================================================
 * 10. 自画像与图标
 * ============================================================ */
group("自画像与图标");

{
  const a = avatarSvg({ size: 96 });
  ok("自画像是非空 SVG", a.startsWith("<svg") && a.trimEnd().endsWith("</svg>"));
  ok("自画像带尺寸", a.includes('width="96"') && a.includes('height="96"'));
  ok("自画像有 viewBox", a.includes('viewBox="0 0 200 200"'));
  ok("自画像可访问名", a.includes('aria-label="吃白饭的大肥鱼"'));
  ok("自画像含围裙小鲸鱼", a.includes(WHALE_PATHS.body.slice(0, 20)));
  ok("自画像无外部引用", !/https?:\/\//.test(a.replace(/xmlns="[^"]*"/g, "")));
  // 标签配平（粗略但能抓住撕裂的标签）
  const opens = (a.match(/<(?!\/)[a-zA-Z]/g) || []).length;
  const closes = (a.match(/<\/[a-zA-Z]/g) || []).length;
  const selfClose = (a.match(/\/>/g) || []).length;
  eq("SVG 标签配平", opens, closes + selfClose);

  const i = iconSvg(18);
  ok("图标走 currentColor", i.includes('fill="currentColor"'));
  ok("图标无硬编码黑色", !i.includes('fill="#000') && !i.includes("stroke=\"#"));
  ok("图标尺寸可配", i.includes('width="14"') === false && iconSvg(14).includes('width="14"'));
  eq("图标标签配平", (i.match(/<(?!\/)[a-zA-Z]/g) || []).length, (i.match(/<\/[a-zA-Z]/g) || []).length + (i.match(/\/>/g) || []).length);

  // 不同尺寸都要能生成
  for (const s of [16, 24, 46, 96, 256]) {
    const svg = avatarSvg({ size: s });
    ok(`自画像尺寸 ${s} 正常`, svg.includes(`width="${s}"`));
  }
  ok("avatarSvg 默认参数可用", avatarSvg().includes("<svg"));
  ok("iconSvg 默认参数可用", iconSvg().includes("<svg"));
}

/* ============================================================
 * 11. 客户端 bundle 冒烟（不依赖浏览器）
 * ============================================================ */
group("客户端 bundle");

{
  const clientPath = new URL("../lib/client.js", import.meta.url);

  /** 用假的 window/document 把 __ModuleLoader__ bundle 加载起来，拿到它的模块导出 */
  const styleEls = [];
  function loadClientBundle() {
    const code = readFileSync(clientPath, "utf8");
    let spec = null;
    const fakeWindow = {
      __ModuleLoader__: { load: (s) => { spec = s; } },
      addEventListener() {},
      removeEventListener() {},
    };
    const fakeDocument = {
      head: { appendChild(node) { styleEls.push(node); } },
      body: { appendChild() {} },
      createElement: () => ({
        textContent: "",
        dataset: {},
        parentNode: null,
        setAttribute() {},
        appendChild() {},
        removeChild() {},
      }),
      getElementById: () => null,
    };
    // eslint-disable-next-line no-new-func
    new Function("window", "document", "console", code)(fakeWindow, fakeDocument, console);
    return spec;
  }

  const spec = loadClientBundle();
  ok("bundle 调用了 __ModuleLoader__.load", !!spec);
  eq("bundle id 等于包名", spec && spec.id, "fatfish-diary");
  ok("factory 是函数", spec && typeof spec.factory === "function");

  // 极简 React 替身：直接调用组件函数也能跑（hooks 退回同步实现）
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => [typeof init === "function" ? init() : init, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useCallback: (fn) => fn,
  };
  const globalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("no network in test"));

  try {
    const mod = spec.factory((name) => (name === "react" ? reactStub : undefined));
    ok("factory 返回 module.exports", !!mod && typeof mod === "object");
    ok("导出 apply 函数", typeof mod.apply === "function");
    eq("inject 声明 slots", mod.inject, ["slots"]);

    // 假的 slot 服务：inject 立即回调，register 记录注册项
    const registered = [];
    const slots = {
      inject(key, cb) {
        cb();
        return () => {};
      },
      register(meta, render) {
        registered.push({ meta, render });
        return () => {};
      },
    };
    const effects = [];
    const ctx = {
      get: (n) => (n === "slots" ? slots : undefined),
      slots,
      effect: (fn) => {
        const d = fn();
        effects.push(d);
        return () => {};
      },
      on: () => () => {},
    };

    mod.apply(ctx);

    eq("注册了 2 个插槽占位", registered.length, 2);
    const bySlot = Object.fromEntries(registered.map((r) => [r.meta.name, r]));
    ok("注册到 sidebar.footer.action", !!bySlot["sidebar.footer.action"]);
    ok("注册到 shell.overlay", !!bySlot["shell.overlay"]);
    eq("按钮 id 稳定", bySlot["sidebar.footer.action"].meta.id, "fatfish-diary-button");
    eq("面板 id 稳定", bySlot["shell.overlay"].meta.id, "fatfish-diary-panel");
    ok("按钮有 order", bySlot["sidebar.footer.action"].meta.order === 20);
    ok("label 是 thunk（跟随语言）", typeof bySlot["sidebar.footer.action"].meta.label === "function");

    // 渲染按钮（默认态：今天还没写）
    // 注意：register 的 render 返回的是**组件元素**（type 是组件函数），
    // 要再调用一层组件函数才拿得到真正的 DOM 树。
    const toTree = (el) => (el && typeof el.type === "function" ? el.type(el.props || {}) : el);

    const btnEl = bySlot["sidebar.footer.action"].render({});
    ok("按钮 render 返回组件元素", !!btnEl);
    const btn = toTree(btnEl);
    ok("按钮渲染返回元素", !!btn && btn.type === "button");
    eq("按钮 class", btn.props.className, "ffd-btn");
    // 关键回归：图标必须是内联 SVG，不能是 <img>
    // 需要把函数型节点（组件）递归展开成真正的 DOM 树。
    const expand = (n) => {
      if (!n || typeof n !== "object") return n;
      if (Array.isArray(n)) return n.map(expand);
      if (typeof n.type === "function") return expand(n.type(n.props || {}));
      return Object.assign({}, n, { children: (n.children || []).map(expand) });
    };
    const findNodes = (n, pred, out = []) => {
      if (!n || typeof n !== "object") return out;
      if (Array.isArray(n)) { for (const c of n) findNodes(c, pred, out); return out; }
      if (pred(n)) out.push(n);
      for (const c of n.children || []) findNodes(c, pred, out);
      return out;
    };
    const tree = expand(btn);
    const imgs = findNodes(tree, (n) => n.type === "img");
    const svgs = findNodes(tree, (n) => n.type === "svg");
    eq("按钮里没有 <img> 图标（currentColor 会失效）", imgs.length, 0);
    eq("按钮图标是内联 <svg>", svgs.length, 1);
    eq("内联图标用 currentColor", svgs[0].props.fill, "currentColor");
    ok("图标路径非空", typeof svgs[0].children[0].props.d === "string" && svgs[0].children[0].props.d.length > 40);
    eq("图标眼睛走 evenodd 镂空", svgs[0].children[0].props.fillRule, "evenodd");

    // 窄轨 / 宽栏两种 owner props 都要能渲染
    const wideBtn = toTree(bySlot["sidebar.footer.action"].render({ wide: true }));
    const railBtn = toTree(bySlot["sidebar.footer.action"].render({ wide: false }));
    ok("wide=true 可渲染", !!wideBtn);
    eq("宽栏 data-rail=0", wideBtn.props["data-rail"], "0");
    eq("窄轨 data-rail=1", railBtn.props["data-rail"], "1");
    // 默认（owner 不传）要当作展开态，否则文字会莫名消失
    eq("owner 不传 wide 时默认展开", toTree(bySlot["sidebar.footer.action"].render()).props["data-rail"], "0");

    // 面板默认关闭 → null（同样要先展开组件）
    eq("面板关闭时渲染 null", expand(bySlot["shell.overlay"].render({})), null);

    // 缺 slots 服务时必须优雅退出，而不是抛
    ok("没有 slots 服务时不抛", (() => {
      try {
        mod.apply({ get: () => undefined, effect: () => {}, on: () => () => {} });
        return true;
      } catch {
        return false;
      }
    })());

    // ---- 注入的样式表：把这次修的两个真 bug 钉成防回归断言 ----
    const css = styleEls.map((e) => e.textContent || "").join("\n");
    ok("样式表已注入", css.length > 500);
    ok("防回归：遮罩收回了 pointer-events（否则点击穿透点不动）", /\.ffd-mask\{[^}]*pointer-events:auto/.test(css));
    ok("防回归：主按钮用固定品牌蓝底", /\.ffd-act\.primary\{background:#3f8fe0/.test(css));
    ok(
      "防回归：主按钮不再拿主题令牌当底色（曾导致白底白字）",
      !/background:var\(--dsw-alias-brand-primary/.test(css),
    );
    ok("交互控件用内联 currentColor 图标", css.includes(".ffd-btn .ffd-btn-ico svg"));
    ok("窄轨规则存在", css.includes('.ffd-btn[data-rail="1"] .ffd-btn-txt{display:none'));

    // ---- Markdown 渲染器 ----
    const internals = mod.__internals || {};
    const rm = internals.renderMarkdown;
    ok("导出了 renderMarkdown 供测试", typeof rm === "function");

    if (typeof rm === "function") {
      // 落盘时的文件头出处注释不能出现在界面上（转义后它会变成一段可见裸文本）
      const withComment = rm("<!-- 大肥鱼日记 · 2026-10-04 · 由 DSH 插件 fatfish-diary 生成 -->\n\n# 第 45 天 · 2026-10-04\n\n今天很困。");
      ok("HTML 注释被吃掉", !withComment.includes("<!--") && !withComment.includes("&lt;!--"), withComment.slice(0, 80));
      ok("注释里的字也没漏出来", !withComment.includes("生成 --&gt;") && !withComment.includes("由 DSH 插件"));
      ok("注释之后的正文照常渲染", withComment.includes("<h1>第 45 天 · 2026-10-04</h1>") && withComment.includes("今天很困。"));
      ok("正文从标题开始，没有多出空段", withComment.trimStart().startsWith("<h1>"), withComment.trimStart().slice(0, 40));

      // 多行注释、行内注释
      ok("多行注释也吃", !rm("<!-- a\nb\nc -->\n\n正文").includes("b"));
      ok("行内注释也吃", rm("前<!-- x -->后").includes("前后"));

      // 常规 markdown
      ok("标题分级", rm("## 二级").includes("<h2>二级</h2>"));
      ok("加粗", rm("**粗**").includes("<strong>粗</strong>"));
      ok("斜体", rm("这是 *斜* 的").includes("<em>斜</em>"));
      ok("行内码", rm("`code`").includes("<code>code</code>"));
      ok("无序列表", rm("- a\n- b").includes("<ul>") && rm("- a").includes("<li>a</li>"));
      ok("有序列表", rm("1. a\n2. b").includes("<ol>"));
      ok("引用", rm("> 引用").includes("<blockquote>"));
      ok("分隔线", rm("---").includes("<hr/>"));

      // 安全：非注释的 HTML 必须被转义成文本，不能穿透
      const evil = rm("<script>alert(1)</script> <img src=x onerror=y>");
      ok("script 标签被转义", !evil.includes("<script") && evil.includes("&lt;script&gt;"), evil.slice(0, 80));
      ok("img 标签被转义", !evil.includes("<img") && evil.includes("&lt;img"));

      // 抗烂输入
      for (const bad of [undefined, null, "", 0, {}]) {
        ok(`renderMarkdown 抗烂输入 ${JSON.stringify(bad)}`, typeof rm(bad) === "string");
      }
    }

    // ---- 错误不能串页 ----
    // 踩过的坑：三个标签页共用一个 store.error，实录页请求失败（旧 host 没这个接口），
    // 切回日记页就把那条 404 显示出来了 —— 明明日记好好的。
    const parts = mod.__internals || {};
    if (typeof parts.Panel === "function" && parts.store) {
      const pstore = parts.store;
      const texts = (node, out = []) => {
        if (node === null || node === undefined || node === false || node === true) return out;
        if (Array.isArray(node)) {
          for (const c of node) texts(c, out);
          return out;
        }
        if (typeof node === "string" || typeof node === "number") {
          out.push(String(node));
          return out;
        }
        if (typeof node !== "object") return out;
        if (typeof node.type === "function") {
          try {
            texts(node.type(node.props || {}), out);
          } catch {
            /* 组件抛错就当它没输出 */
          }
          return out;
        }
        // 日记正文是用 dangerouslySetInnerHTML 渲染的，没有 children 可走 —— 漏了它
        // 就会误判成"正文没显示"。
        const raw = node.props && node.props.dangerouslySetInnerHTML && node.props.dangerouslySetInnerHTML.__html;
        if (raw) out.push(String(raw));
        for (const c of node.children || []) texts(c, out);
        return out;
      };
      const phrase = (state) => {
        pstore.set(state);
        return texts(expand(parts.Panel())).join(" ");
      };

      const baseState = {
        open: true,
        today: "2026-10-04",
        date: "2026-10-04",
        markdown: "# 第 45 天 · 2026-10-04\n\n今天很困。",
        entries: [],
        entryCount: 0,
        dates: [],
        streak: null,
        rollups: [],
        streaming: false,
        rollupStreaming: false,
        transcriptLoading: false,
        transcript: "",
        transcriptSegments: [],
        transcriptRecall: "",
        transcriptError: null,
        rollupError: null,
        rollupMarkdown: "",
        rollupKey: null,
        error: null,
        notice: null,
        root: null,
        firstDay: null,
        dayNumber: null,
      };

      // 实录页失败 → 必须把话说出来（以前静默显示"还没读呢"，看起来像没反应）
      const tText = phrase({
        ...baseState,
        tab: "transcript",
        transcriptError: "看实录的接口在这台 host 上还没有（404）。重启一次 DSH 就会生效。",
      });
      ok("实录页把错误显示出来了", tText.includes("404"), tText.slice(0, 240));
      ok("实录页给了重试入口", tText.includes("再试一次"), tText.slice(0, 240));

      // 切回日记页：那条错误必须消失
      pstore.set({ tab: "today" });
      const dText = texts(expand(parts.Panel())).join(" ");
      ok("切回日记页看不到实录的错误", !dText.includes("404"), dText.slice(0, 240));
      ok("日记正文照常显示", dText.includes("今天很困"), dText.slice(0, 240));

      // 汇总失败只出现在历史页
      const hText = phrase({ ...baseState, tab: "history", rollupError: "写汇总的接口在这台 host 上还没有" });
      ok("历史页显示汇总错误", hText.includes("写汇总的接口"), hText.slice(0, 240));
      pstore.set({ tab: "today" });
      ok("汇总错误不串到日记页", !texts(expand(parts.Panel())).join(" ").includes("写汇总的接口"));

      // 日记页自己的错误仍然要显示
      const eText = phrase({ ...baseState, tab: "today", error: "模型没空，我自己凑合写" });
      ok("日记页自己的错误照常显示", eText.includes("模型没空"), eText.slice(0, 240));
    }
  } finally {
    globalThis.fetch = globalFetch;
  }
}

/* ============================================================
 * 12. 实录质量：多会话别互相淹没、子代理噪音别混进来
 * ============================================================ */
group("实录质量（多会话 / 子代理噪音）");

{
  // ---- 子代理生命周期消息必须被滤掉 ----
  // 它们是 user/message，单条两三千字，同一份报告还会来两遍，
  // 实测把一段会话的人话整个淹掉过。
  const subagentNoise = [
    "Agent 62f005b8-7070-4d43-94bb-d5e32a5d5072 sent a message: 人格模块完成（子任务：fatfish-diary persona）。",
    "Background subagent 62f005b8-7070-4d43-94bb-d5e32a5d5072 finished and will do no further work unless you send it more.",
    "Its closing message: **交付物**：`lib/persona.js`",
    "Its closing message：交付物",
    "Subagent abc123 finished",
    "[subagent] done",
  ];
  for (const s of subagentNoise) ok(`子代理生命周期被滤: ${s.slice(0, 34)}`, isInjectedNoise(s) === true);

  // 普通人话不能被误杀（尤其别把以 Agent 开头的正常提问当噪音）
  const mustKeep = [
    "Agent 是做什么的？",
    "Subagent 这个概念我不太懂",
    "我想给这个harness创造一个插件",
    "帮我看看这个 agent 配置对不对",
  ];
  for (const s of mustKeep) ok(`人话保留: ${s.slice(0, 26)}`, isInjectedNoise(s) === false);

  // ---- pickSpread：长会话要有配额，开头和结尾都留住 ----
  const seq = Array.from({ length: 20 }, (_, i) => `m${i}`);
  const sp = pickSpread(seq, 12);
  eq("pickSpread 裁到上限", sp.picked.length, 12);
  eq("pickSpread 报告省略数", sp.omitted, 8);
  eq("pickSpread 留住开头", sp.picked[0], "m0");
  eq("pickSpread 留住结尾", sp.picked.at(-1), "m19");
  eq("pickSpread 短列原样", pickSpread(["a", "b"], 12).picked, ["a", "b"]);
  eq("pickSpread 短列不省略", pickSpread(["a", "b"], 12).omitted, 0);
  eq("pickSpread 抗非数组", pickSpread(null, 12).picked, []);

  // ---- pickSnippets：结尾必须留住（那通常是"最后做成了什么"） ----
  const ps = pickSnippets(Array.from({ length: 20 }, (_, i) => `s${i}`), 4);
  eq("pickSnippets 裁到上限", ps.length, 4);
  eq("pickSnippets 含最后一条", ps.at(-1), "s19");
  ok("pickSnippets 含开头", ps.includes("s0"));
  eq("pickSnippets 短列原样", pickSnippets(["x"], 4), ["x"]);

  // ---- extractArtifacts：文件和命令要分开 ----
  const ea = extractArtifacts("pwsh", '{"command":"Get-ChildItem -Force"}');
  eq("命令进 commands", ea.commands.length, 1);
  eq("命令不进 files", ea.files.length, 0);
  const ew = extractArtifacts("write", '{"file_path":"C:\\\\a\\\\b\\\\run.py","content":"x"}');
  ok("write 的路径进 files", ew.files.some((f) => f.includes("run.py")), JSON.stringify(ew));
  eq("坏 JSON 不抛", JSON.stringify(extractArtifacts("x", "{oops")), JSON.stringify({ files: [], commands: [] }));
  eq("null 参数不抛", JSON.stringify(extractArtifacts("x", null)), JSON.stringify({ files: [], commands: [] }));
  eq("非对象参数不抛", JSON.stringify(extractArtifacts("x", '"str"')), JSON.stringify({ files: [], commands: [] }));

  // ---- 端到端：A 话多但全是命令，B 话少但真造了文件 ----
  const date = "2026-10-04";
  const { start } = localDayWindow(date);
  const t = start + 3600_000;

  const evA = [{ type: "turn/start", seq: 1, time: t, data: { turn: 1 } }];
  for (let i = 0; i < 20; i++) {
    evA.push({ type: "user/message", seq: 2 + i, time: t + i * 100, data: { content: [{ type: "text", text: `A说第${i}句` }] } });
  }
  for (let i = 0; i < 30; i++) {
    evA.push({ type: "tool/call", seq: 100 + i, time: t + 5000 + i, data: { name: "run_code", arguments: JSON.stringify({ command: `echo A${i}` }) } });
  }

  const evB = [
    { type: "turn/start", seq: 1, time: t + 10, data: { turn: 1 } },
    { type: "user/message", seq: 2, time: t + 20, data: { content: [{ type: "text", text: "帮我做一个插件" }] } },
    { type: "tool/call", seq: 3, time: t + 30, data: { name: "write", arguments: JSON.stringify({ file_path: "C:\\\\proj\\\\lib\\\\index.js" }) } },
    { type: "tool/call", seq: 4, time: t + 40, data: { name: "write", arguments: JSON.stringify({ file_path: "C:\\\\proj\\\\lib\\\\client.js" }) } },
    { type: "assistant/message", seq: 5, time: t + 50, data: { message: { role: "assistant", content: [{ type: "text", text: "插件做好了，两个文件都写了。" }] } } },
    { type: "user/message", seq: 6, time: t + 60, data: { content: [{ type: "text", text: "Agent deadbeef-1234-5678-9abc-def012345678 sent a message: 人格模块完成，只写了 persona.js" }] } },
    { type: "user/message", seq: 7, time: t + 70, data: { content: [{ type: "text", text: "Background subagent deadbeef finished and will do no further work." }] } },
  ];

  const dg = buildDigest({
    date,
    dayNumber: 1,
    sessions: [
      { id: "A", cwd: "C:\\other", createdAt: t, origin: null, delegationDepth: 0, events: evA, source: "disk" },
      { id: "B", cwd: "C:\\proj", createdAt: t, origin: null, delegationDepth: 0, events: evB, source: "disk" },
    ],
  });
  const tr = renderTranscript(dg);

  ok("两段会话都出现在实录里", tr.includes("【项目：other】") && tr.includes("【项目：proj】"));
  ok("子代理报告没混进实录", !tr.includes("sent a message:"));
  ok("子代理结束通知没混进实录", !tr.includes("will do no further work"));
  ok("人话配额生效（20 句被裁到 12）", tr.includes("（中间还有 8 句，略）"));
  ok("人话保留了开头", tr.includes("A说第0句"));
  ok("人话保留了结尾", tr.includes("A说第19句"));
  ok("真造出来的文件单独成行", tr.includes("我写/改出来的文件：") && tr.includes("index.js"));
  ok("旧的混合字段不再出现", !tr.includes("我碰过的东西："));
  ok("实录长度可控", tr.length < 6000, `len=${tr.length}`);
}

/* ============================================================
 * 13. ⑧⑨ 固定「第 N 天」+ 连续打卡 + ⑨ 记忆 + ⑤ 汇总
 * ============================================================ */
group("固定天数 / 打卡 / 记忆 / 汇总");

{
  // ---- ⑧ resolveFirstDay：第一次算出来就钉死 ----
  const h1 = mkdtempSync(join(tmpdir(), "fatfish-meta-"));
  try {
    eq("初始没有 meta", readMeta(h1), {});
    const r1 = resolveFirstDay(h1, "2026-08-21");
    eq("首次返回估算值", r1.firstDay, "2026-08-21");
    eq("首次不算钉住的", r1.pinned, false);
    eq("meta 已落盘", readMeta(h1).firstDay, "2026-08-21");

    // 之后即使估算变了也不能动 —— 这正是这个函数存在的意义
    const r2 = resolveFirstDay(h1, "2020-01-01");
    eq("再次用钉住的值", r2.firstDay, "2026-08-21");
    eq("标记为钉住", r2.pinned, true);

    const h1b = mkdtempSync(join(tmpdir(), "fatfish-meta2-"));
    eq("没估算也没 meta → null", resolveFirstDay(h1b, null).firstDay, null);
    eq("没有 firstDay 时不写 meta", readMeta(h1b).firstDay, undefined);
    // 坏 meta 不能让它崩，也不能被当成有效值
    writeMeta({ firstDay: "不是日期" }, h1b);
    eq("坏 firstDay 被忽略", resolveFirstDay(h1b, null).firstDay, null);
    rmSync(h1b, { recursive: true, force: true });
  } finally {
    rmSync(h1, { recursive: true, force: true });
  }

  // ---- ⑨ streakOf ----
  eq("空集合 current=0", streakOf([], "2026-10-04").current, 0);
  eq("只有今天", streakOf(["2026-10-04"], "2026-10-04").current, 1);
  eq("今天+昨天+前天", streakOf(["2026-10-02", "2026-10-03", "2026-10-04"], "2026-10-04").current, 3);
  // 今天还没写不该算断 —— 白天还没到点呢
  eq("今天没写但从昨天连续", streakOf(["2026-10-02", "2026-10-03"], "2026-10-04").current, 2);
  eq("今天和昨天都没写 → 0", streakOf(["2026-10-02"], "2026-10-04").current, 0);
  eq("中间断了就从断点重算", streakOf(["2026-09-30", "2026-10-01", "2026-10-03", "2026-10-04"], "2026-10-04").current, 2);
  eq("longest 取历史最长", streakOf(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-04"], "2026-10-04").longest, 3);
  eq("total 只数合法日期", streakOf(["2026-10-04", "bogus", "", null], "2026-10-04").total, 1);
  eq("wroteToday", streakOf(["2026-10-04"], "2026-10-04").wroteToday, true);
  eq("没写时 wroteToday 为假", streakOf(["2026-10-03"], "2026-10-04").wroteToday, false);
  eq("跨月连续", streakOf(["2026-09-30", "2026-10-01"], "2026-10-01").current, 2);
  eq("跨年连续", streakOf(["2026-12-31", "2027-01-01"], "2027-01-01").current, 2);
  ok("抗非数组", streakOf(null, "2026-10-04").current === 0);
  ok("坏 today 用当天兜底", typeof streakOf(["2026-10-04"], "nope").current === "number");

  // ---- ⑤ ISO 周 / 月 ----
  eq("周 key", rollupKeyFor("week", "2026-10-04"), "2026-W40");
  eq("月 key", rollupKeyFor("month", "2026-10-04"), "2026-10");
  eq("周窗口（周一到周日）", rollupWindow("week", "2026-10-04"), { from: "2026-09-28", to: "2026-10-04" });
  eq("月窗口", rollupWindow("month", "2026-10-04"), { from: "2026-10-01", to: "2026-10-31" });
  eq("二月窗口（平年）", rollupWindow("month", "2026-02-10"), { from: "2026-02-01", to: "2026-02-28" });
  eq("跨年周 key", rollupKeyFor("week", "2027-01-01"), "2026-W53");

  // ---- 记忆压缩 ----
  eq("condense 去注释去标题", condenseMarkdown("<!-- x -->\n# 标题\n\n正文"), "正文");
  ok("condense 超长截断带省略号", condenseMarkdown("啊".repeat(100), 10).endsWith("…"));
  eq("condense 抗 null", condenseMarkdown(null), "");

  // ---- recentEntries：只往回取，绝不会把"未来"当记忆 ----
  const h2 = mkdtempSync(join(tmpdir(), "fatfish-recent-"));
  try {
    for (const d of ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-05"]) {
      writeEntry({ date: d, markdown: `# ${d}\n\n这天的事`, meta: { dayNumber: Number(d.slice(-2)) } }, h2);
    }
    const rec = recentEntries(2, "2026-10-04", h2);
    eq("只取目标日之前的", rec.map((e) => e.date), ["2026-10-02", "2026-10-03"]);
    eq("带上 dayNumber", rec[0].dayNumber, 2);
    eq("0 天就是空", recentEntries(0, "2026-10-04", h2), []);
    eq("负数当 0", recentEntries(-3, "2026-10-04", h2), []);
    eq("目标日很早 → 空", recentEntries(3, "2026-01-01", h2), []);
    // 10-04 没写、10-05 写了：中间断一天不该让往前取停住
    eq("断天不停住往前取", recentEntries(3, "2026-10-06", h2).map((e) => e.date), [
      "2026-10-02",
      "2026-10-03",
      "2026-10-05",
    ]);
  } finally {
    rmSync(h2, { recursive: true, force: true });
  }

  // ---- 汇总落盘 ----
  const h3 = mkdtempSync(join(tmpdir(), "fatfish-roll-"));
  try {
    eq("初始没有汇总", listRollups(h3), []);
    eq("读不存在的返回 null", readRollup("week", "2026-10-04", h3), null);
    writeRollup({ range: "week", date: "2026-10-04", markdown: "# 周记 · a ~ b\n\n这周很困。", meta: { written: 3 } }, h3);
    const got = readRollup("week", "2026-10-04", h3);
    eq("周记 key", got.key, "2026-W40");
    ok("周记正文带来源注释", got.markdown.startsWith("<!--"));
    ok("周记正文完整", got.markdown.includes("这周很困"));
    eq("周记元信息", got.meta.written, 3);
    writeRollup({ range: "month", date: "2026-10-04", markdown: "# 月记 · 2026-10\n", meta: {} }, h3);
    const list = listRollups(h3);
    eq("列出两篇", list.length, 2);
    ok("能区分周/月", list.some((r) => r.range === "week") && list.some((r) => r.range === "month"));
    ok("能解析标题", list.some((r) => /周记|月记/.test(r.title || "")));
  } finally {
    rmSync(h3, { recursive: true, force: true });
  }
}

/* ============================================================
 * 14. 人格模块：记忆与汇总
 * ============================================================ */
group("人格：记忆与汇总");

{
  ok("PERSONA_SYSTEM 加了记忆小节", /记得|记忆|前几天/.test(PERSONA_SYSTEM));
  ok("PERSONA_SYSTEM 仍够长", PERSONA_SYSTEM.length > 1500, `len=${PERSONA_SYSTEM.length}`);
  ok("PERSONA_SYSTEM 无裸反引号", !PERSONA_SYSTEM.includes("`"));
  ok("ROLLUP_SYSTEM 够长", ROLLUP_SYSTEM.length > 400, `len=${ROLLUP_SYSTEM.length}`);
  ok("ROLLUP_SYSTEM 无裸反引号", !ROLLUP_SYSTEM.includes("`"));
  ok("ROLLUP_SYSTEM 提到不许编造", /编造|不许编|绝不/.test(ROLLUP_SYSTEM));

  // buildRecall
  eq("buildRecall 空数组 → ''", buildRecall([]), "");
  eq("buildRecall null → ''", buildRecall(null), "");
  eq("buildRecall 非数组 → ''", buildRecall("x"), "");
  ok("buildRecall 抗全坏数据", buildRecall([null, {}, 5, { markdown: 123 }]) === "");
  const rec = buildRecall([
    { date: "2026-10-02", dayNumber: 43, markdown: "<!-- c -->\n# 标题\n\n前天在修 bug。" },
    { date: "2026-10-03", dayNumber: 44, markdown: "昨天很困，白饭吃了两碗。" },
  ]);
  ok("buildRecall 有内容", rec.length > 0);
  ok("buildRecall 含日期", rec.includes("2026-10-03"));
  ok("buildRecall 含正文", rec.includes("昨天很困"));
  ok("buildRecall 去掉了 HTML 注释", !rec.includes("<!--"));
  ok("buildRecall 去掉了标题行", !rec.includes("# 标题"));
  ok("buildRecall 长度可控", rec.length <= 1600, `len=${rec.length}`);
  // 只取最近 N 条
  const many = buildRecall(
    Array.from({ length: 8 }, (_, i) => ({ date: `2026-10-0${i + 1}`, dayNumber: i + 1, markdown: `第${i + 1}天的事` })),
  );
  ok("只取最近几条（旧的不出现）", !many.includes("第1天的事"), many.slice(0, 120));

  // FALLBACK_ROLLUP
  const fr = FALLBACK_ROLLUP({
    label: "这一周",
    from: "2026-09-28",
    to: "2026-10-04",
    days: 7,
    written: 3,
    entries: [{ date: "2026-10-04", markdown: "# t\n\n今天很困" }],
    stats: { userTurns: 20, toolCalls: 100, tokens: 1234567, projects: ["Create"] },
  });
  ok("兜底汇总含 label", fr.includes("这一周"));
  ok("兜底汇总含区间", fr.includes("2026-09-28") && fr.includes("2026-10-04"));
  ok("兜底汇总非空", fr.length > 60);

  for (const [i, bad] of [undefined, null, {}, 0, "", [], { from: 1, to: null, entries: [null] }].entries()) {
    let out;
    let threw = false;
    try {
      out = FALLBACK_ROLLUP(bad);
    } catch {
      threw = true;
    }
    ok(`兜底汇总抗烂输入 #${i}`, !threw && typeof out === "string" && !out.includes("undefined"));
  }
}

/* ============================================================
 * 汇总
 * ============================================================ */
console.log(`\n${"─".repeat(52)}`);
if (fail === 0) {
  console.log(`全部通过：${pass} 项断言`);
} else {
  console.log(`通过 ${pass} 项，失败 ${fail} 项：`);
  for (const f of failures) console.log("  ✗ " + f);
}
console.log("─".repeat(52));
process.exit(fail === 0 ? 0 : 1);
