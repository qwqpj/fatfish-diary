/**
 * collect.js — 把「今天」和 harness 的所有对话读出来，做成一份给大肥鱼写日记用的实录。
 *
 * 会话日志的真实形态（已在 DSH Desktop 2.0.7 / Node 24 上实测）：
 *   $DSH_HOME/sessions/<encoded-cwd>/<session-id>/session.v4.jsonl.zstd
 * 它是一个 **拼接的多帧 zstd 流**：每次落盘追加一个独立 zstd 帧，每帧里是若干行 JSON。
 * 用 zlib.zstdDecompressSync 解整个 buffer 只会得到第 1 帧，所以必须自己切帧。
 *
 * 切帧的坑：zstd 魔数 28 B5 2F FD 可能碰巧出现在压缩数据内部。因此这里做两重防护：
 *   1) 校验紧随其后的 Frame_Header_Descriptor 字节是否合法；
 *   2) 切片解压失败时，把终点往下一个候选魔数顺延重试。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** 会话文件名形如 session.v4.jsonl.zstd / session.v3.jsonl.zstd */
const LOG_FILE_RE = /^session\.v(\d+)\.jsonl\.zstd$/;

/* ------------------------------------------------------------------ *
 * 时间
 * ------------------------------------------------------------------ */

/** 'YYYY-MM-DD'（本地时区） */
export function toDateStr(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 今天（本地时区） */
export function todayStr(now = Date.now()) {
  return toDateStr(now);
}

/**
 * 一个本地自然日的 [start, end) 毫秒窗口。
 * 用 new Date(y, m, d) 构造，由运行时本地时区决定偏移——DSH 跑在用户机器上，这正是我们要的。
 */
export function localDayWindow(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr ?? ""));
  if (!m) throw new Error(`localDayWindow: 需要 YYYY-MM-DD，收到 ${dateStr}`);
  const [, y, mo, d] = m;
  const start = new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0).getTime();
  const end = new Date(Number(y), Number(mo) - 1, Number(d) + 1, 0, 0, 0, 0).getTime();
  return { start, end };
}

/** 本地日期相差几天（b - a），用于算「第 N 天」 */
export function daysBetween(aStr, bStr) {
  const [ay, am, ad] = String(aStr).split("-").map(Number);
  const [by, bm, bd] = String(bStr).split("-").map(Number);
  const a = new Date(ay, am - 1, ad).getTime();
  const b = new Date(by, bm - 1, bd).getTime();
  return Math.round((b - a) / 86400000);
}

/* ------------------------------------------------------------------ *
 * 多帧 zstd 解码
 * ------------------------------------------------------------------ */

/** 判断 offset 处是否像一个真的 zstd 帧头（魔数 + 合法 Frame_Header_Descriptor） */
function looksLikeFrame(buf, i) {
  for (let k = 0; k < 4; k++) if (buf[i + k] !== ZSTD_MAGIC[k]) return false;
  const fhd = buf[i + 4];
  if (fhd === undefined) return false;
  if ((fhd & 0x08) !== 0) return false; // Reserved bit 必须为 0
  if ((fhd & 0x10) !== 0) return false; // Unused bit 必须为 0
  if ((fhd & 0x03) === 3) return false; // Dictionary_ID_flag = 3 是非法值
  return true;
}

function findFrameOffsets(buf) {
  const out = [];
  const last = buf.length - 5;
  for (let i = 0; i <= last; i++) {
    if (buf[i] !== 0x28) continue;
    if (looksLikeFrame(buf, i)) out.push(i);
  }
  return out;
}

/**
 * 解一个拼接多帧的 zstd buffer，返回解码后的 UTF-8 文本。
 * 碰到误判的魔数就顺延到下一个候选边界重试。
 */
export function decodeZstdFrames(buf) {
  const offs = findFrameOffsets(buf);
  if (offs.length === 0) return "";
  const parts = [];
  for (let i = 0; i < offs.length; i++) {
    const start = offs[i];
    let decoded = null;
    // end 依次尝试：下一个候选、再下一个……最多顺延 3 次
    for (let j = i + 1; j <= Math.min(i + 4, offs.length); j++) {
      const end = j < offs.length ? offs[j] : buf.length;
      try {
        decoded = zstdDecompressSync(buf.subarray(start, end)).toString("utf8");
        break;
      } catch {
        /* 边界误判，顺延 */
      }
    }
    if (decoded === null) continue; // 这一段确实不是帧（或已损坏），跳过
    parts.push(decoded);
  }
  return parts.join("");
}

/** 把一个 .jsonl.zstd 会话文件的字节解成事件对象数组 */
export function parseSessionBytes(buf) {
  const text = decodeZstdFrames(buf);
  const events = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      /* 单行坏了不影响整天 */
    }
  }
  return events;
}

/** 读一个会话文件 */
export function readSessionFile(filePath) {
  return parseSessionBytes(readFileSync(filePath));
}

/* ------------------------------------------------------------------ *
 * 扫描磁盘上的会话
 * ------------------------------------------------------------------ */

/**
 * 列出所有会话（每个 session 目录只取版本号最高的那份日志）。
 * @returns {Array<{sessionId:string,cwd:string|null,file:string,mtimeMs:number,version:number}>}
 */
export function listSessionSources(homeDir) {
  const root = join(homeDir, "sessions");
  let projectDirs;
  try {
    projectDirs = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
  for (const pd of projectDirs) {
    if (!pd.isDirectory()) continue;
    const pdir = join(root, pd.name);
    let sessionDirs;
    try {
      sessionDirs = readdirSync(pdir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sd of sessionDirs) {
      if (!sd.isDirectory()) continue;
      const sdir = join(pdir, sd.name);
      let files;
      try {
        files = readdirSync(sdir);
      } catch {
        continue;
      }
      let best = null;
      for (const f of files) {
        const m = LOG_FILE_RE.exec(f);
        if (!m) continue;
        const version = Number(m[1]);
        if (!best || version > best.version) best = { file: f, version };
      }
      if (!best) continue;
      const full = join(sdir, best.file);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      // 会话目录的创建时间 ≈ 这个会话开始的时间，比 mtime 更接近"第一次陪主人"
      let birthMs = st.mtimeMs;
      try {
        const dst = statSync(sdir);
        if (dst.birthtimeMs > 0) birthMs = dst.birthtimeMs;
      } catch {
        /* 用 mtime 兜底 */
      }

      out.push({
        sessionId: sd.name,
        cwd: null, // 由文件头补齐
        file: full,
        mtimeMs: st.mtimeMs,
        birthMs,
        version: best.version,
      });
    }
  }
  return out;
}

/**
 * 收集目标自然日内的事件。
 *
 * @param {object} opts
 * @param {string} opts.homeDir      DSH_HOME
 * @param {string} opts.date         YYYY-MM-DD
 * @param {Array}  [opts.liveSessions] 额外的内存会话 [{id, cwd, createdAt, events}]
 * @returns {{date:string, sessions:Array}}
 */
export function collectDay({ homeDir, date, liveSessions = [] }) {
  const { start, end } = localDayWindow(date);
  // mtime 预筛：文件最后写入早于今天零点 ⇒ 不可能含今天的事件（追加会更新 mtime）
  // 留 12 小时余量，防止时钟/刷新粒度导致的边界漏读。
  const mtimeFloor = start - 12 * 3600 * 1000;

  const sessions = new Map();

  for (const src of listSessionSources(homeDir)) {
    if (src.mtimeMs < mtimeFloor) continue;
    let events;
    try {
      events = readSessionFile(src.file);
    } catch {
      continue;
    }
    if (events.length === 0) continue;

    const header = events[0]?.type === "session" ? events[0] : null;
    const inDay = events.filter(
      (e) => e?.type !== "session" && typeof e.time === "number" && e.time >= start && e.time < end,
    );
    if (inDay.length === 0) continue;
    sessions.set(src.sessionId, {
      id: src.sessionId,
      cwd: header?.cwd ?? null,
      createdAt: header?.createdAt ?? null,
      origin: header?.origin ?? null,
      delegationDepth: header?.delegationDepth ?? 0,
      agentPreset: header?.agentPreset ?? null,
      events: inDay,
      source: "disk",
    });
  }

  // 内存中的会话（当前正在聊的这个，事件可能还没落盘）——覆盖同 id 的磁盘版本
  for (const live of liveSessions) {
    if (!live || !Array.isArray(live.events)) continue;
    const inDay = live.events.filter(
      (e) => e?.type !== "session" && typeof e.time === "number" && e.time >= start && e.time < end,
    );
    if (inDay.length === 0) continue;
    sessions.set(live.id, {
      id: live.id,
      cwd: live.cwd ?? null,
      createdAt: live.createdAt ?? null,
      origin: live.origin ?? null,
      delegationDepth: live.delegationDepth ?? 0,
      agentPreset: live.agentPreset ?? null,
      events: inDay,
      source: "live",
    });
  }

  const list = [...sessions.values()].sort((a, b) => firstTime(a) - firstTime(b));
  return { date, sessions: list };
}

function firstTime(s) {
  const t = s.events.find((e) => typeof e.time === "number");
  return t ? t.time : Number.MAX_SAFE_INTEGER;
}

/* ------------------------------------------------------------------ *
 * 从事件里榨出「今天干了什么」
 * ------------------------------------------------------------------ */

const TEXT_CAP = 1600; // 单条消息进实录的硬上限

function clip(s, n = TEXT_CAP) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * 判断一条 user/message 是不是 harness 自己注入的运行时上下文，而不是人真正说的话。
 * 这些东西写进日记会变成一堆参数噪音，必须滤掉。
 *
 * 特别注意**子代理的生命周期消息**：它们以 user/message 的形式进会话，
 * 单条动辄两三千字，而且同一份交差报告会来两遍
 * （先 "Agent <id> sent a message:"，再 "Background subagent <id> finished … Its closing message:"）。
 * 实测踩过：某段会话 9231 字的实录里约 11000 字是这些（含重复），
 * 把人说过的话整个淹掉，模型最后只写得出来另一个会话的事。
 */
const NOISE_PREFIXES = [
  "<turn-trigger",
  "Current runtime context.",
  "Time sampled while preparing",
  "[Reminder]",
  "<system-reminder",
  "<command-name",
  "<local-command",
  "background job ",
  "Background job ",
  "Its closing message:",
  "Its closing message：",
];

/** 需要正则识别的前缀（带 id 之类，没法用 startsWith 精确匹配） */
const NOISE_RES = [
  /^Agent\s+[0-9a-f][0-9a-f-]{6,}\s+sent a message:/i,
  /^Background subagent\s+\S+\s+finished/i,
  /^Foreground subagent\s+\S+/i,
  /^Subagent\s+\S+\s+(?:finished|completed|done)/i,
  /^\[(?:subagent|agent-team)\]/i,
];

/** 纯附件元数据（用户只丢了张图，没打字）——不是"主人说的话" */
export function isAttachmentOnly(text) {
  const t = String(text ?? "");
  if (!/<(path|type|content|attachment)\b[^>]*>/i.test(t)) return false;
  const stripped = t
    .replace(/<path\b[^>]*>[\s\S]*?<\/path>/gi, " ")
    .replace(/<type\b[^>]*>[\s\S]*?<\/type>/gi, " ")
    .replace(/<content\b[^>]*>[\s\S]*?<\/content>/gi, " ")
    .replace(/<attachment\b[^>]*>[\s\S]*?<\/attachment>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped === "";
}

export function isInjectedNoise(text) {
  const t = String(text ?? "").trim();
  if (!t) return true;
  for (const p of NOISE_PREFIXES) if (t.startsWith(p)) return true;
  for (const re of NOISE_RES) if (re.test(t)) return true;
  if (isAttachmentOnly(t)) return true;
  // 运行时上下文块的片段标志
  if (/^(This snapshot supersedes|Current DSH file policy|Approval prompts are disabled|Browser time zone for this request|Elapsed since the preceding)/m.test(t)) {
    return true;
  }
  // 后台任务完成通知
  if (/^.*\bjob\b.*finished \[status:.*exit code:.*\]/.test(t) && t.length < 600) return true;
  return false;
}

/** 从消息的 content 块数组里取纯文本 */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") out.push(b.text);
  }
  return out.join("\n");
}

/** 只保留路径末两段，避免实录被超长绝对路径淹没 */
function shortPath(p) {
  if (typeof p !== "string" || !p) return null;
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  if (norm.length <= 48) return norm;
  const segs = norm.split("/").filter(Boolean);
  return segs.length >= 2 ? `…/${segs.slice(-2).join("/")}` : norm;
}

/**
 * 从一次工具调用的参数里提取「碰过的东西」。
 *
 * 文件和命令**分开装**：以前混在一个列表里、还按出现顺序取前 6 个，
 * 结果一个 pwsh 密集的会话里 24 个槽位全是 `$ 某条命令`，
 * 真正写过的文件名一个都露不出来 —— 而日记恰恰要靠文件名才有细节。
 */
export function extractArtifacts(toolName, argsJson) {
  let args;
  try {
    args = typeof argsJson === "string" ? JSON.parse(argsJson) : argsJson;
  } catch {
    return { files: [], commands: [] };
  }
  if (!args || typeof args !== "object") return { files: [], commands: [] };

  const files = [];
  const commands = [];
  const pushFile = (v) => {
    const s = shortPath(v);
    if (s && !files.includes(s)) files.push(s);
  };

  for (const key of ["file_path", "path", "notebook_path", "target_file", "output_path"]) {
    if (typeof args[key] === "string") pushFile(args[key]);
  }
  if (Array.isArray(args.files)) for (const f of args.files) pushFile(f);

  if (typeof args.command === "string" && args.command.trim()) {
    const c = clip(args.command, 80);
    if (!commands.includes(c)) commands.push(c);
  }
  return { files: files.slice(0, 4), commands: commands.slice(0, 1) };
}

/**
 * 从一列里挑最多 max 条，保留开头和结尾。
 * 开头是"诉求"、结尾是"结论/反馈"，中间多为过程，省略掉信息损失最小。
 */
export function pickSpread(arr, max) {
  const list = Array.isArray(arr) ? arr : [];
  if (list.length <= max) return { picked: list.slice(), omitted: 0 };
  const head = Math.max(1, Math.round(max * 0.4));
  const tail = Math.max(1, max - head);
  return {
    picked: [...list.slice(0, head), ...list.slice(-tail)],
    omitted: list.length - head - tail,
  };
}

/** 从会话的助手发言里挑几条进实录：开头一条 + 中间一条 + **结尾两条**（结尾通常是总结） */
export function pickSnippets(snippets, max = 4) {
  const list = Array.isArray(snippets) ? snippets : [];
  if (list.length <= max) return list.slice();
  const out = [list[0]];
  if (list.length > 4) out.push(list[Math.floor(list.length / 2)]);
  out.push(...list.slice(-Math.max(1, max - out.length)));
  return out;
}

/** 把某个会话的事件流压成结构化的一天记录 */
function foldSession(session) {
  const userTexts = [];
  const assistantSnippets = [];
  const toolCounts = new Map();
  const files = [];
  const commands = [];
  const toolSequence = [];
  const writeTargets = [];
  let tokens = 0;
  let turnCount = 0;
  let errors = 0;

  for (const e of session.events) {
    const d = e?.data ?? {};
    switch (e.type) {
      case "turn/start":
        turnCount++;
        break;
      case "user/message": {
        const t = clip(textOf(d.content));
        if (t && !isInjectedNoise(t)) userTexts.push(t);
        break;
      }
      case "assistant/message": {
        const t = clip(textOf(d.message?.content), 700);
        if (t) assistantSnippets.push(t);
        const u = d.usage;
        if (u) tokens += Number(u.totalTokens ?? (Number(u.inputTokens ?? 0) + Number(u.outputTokens ?? 0))) || 0;
        break;
      }
      case "tool/call": {
        const name = String(d.name ?? "unknown");
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
        toolSequence.push(name);
        const got = extractArtifacts(name, d.arguments);
        for (const f of got.files) if (!files.includes(f)) files.push(f);
        for (const c of got.commands) if (!commands.includes(c)) commands.push(c);
        // 写入类工具的产物最值得记：那才是"今天造出来的东西"
        if (/^(write|edit|create|multiedit|notebook_edit|apply_patch)$/i.test(name)) {
          try {
            const a = typeof d.arguments === "string" ? JSON.parse(d.arguments) : d.arguments;
            const p = shortPath(a?.file_path ?? a?.path ?? a?.notebook_path);
            if (p && !writeTargets.includes(p)) writeTargets.push(p);
          } catch {
            /* 参数不是 JSON 就算了 */
          }
        }
        break;
      }
      case "tool/result":
        if (d.error) errors++;
        break;
      default:
        break;
    }
  }

  return {
    id: session.id,
    cwd: session.cwd,
    project: session.cwd ? basename(String(session.cwd).replace(/[\\/]+$/, "")) || session.cwd : "(无工作目录)",
    cwdFull: session.cwd,
    origin: session.origin ?? null,
    isSubagent: session.origin === "subagent" || (session.delegationDepth ?? 0) > 0,
    startTime: firstTime(session),
    endTime: lastEventTime(session),
    userTexts,
    assistantSnippets,
    toolCounts: [...toolCounts.entries()].sort((a, b) => b[1] - a[1]),
    toolSequence,
    files: files.slice(0, 40),
    writeTargets: writeTargets.slice(0, 20),
    commands: commands.slice(0, 12),
    tokens,
    turnCount,
    errors,
    eventCount: session.events.length,
    source: session.source,
  };
}

function lastEventTime(s) {
  let t = 0;
  for (const e of s.events) if (typeof e.time === "number" && e.time > t) t = e.time;
  return t;
}

/**
 * 生成一天的总 digest。这是「事实底座」——大肥鱼只能照着它写，不许编。
 */
export function buildDigest({ date, dayNumber, sessions }) {
  const folded = sessions.map(foldSession);

  // 主会话（人真正在用的）和子代理分开：子代理不该占日记主角
  const main = folded.filter((f) => !f.isSubagent);
  const subs = folded.filter((f) => f.isSubagent);

  const allTools = new Map();
  for (const f of folded) for (const [n, c] of f.toolCounts) allTools.set(n, (allTools.get(n) ?? 0) + c);

  const projects = [];
  for (const f of main) if (f.project && !projects.includes(f.project)) projects.push(f.project);

  const userTurns = main.reduce((n, f) => n + f.userTexts.length, 0);
  const assistantTurns = main.reduce((n, f) => n + f.assistantSnippets.length, 0);
  const toolCalls = folded.reduce((n, f) => n + f.toolSequence.length, 0);
  const tokens = folded.reduce((n, f) => n + f.tokens, 0);
  const errors = folded.reduce((n, f) => n + f.errors, 0);

  const firstMs = Math.min(...folded.map((f) => f.startTime).filter((t) => t > 0), Infinity);
  const lastMs = Math.max(...folded.map((f) => f.endTime).filter((t) => t > 0), 0);

  return {
    date,
    dayNumber,
    userTurns,
    assistantTurns,
    toolCalls,
    tokenCount: tokens,
    /** 别名：人格模块（FALLBACK_TEMPLATE）按这个名字读 */
    tokens,
    errorCount: errors,
    sessions: folded.length,
    mainSessions: main.length,
    subagentSessions: subs.length,
    projects,
    topTools: [...allTools.entries()].sort((a, b) => b[1] - a[1]),
    firstActionMs: Number.isFinite(firstMs) ? firstMs : null,
    lastActionMs: lastMs || null,
    activeSpanMs: Number.isFinite(firstMs) && lastMs ? Math.max(0, lastMs - firstMs) : 0,
    items: folded.map((f) => ({
      id: f.id,
      project: f.project,
      cwdFull: f.cwdFull,
      isSubagent: f.isSubagent,
      startTime: f.startTime,
      endTime: f.endTime,
      userTexts: f.userTexts,
      assistantSnippets: f.assistantSnippets,
      toolNames: f.toolSequence,
      toolCounts: f.toolCounts,
      files: f.files,
      writeTargets: f.writeTargets,
      commands: f.commands,
      /** 兼容旧字段名 */
      artifacts: [...f.writeTargets, ...f.files],
      tokens: f.tokens,
      errors: f.errors,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * 给模型看的实录文本
 * ------------------------------------------------------------------ */

const TRANSCRIPT_CAP = 48000;

/**
 * 单段会话最多带几句"主人说的话"。
 * 不设上限的话，聊了 65 句的那段会把只聊了 4 句的那段挤没 ——
 * 而后者可能才是今天真正的主线。
 */
const MAX_USER_TEXTS = 12;

/** 把 digest 渲染成一段紧凑、信息密度高的实录，喂给大肥鱼 */
export function renderTranscript(digest) {
  const lines = [];
  const hm = (ms) => {
    if (!ms) return "--:--";
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  lines.push(`日期：${digest.date}（这是我陪主人的第 ${digest.dayNumber} 天）`);
  lines.push(
    `规模：主对话 ${digest.mainSessions} 段 / 子代理 ${digest.subagentSessions} 段；` +
      `主人说话 ${digest.userTurns} 次，我回话 ${digest.assistantTurns} 次；` +
      `工具调用 ${digest.toolCalls} 次；我总共嚼掉约 ${digest.tokenCount} 个 token。`,
  );
  if (digest.firstActionMs && digest.lastActionMs) {
    const mins = Math.round(digest.activeSpanMs / 60000);
    lines.push(`时间：从 ${hm(digest.firstActionMs)} 干到 ${hm(digest.lastActionMs)}，跨度约 ${mins} 分钟。`);
  }
  if (digest.projects.length) lines.push(`涉及项目/目录：${digest.projects.join("、")}`);
  if (digest.topTools.length) {
    lines.push(
      `最常用的工具：${digest.topTools.slice(0, 12).map(([n, c]) => `${n}×${c}`).join("、")}`,
    );
  }
  if (digest.errorCount) lines.push(`报错/失败次数：${digest.errorCount}`);

  lines.push("");
  lines.push("=== 逐段实录 ===");

  const mains = digest.items.filter((i) => !i.isSubagent);
  for (const item of mains) {
    lines.push("");
    lines.push(`【项目：${item.project}】${hm(item.startTime)}–${hm(item.endTime)}${item.cwdFull ? ` （${item.cwdFull}）` : ""}`);

    if (item.userTexts.length) {
      // 长会话会有几十条人话，全塞进去会把别的会话挤没；开头是诉求、结尾是反馈，中间省略
      const { picked, omitted } = pickSpread(item.userTexts, MAX_USER_TEXTS);
      lines.push("主人对我说：");
      for (const t of picked) lines.push(`  - ${t}`);
      if (omitted > 0) lines.push(`  - （中间还有 ${omitted} 句，略）`);
    } else {
      lines.push("（这一段里主人没直接说话）");
    }

    // 造出来的东西放最前，才是"今天干了什么"的主干
    if (item.writeTargets && item.writeTargets.length) {
      lines.push(`我写/改出来的文件：${item.writeTargets.slice(0, 20).join("、")}`);
    }
    if (item.files && item.files.length) {
      const extra = item.files.filter((f) => !(item.writeTargets || []).includes(f));
      if (extra.length) lines.push(`我看过/碰过的文件：${extra.slice(0, 20).join("、")}`);
    }
    if (item.toolCounts.length) {
      lines.push(`我干的活：${item.toolCounts.slice(0, 12).map(([n, c]) => `${n}×${c}`).join("、")}`);
    }
    // 命令只在前两类都空的时候才有意义，否则就是纯噪音
    if (item.commands && item.commands.length && !(item.files || []).length) {
      lines.push(`我敲过的一些命令：${item.commands.slice(0, 3).map((c) => `$ ${c}`).join(" ｜ ")}`);
    }
    if (item.assistantSnippets.length) {
      lines.push("我当时的回应（节选）：");
      for (const t of pickSnippets(item.assistantSnippets, 4)) lines.push(`  - ${clip(t, 400)}`);
    }
  }

  if (digest.items.some((i) => i.isSubagent)) {
    lines.push("");
    lines.push("=== 我派出去的小分身（子代理）===");
    for (const item of digest.items.filter((i) => i.isSubagent)) {
      lines.push(`  - ${item.project}：${item.toolNames.length} 次工具调用`, );
    }
  }

  let text = lines.join("\n");
  if (text.length > TRANSCRIPT_CAP) text = `${text.slice(0, TRANSCRIPT_CAP)}\n…（实录过长已截断）`;
  return text;
}

/** 一天什么都没干时的判定 */
export function isEmptyDigest(digest) {
  return !digest || digest.sessions === 0 || (digest.userTurns === 0 && digest.toolCalls === 0);
}

/**
 * 估计「我陪主人的第 1 天」——取所有会话里最早的会话目录创建时间。
 * 只做 stat，不读文件内容，很便宜。结果可以在进程内缓存。
 */
export function estimateFirstDay(homeDir) {
  let min = Infinity;
  for (const s of listSessionSources(homeDir)) {
    const t = Math.min(s.birthMs ?? Infinity, s.mtimeMs ?? Infinity);
    if (t < min) min = t;
  }
  if (!Number.isFinite(min)) return todayStr();
  return toDateStr(min);
}

/** 「第 N 天」：从最初那天算起（含当天） */
export function dayNumberOf(firstDate, date) {
  return Math.max(1, daysBetween(firstDate, date) + 1);
}

/* ------------------------------------------------------------------ *
 * 供 UI 用的轻量统计
 * ------------------------------------------------------------------ */

/** 给界面用的小卡片数据，不带长文本 */
export function digestSummary(digest) {
  return {
    date: digest.date,
    dayNumber: digest.dayNumber,
    userTurns: digest.userTurns,
    assistantTurns: digest.assistantTurns,
    toolCalls: digest.toolCalls,
    tokenCount: digest.tokenCount,
    tokens: digest.tokens ?? digest.tokenCount,
    sessions: digest.sessions,
    projects: digest.projects,
    topTools: digest.topTools.slice(0, 8),
    firstActionMs: digest.firstActionMs,
    lastActionMs: digest.lastActionMs,
  };
}
