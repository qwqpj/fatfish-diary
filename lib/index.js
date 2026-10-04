/**
 * fatfish-diary — Host 半边。
 *
 * 职责：
 *   1. 采集「今天」这台机器上所有会话（磁盘上的 .jsonl.zstd + 内存里的活动会话）；
 *   2. 交给人格模块提示词，让「吃白饭的大肥鱼」以 harness 自己的第一人称写一篇日记；
 *   3. 落到 <DSH_HOME>/fatfish-diary/diary/<date>.md，永久保存；
 *   4. 通过同源 HTTP 路由把状态/正文/流式生成结果交给浏览器半边。
 *
 * Browser 半边（lib/client.js）只做展示，所有逻辑都在这里。
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  collectDay,
  buildDigest,
  renderTranscript,
  digestSummary,
  isEmptyDigest,
  todayStr,
  estimateFirstDay,
  dayNumberOf,
} from "./collect.js";
import { PERSONA_SYSTEM, FALLBACK_TEMPLATE, ROLLUP_SYSTEM, buildRecall, FALLBACK_ROLLUP } from "./persona.js";
import { avatarSvg, iconSvg } from "./avatar.js";
import {
  storeState,
  readEntry,
  writeEntry,
  deleteEntry,
  hasEntry,
  listEntries,
  historyDir,
  diaryRoot,
  resolveFirstDay,
  streakOf,
  listDates,
  recentEntries,
  readRollup,
  writeRollup,
  listRollups,
  rollupWindow,
  rollupKeyFor,
} from "./store.js";

export const name = "fatfish-diary";

/**
 * 硬依赖 webServer：Loader 会等到 HTTP 服务器挂载后才 apply，
 * 否则注册会静默落空（参考 dsh-plugin-wallpaper-engine 的同一处理）。
 */
export const inject = ["webServer"];

const BASE = "/fatfish-diary";
const LLM_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 写日记时往回带几天的记忆。
 * 3 天足够形成"昨天那条线今天接上了"的连续感，再多只是白烧 token。
 */
const RECALL_DAYS = 3;

/** 面板可以回看/补写多少天 */
const BACKFILL_DAYS = 60;

/** 插件根目录（lib/ 的上一层），用来找用户放的 assets/ */
const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * 用户可以把图丢进 <插件目录>/assets/ 覆盖内置素材。
 * 文件名（不含扩展名）就是槽位名：avatar / writing / …，扩展名按下面顺序取第一个存在的。
 * PNG 排最前，因为抠好的人像通常是透明 PNG。
 */
const ASSET_EXTS = [
  ["png", "image/png"],
  ["webp", "image/webp"],
  ["gif", "image/gif"],
  ["apng", "image/apng"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["svg", "image/svg+xml; charset=utf-8"],
];

const ASSET_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** 查一个素材槽位，没有就返回 null。名字走白名单正则，杜绝路径穿越。 */
function findAsset(name) {
  if (typeof name !== "string" || !ASSET_NAME_RE.test(name)) return null;
  const dir = join(PLUGIN_DIR, "assets");
  for (const [ext, type] of ASSET_EXTS) {
    const p = join(dir, `${name}.${ext}`);
    try {
      if (existsSync(p)) return { path: p, type, ext, name };
    } catch {
      /* 忽略 */
    }
  }
  return null;
}

/** assets/ 下现有的槽位名，给界面自检用 */
function listAssetNames() {
  const dir = join(PLUGIN_DIR, "assets");
  const out = new Set();
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  for (const f of files) {
    const m = /^([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9]{1,5})$/.exec(f);
    if (m && ASSET_EXTS.some(([e]) => e === m[2].toLowerCase())) out.add(m[1]);
  }
  return [...out].sort();
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function sendJson(res, code, payload) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let raw = "";
    let over = false;
    req.on("data", (c) => {
      if (over) return;
      raw += c;
      if (raw.length > limit) {
        over = true;
        raw = "";
      }
    });
    req.on("end", () => {
      if (over || !raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function urlOf(req) {
  try {
    return new URL(req.url ?? "/", "http://127.0.0.1");
  } catch {
    return new URL("http://127.0.0.1/");
  }
}

/**
 * 会不会是一次跨站请求？
 *
 * 插件的 exact 路由不受 SPA 的认证门保护（只有挂在后面的 SPA 回退才要令牌），
 * 所以本机上任何一个网页都能 fetch 到 /fatfish-diary/write——而那条路由会真的去调模型、花钱。
 * 浏览器自带的这两个头无法被页面伪造，用它们挡掉跨站来源就够了。
 */
export function isCrossSite(req) {
  const headers = (req && req.headers) || {};
  const site = headers["sec-fetch-site"];
  if (typeof site === "string" && site.toLowerCase() === "cross-site") return true;
  const origin = headers["origin"];
  if (typeof origin === "string" && origin) {
    // 同源的 EventSource 不带 Origin；带了就必须是我们自己（loopback 或 electron 的 dsh-app）。
    if (/^(https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?|dsh-app:)/i.test(origin)) return false;
    return true;
  }
  return false;
}

function rejectCrossSite(res) {
  sendJson(res, 403, { ok: false, error: "跨站请求被拒绝" });
}

function log(ctx, level, msg) {
  try {
    const l = ctx.logger ?? ctx.get?.("logger");
    if (l && typeof l[level] === "function") l[level](`[fatfish-diary] ${msg}`);
  } catch {
    /* 日志不是关键路径 */
  }
}

/* ------------------------------------------------------------------ *
 * 采集
 * ------------------------------------------------------------------ */

/** 把内存里活着的会话（事件可能还没落盘）快照出来 */
function liveSessionSnapshots(ctx) {
  const out = [];
  try {
    const svc = ctx.get("sessions");
    if (!svc || typeof svc.list !== "function") return out;
    for (const s of svc.list()) {
      try {
        const h = s?.header ?? {};
        out.push({
          id: String(s.id),
          cwd: h.cwd ?? null,
          createdAt: h.createdAt ?? null,
          origin: h.origin ?? null,
          delegationDepth: h.delegationDepth ?? 0,
          agentPreset: h.agentPreset ?? null,
          events: typeof s.ownEvents === "function" ? s.ownEvents() : [],
        });
      } catch {
        /* 单个会话读失败不该拖垮整天 */
      }
    }
  } catch {
    /* sessions 服务不存在也能靠磁盘日志工作 */
  }
  return out;
}

/**
 * 采集 + 折叠成 digest。
 * 「第 N 天」的起点第一次算出来就钉进 meta.json ——
 * 会话目录被清理或换机器都不该让这个每天看的数字突然跳。
 */
function buildDayDigest(ctx, date) {
  const home = dshHome();
  const raw = collectDay({ homeDir: home, date, liveSessions: liveSessionSnapshots(ctx) });
  const { firstDay } = resolveFirstDay(home, estimateFirstDay(home));
  const dayNumber = firstDay ? dayNumberOf(firstDay, date) : 1;
  const digest = buildDigest({ date, dayNumber, sessions: raw.sessions });
  return { digest, firstDay };
}

/* ------------------------------------------------------------------ *
 * 调模型
 * ------------------------------------------------------------------ */

async function callLlm(ctx, { system, user, signal, onDelta }) {
  const llm = ctx.get("llm");
  if (!llm || typeof llm.stream !== "function") {
    throw new Error("llm 服务不可用");
  }

  let selection = {};
  try {
    selection = ctx.get("agentDefaultModel")?.currentSelection?.() ?? {};
  } catch {
    selection = {};
  }
  const provider = selection.provider || "deepseek-account";
  const model = selection.model || "deepseek-flash";

  const baseConfig = { provider, model };
  if (selection.reasoningEffort) baseConfig.reasoningEffort = selection.reasoningEffort;

  // prepareCall 会把 adapter 默认值定下来，并绑定一次注册；
  // 老一些的宿主没有它，退回裸 stream()。
  let config = baseConfig;
  let streamFn = (opts) => llm.stream(opts);
  if (typeof llm.prepareCall === "function") {
    try {
      const prepared = await llm.prepareCall(baseConfig, signal);
      if (prepared && typeof prepared.stream === "function") {
        config = prepared.config ?? baseConfig;
        streamFn = (opts) => prepared.stream(opts);
      }
    } catch {
      /* 退回裸 stream */
    }
  }

  let text = "";
  let usage = null;
  let finishReason = null;
  const stream = streamFn({
    ...config,
    system,
    messages: [{ role: "user", content: [{ type: "text", text: user }] }],
    signal,
  });

  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== "object") continue;
    if (chunk.type === "text-delta" && typeof chunk.text === "string") {
      text += chunk.text;
      if (onDelta) {
        try {
          onDelta(chunk.text);
        } catch {
          /* 下游断了不该中断生成 */
        }
      }
    } else if (chunk.type === "usage") {
      usage = chunk.usage ?? null;
    } else if (chunk.type === "finish") {
      finishReason = chunk.reason ?? null;
    }
  }

  if (!text.trim()) throw new Error("模型没有返回任何文字");
  return { text: text.trim(), usage, finishReason, provider, model };
}

/**
 * 拼给模型的用户消息：只给事实，语气交给人格模块。
 * `recall` 是「你还记得的前几天」——由 persona 模块的 buildRecall 生成，没有就空着。
 */
function buildUserPrompt({ date, dayNumber, transcript, empty, recall }) {
  const head = [
    `今天是 ${date}，是我陪主人的第 ${dayNumber} 天。`,
    "",
    empty
      ? "下面是今天的实录——很遗憾，今天主人一次都没来找我："
      : "下面是我今天整理出来的实录。这是我唯一的事实来源：",
    "",
    "----- 今日实录开始 -----",
    transcript,
    "----- 今日实录结束 -----",
  ];
  if (recall) {
    head.push("", recall);
  }
  head.push("", `现在写今天的日记。第一行必须是一级标题：# 第 ${dayNumber} 天 · ${date}`);
  return head.join("\n");
}

/* ------------------------------------------------------------------ *
 * 生成一篇日记
 * ------------------------------------------------------------------ */

async function generateDiary(ctx, { date, force = false, onPhase, onDelta, signal }) {
  const home = dshHome();
  const target = date || todayStr();

  if (!force && hasEntry(target, home)) {
    const existing = readEntry(target, home);
    if (existing) {
      return { ...existing, reused: true, generated: false };
    }
  }

  onPhase?.("collecting");
  const { digest } = buildDayDigest(ctx, target);
  const empty = isEmptyDigest(digest);
  let transcript = renderTranscript(digest);
  if (empty) {
    transcript =
      "今天这一天在日志里是空的：0 次对话，0 次工具调用。主人一整天都没来找我。";
  }

  const summary = digestSummary(digest);

  // 连续性：把前几天自己写的日记摘要带进去，今天的日记才不会是一天一个孤岛。
  // 补写往日时同样以目标日为准往回取，不会把"未来"的日记当记忆。
  let recall = "";
  try {
    const recent = recentEntries(RECALL_DAYS, target, home);
    if (recent.length) recall = buildRecall(recent);
  } catch (err) {
    log(ctx, "error", `读取前几天的日记失败，按没有记忆处理：${err && err.message}`);
  }

  const userPrompt = buildUserPrompt({
    date: target,
    dayNumber: digest.dayNumber,
    transcript,
    empty,
    recall,
  });

  onPhase?.("thinking");

  let markdown = "";
  let model = null;
  let usage = null;
  let fellBack = false;
  let fallbackReason = null;

  try {
    const timeoutSignal = AbortSignal.timeout(LLM_TIMEOUT_MS);
    const merged = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const out = await callLlm(ctx, {
      system: PERSONA_SYSTEM,
      user: userPrompt,
      signal: merged,
      onDelta,
    });
    markdown = out.text;
    model = `${out.provider}/${out.model}`;
    usage = out.usage ?? null;
  } catch (err) {
    // 模型不可用时不能把这一天弄丢：退到模板日记，并且如实标注。
    fellBack = true;
    fallbackReason = err && err.message ? String(err.message) : String(err);
    log(ctx, "error", `模型生成失败，改用兜底模板：${fallbackReason}`);
    onPhase?.("fallback");
    // 兜底模板吃完整的 digest（它要 items / topTools 里的真实细节）
    markdown = FALLBACK_TEMPLATE(digest);
  }

  // 保险：确保标题行存在且是当天的
  if (!/^#\s+/m.test(markdown)) {
    markdown = `# 第 ${digest.dayNumber} 天 · ${target}\n\n${markdown}`;
  }

  onPhase?.("saving");
  const meta = {
    date: target,
    dayNumber: digest.dayNumber,
    generatedAt: Date.now(),
    model,
    fellBack,
    fallbackReason,
    usage,
    stats: summary,
  };
  const written = writeEntry({ date: target, markdown, meta }, home);

  return {
    date: target,
    markdown,
    meta,
    stats: summary,
    generated: true,
    reused: false,
    file: written.markdown,
    root: diaryRoot(home),
  };
}

/* ------------------------------------------------------------------ *
 * 生成一篇周记 / 月记
 * ------------------------------------------------------------------ */

/**
 * 把一段时间的日记汇总成一篇周记/月记。
 *
 * 与每日日记的关键差别：素材是**已经写好的那几篇日记**（而不是原始会话日志），
 * 所以这一层天然不会引入新事实 —— 但也要把区间统计一起给它，否则写不出"这个月忙不忙"。
 */
async function generateRollup(ctx, { range, anchor, force = false, onPhase, onDelta, signal }) {
  const home = dshHome();
  const kind = range === "month" ? "month" : "week";
  const day = anchor || todayStr();
  const { from, to } = rollupWindow(kind, day);
  const key = rollupKeyFor(kind, day);

  if (!force) {
    const existing = readRollup(kind, day, home);
    if (existing) return { ...existing, reused: true, generated: false, from, to };
  }

  onPhase?.("collecting");

  // 区间内已经写好的日记
  const all = listDates(home);
  const inRange = all.filter((d) => d >= from && d <= to);
  const entries = [];
  let userTurns = 0;
  let toolCalls = 0;
  let tokens = 0;
  const projects = [];
  for (const d of inRange) {
    const e = readEntry(d, home);
    if (!e) continue;
    entries.push({ date: d, markdown: e.markdown });
    const st = e.meta && e.meta.stats;
    if (st) {
      userTurns += Number(st.userTurns) || 0;
      toolCalls += Number(st.toolCalls) || 0;
      tokens += Number(st.tokenCount ?? st.tokens) || 0;
      for (const p of st.projects || []) if (!projects.includes(p)) projects.push(p);
    }
  }

  const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);
  const label = kind === "month" ? `${from.slice(0, 7)} 这个月` : "这一周";
  const stats = { userTurns, toolCalls, tokens, projects };
  const title = kind === "month" ? `# 月记 · ${from.slice(0, 7)}` : `# 周记 · ${from} ~ ${to}`;

  const summary = {
    label,
    from,
    to,
    days,
    written: entries.length,
    entries: entries.map((e) => ({ date: e.date, markdown: e.markdown })),
    stats,
  };

  let markdown = "";
  let model = null;
  let usage = null;
  let fellBack = false;
  let fallbackReason = null;

  if (entries.length === 0) {
    // 一篇都没有：没什么可汇总的，别去烧 token
    onPhase?.("fallback");
    fellBack = true;
    fallbackReason = "这段时间一篇日记都没有";
    markdown = FALLBACK_ROLLUP(summary);
  } else {
    onPhase?.("thinking");
    const body = entries.map((e) => `【${e.date}】\n${e.markdown}`).join("\n\n");
    const userPrompt = [
      `请给我写一篇${kind === "month" ? "月记" : "周记"}。`,
      "",
      `时间范围：${from} 到 ${to}（共 ${days} 天）`,
      `这段时间我一共写了 ${entries.length} 篇日记。`,
      `区间统计：主人说话 ${userTurns} 次，我干活 ${toolCalls} 次，嚼掉约 ${tokens} 个 token。`,
      projects.length ? `碰过的项目/目录：${projects.join("、")}` : "",
      "",
      "下面是我这些天写的日记原文，是我唯一的事实来源：",
      "",
      "----- 这些天的日记开始 -----",
      body,
      "----- 这些天的日记结束 -----",
      "",
      `现在写汇总。第一行必须是一级标题，就写：${title}`,
    ]
      .filter((l) => l !== "")
      .join("\n");

    try {
      const timeoutSignal = AbortSignal.timeout(LLM_TIMEOUT_MS);
      const merged = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const out = await callLlm(ctx, { system: ROLLUP_SYSTEM, user: userPrompt, signal: merged, onDelta });
      markdown = out.text;
      model = `${out.provider}/${out.model}`;
      usage = out.usage ?? null;
    } catch (err) {
      fellBack = true;
      fallbackReason = err && err.message ? String(err.message) : String(err);
      log(ctx, "error", `汇总生成失败，改用兜底模板：${fallbackReason}`);
      onPhase?.("fallback");
      markdown = FALLBACK_ROLLUP(summary);
    }

    if (!/^#\s+/m.test(markdown)) markdown = `${title}\n\n${markdown}`;
  }

  onPhase?.("saving");
  const written = writeRollup(
    {
      range: kind,
      date: day,
      markdown,
      meta: { key, label, from, to, days, written: entries.length, generatedAt: Date.now(), model, fellBack, fallbackReason, usage, stats },
    },
    home,
  );

  return {
    range: kind,
    key,
    from,
    to,
    markdown,
    generated: true,
    reused: false,
    fellBack,
    model,
    stats: { ...stats, days, written: entries.length },
    file: written.markdown,
  };
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  const webServer = ctx.webServer;
  if (!webServer || typeof webServer.register !== "function") {
    log(ctx, "error", "webServer 不可用，插件未挂载任何路由");
    return;
  }

  const home = dshHome();
  const disposers = [];
  /** 同一天同时只允许一次生成，避免双击写出两篇 */
  const inFlight = new Map();

  const route = (path, handler) =>
    disposers.push(webServer.register({ kind: "exact", path: `${BASE}${path}`, handler }));

  /* ---- 静态资源 ---- */

  const svgSize = (req, def, min, max) => {
    const u = urlOf(req);
    const n = Number(u.searchParams.get("size"));
    return Math.min(max, Math.max(min, Number.isFinite(n) && n > 0 ? n : def));
  };
  const noStore = (res, type) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", type);
    // 不带长缓存：用户随时可能换掉 assets/ 里的立绘，也可能我在改内置 SVG。
    res.setHeader("Cache-Control", "no-store, must-revalidate");
  };

  /**
   * 发一个素材槽位；没有就返回 false，让调用方走兜底。
   *
   * 缓存策略：no-cache + ETag（大小 + mtime）。
   * 不用 no-store —— 用户的动图两三百 KB，每次开面板都重下太浪费；
   * 也不能长缓存 —— 用户会随时换图，而且路由本来就是"每次请求现查"。
   * no-cache 的意思是"可以缓存，但每次都来问一声"，内容没变就回 304，很便宜。
   */
  const sendAsset = (req, res, name) => {
    const asset = findAsset(name);
    if (!asset) return false;
    try {
      const st = statSync(asset.path);
      const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      if (req.headers["if-none-match"] === etag) {
        res.statusCode = 304;
        res.setHeader("ETag", etag);
        res.setHeader("Cache-Control", "no-cache");
        res.end();
        return true;
      }
      const buf = readFileSync(asset.path);
      res.statusCode = 200;
      res.setHeader("Content-Type", asset.type);
      res.setHeader("Content-Length", String(buf.length));
      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "no-cache");
      res.end(buf);
      return true;
    } catch (err) {
      log(ctx, "error", `读取素材 ${name} 失败：${err && err.message}`);
      return false;
    }
  };

  /**
   * 自画像：优先 assets/avatar.*，其次内置 SVG。
   * 界面拿它当头像，所以这个地址**永远有东西可发**，不会 404。
   */
  route("/avatar", (req, res) => {
    if (sendAsset(req, res, "avatar")) return;
    noStore(res, "image/svg+xml; charset=utf-8");
    res.end(avatarSvg({ size: svgSize(req, 96, 24, 512) }));
  });

  /**
   * 通用素材槽位：/asset?name=writing。
   * 没有就 404 —— 界面先读 /state 的 assets 清单，没有才退回静态图，不会真发这个请求。
   */
  route("/asset", (req, res) => {
    const name = urlOf(req).searchParams.get("name") || "";
    if (sendAsset(req, res, name)) return;
    sendJson(res, 404, { ok: false, error: "没有这个素材", name });
  });

  // 别名：内置 SVG，忽略 assets/。留着是为了兼容旧引用与排障。
  route("/avatar.svg", (req, res) => {
    noStore(res, "image/svg+xml; charset=utf-8");
    res.end(avatarSvg({ size: svgSize(req, 96, 24, 512) }));
  });

  route("/icon.svg", (req, res) => {
    noStore(res, "image/svg+xml; charset=utf-8");
    res.end(iconSvg(svgSize(req, 18, 12, 64)));
  });

  /* ---- 状态 ---- */

  route("/state", async (req, res) => {
    try {
      const u = urlOf(req);
      const date = u.searchParams.get("date") || todayStr();
      const state = storeState(home);
      const today = todayStr();
      let stats = null;
      try {
        stats = digestSummary(buildDayDigest(ctx, date).digest);
      } catch (err) {
        log(ctx, "error", `state 采集失败：${err && err.message}`);
      }
      const names = listAssetNames();
      const dates = state.dates || [];
      const allDates = listDates(home);
      const fd = resolveFirstDay(home, null).firstDay;
      sendJson(res, 200, {
        ok: true,
        today,
        date,
        hasEntry: hasEntry(date, home),
        isToday: date === today,
        entryCount: state.count,
        firstDate: state.firstDate,
        lastDate: state.lastDate,
        entries: state.entries,
        stats,
        root: state.root,
        diaryDir: state.diaryDir,
        historyDir: historyDir(home),
        // 第 N 天与连续打卡
        firstDay: fd,
        dayNumber: fd ? dayNumberOf(fd, date) : null,
        streak: streakOf(allDates, today),
        // 面板可以往回翻多少天，以及哪些天已经有日记（省得一天一天试）
        backfillDays: BACKFILL_DAYS,
        dates,
        rollups: listRollups(home),
        // 界面据此决定用自定义素材还是内置兜底：avatar 永远可用（有 SVG 兜底），
        // writing 没有就退回会轻微上下浮动的静态自画像。
        assets: {
          avatar: names.includes("avatar"),
          writing: names.includes("writing"),
          names,
        },
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
    }
  });

  /* ---- 今天到底读到了什么（把实录原样给界面看，用于自证与排障） ---- */

  route("/transcript", async (req, res) => {
    try {
      const u = urlOf(req);
      const date = u.searchParams.get("date") || todayStr();
      const { digest, firstDay } = buildDayDigest(ctx, date);
      const empty = isEmptyDigest(digest);
      const transcript = empty
        ? "今天这一天在日志里是空的：0 次对话，0 次工具调用。主人一整天都没来找我。"
        : renderTranscript(digest);
      let recall = "";
      try {
        const recent = recentEntries(RECALL_DAYS, date, home);
        if (recent.length) recall = buildRecall(recent);
      } catch {
        /* 没有记忆不影响看实录 */
      }
      sendJson(res, 200, {
        ok: true,
        date,
        empty,
        firstDay,
        transcript,
        length: transcript.length,
        recall,
        recallDays: RECALL_DAYS,
        summary: digestSummary(digest),
        // 逐段概览，界面可以做成一行一行的"她看到了哪几段"
        segments: digest.items.map((i) => ({
          project: i.project,
          cwd: i.cwdFull,
          isSubagent: i.isSubagent,
          startTime: i.startTime,
          endTime: i.endTime,
          userTexts: i.userTexts.length,
          files: (i.writeTargets || []).concat(i.files || []).length,
          toolCalls: (i.toolNames || []).length,
        })),
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
    }
  });

  /* ---- 周记 / 月记（同样是 SSE 流式） ---- */

  route("/rollup", async (req, res) => {
    const u = urlOf(req);
    const range = u.searchParams.get("range") === "month" ? "month" : "week";
    const anchor = u.searchParams.get("anchor") || todayStr();
    const force = u.searchParams.get("force") === "1";

    // 只读：不生成，直接返回已有的那篇
    if (req.method === "GET" && u.searchParams.get("peek") === "1") {
      const existing = readRollup(range, anchor, home);
      const win = rollupWindow(range, anchor);
      if (!existing) return sendJson(res, 404, { ok: false, range, ...win, key: rollupKeyFor(range, anchor) });
      return sendJson(res, 200, { ok: true, range, ...win, ...existing });
    }

    if (req.method === "POST") {
      if (isCrossSite(req)) return rejectCrossSite(res);
      try {
        const key = `${range}:${anchor}`;
        if (inFlight.has(key)) return sendJson(res, 409, { ok: false, error: "正在写，稍等一下下" });
        const p = generateRollup(ctx, { range, anchor, force: force || u.searchParams.get("force") === "1" });
        inFlight.set(key, p);
        try {
          return sendJson(res, 200, { ok: true, ...(await p) });
        } finally {
          inFlight.delete(key);
        }
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
      }
    }

    // GET without peek → SSE
    if (isCrossSite(req)) return rejectCrossSite(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    const send = (event, data) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* 客户端可能已经走了 */
      }
    };

    const key = `${range}:${anchor}`;
    if (inFlight.has(key)) {
      send("error", { message: "正在写，稍等一下下" });
      return res.end();
    }

    const controller = new AbortController();
    req.on("close", () => controller.abort());
    send("status", { phase: "start", range, anchor });

    const task = generateRollup(ctx, {
      range,
      anchor,
      force,
      signal: controller.signal,
      onPhase: (phase) => send("status", { phase, range }),
      onDelta: (text) => send("delta", { text }),
    });
    inFlight.set(key, task);

    try {
      const out = await task;
      send("done", out);
    } catch (err) {
      send("error", { message: String(err && err.message ? err.message : err) });
    } finally {
      inFlight.delete(key);
      try {
        res.end();
      } catch {
        /* 已结束 */
      }
    }
  });

  /* ---- 读某一篇 ---- */

  route("/entry", async (req, res) => {
    try {
      const u = urlOf(req);
      const date = u.searchParams.get("date") || todayStr();
      if (req.method === "DELETE") {
        if (isCrossSite(req)) return rejectCrossSite(res);
        const removed = deleteEntry(date, home);
        return sendJson(res, 200, { ok: true, removed, date });
      }
      const entry = readEntry(date, home);
      if (!entry) return sendJson(res, 404, { ok: false, error: "这一天还没有日记", date });
      return sendJson(res, 200, { ok: true, ...entry });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
    }
  });

  /* ---- 只看今天的实录统计（不生成） ---- */

  route("/preview", async (req, res) => {
    try {
      const u = urlOf(req);
      const date = u.searchParams.get("date") || todayStr();
      const { digest } = buildDayDigest(ctx, date);
      sendJson(res, 200, {
        ok: true,
        date,
        empty: isEmptyDigest(digest),
        summary: digestSummary(digest),
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
    }
  });

  /* ---- 生成（流式 SSE）：点一下按钮走这里 ---- */

  route("/write", async (req, res) => {
    if (isCrossSite(req)) return rejectCrossSite(res);

    const u = urlOf(req);
    const date = u.searchParams.get("date") || todayStr();
    const force = u.searchParams.get("force") === "1";

    // POST：非流式，直接返回 JSON（给脚本/兜底用）
    if (req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const d = body.date || date;
        const f = body.force ?? force;
        const key = d;
        if (inFlight.has(key)) {
          return sendJson(res, 409, { ok: false, error: "这一天正在写，稍等一下下", date: d });
        }
        const p = generateDiary(ctx, { date: d, force: f });
        inFlight.set(key, p);
        try {
          const out = await p;
          return sendJson(res, 200, { ok: true, ...out });
        } finally {
          inFlight.delete(key);
        }
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
      }
    }

    // GET：SSE 流式，实时把字吐给界面
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    const send = (event, data) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* 客户端可能已经走了 */
      }
    };

    if (inFlight.has(date)) {
      send("error", { message: "这一天正在写，稍等一下下" });
      return res.end();
    }

    const controller = new AbortController();
    req.on("close", () => controller.abort());

    send("status", { phase: "start", date });

    const task = generateDiary(ctx, {
      date,
      force,
      signal: controller.signal,
      onPhase: (phase) => send("status", { phase, date }),
      onDelta: (text) => send("delta", { text }),
    });
    inFlight.set(date, task);

    try {
      const out = await task;
      send("done", {
        date: out.date,
        markdown: out.markdown,
        meta: out.meta,
        stats: out.stats,
        generated: out.generated,
        reused: out.reused,
        file: out.file,
        root: out.root,
      });
    } catch (err) {
      send("error", { message: String(err && err.message ? err.message : err) });
    } finally {
      inFlight.delete(date);
      try {
        res.end();
      } catch {
        /* 已结束 */
      }
    }
  });

  /* ---- 健康检查 ---- */

  route("/health", (req, res) => {
    sendJson(res, 200, { ok: true, plugin: name, home, root: diaryRoot(home) });
  });

  ctx.effect(
    () => () => {
      for (const d of disposers) {
        try {
          d();
        } catch {
          /* 卸载时尽力而为 */
        }
      }
    },
    "fatfish-diary: dispose routes",
  );

  log(ctx, "info", `已挂载 ${disposers.length} 条路由于 ${BASE}，日记目录 ${diaryRoot(home)}`);
}

export default { name, inject, apply };
