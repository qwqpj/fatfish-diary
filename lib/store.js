/**
 * store.js — 日记的落盘层。
 *
 * 存储形态刻意选成"人类可读"：
 *   <DSH_HOME>/fatfish-diary/diary/2026-10-04.md      日记正文（Markdown）
 *   <DSH_HOME>/fatfish-diary/diary/2026-10-04.json    当天的事实底座 + 生成元信息
 *
 * 不额外维护索引文件——列表直接扫目录得到，这样永远不会出现"索引和正文对不上"。
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync, statSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 日记根目录 */
export function diaryRoot(homeDir = process.env.DSH_HOME || join(homedir(), ".dsh")) {
  return join(homeDir, "fatfish-diary");
}

export function diaryDir(homeDir) {
  return join(diaryRoot(homeDir), "diary");
}

export function assertDate(date) {
  if (!DATE_RE.test(String(date ?? ""))) throw new Error(`不是一个合法日期：${date}`);
  return String(date);
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/* ------------------------------------------------------------------ *
 * 读
 * ------------------------------------------------------------------ */

export function entryPaths(date, homeDir) {
  const d = assertDate(date);
  const dir = diaryDir(homeDir);
  return { markdown: join(dir, `${d}.md`), meta: join(dir, `${d}.json`) };
}

export function hasEntry(date, homeDir) {
  try {
    return existsSync(entryPaths(date, homeDir).markdown);
  } catch {
    return false;
  }
}

export function readEntry(date, homeDir) {
  const p = entryPaths(date, homeDir);
  if (!existsSync(p.markdown)) return null;
  let markdown = "";
  let meta = null;
  try {
    markdown = readFileSync(p.markdown, "utf8");
  } catch {
    return null;
  }
  try {
    if (existsSync(p.meta)) meta = JSON.parse(readFileSync(p.meta, "utf8"));
  } catch {
    meta = null;
  }
  return { date: assertDate(date), markdown, meta };
}

/** 列出所有日记（新的在前）。只 stat，不读正文。 */
export function listEntries(homeDir) {
  const dir = diaryDir(homeDir);
  if (!existsSync(dir)) return [];
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const date = f.slice(0, -3);
    if (!DATE_RE.test(date)) continue;
    let generatedAt = null;
    let bytes = 0;
    let title = null;
    try {
      const st = statSync(join(dir, f));
      generatedAt = st.mtimeMs;
      bytes = st.size;
    } catch {
      /* 忽略 */
    }
    // 标题行很便宜，读一小段就够
    try {
      const head = readFileSync(join(dir, f), "utf8").slice(0, 400);
      const m = /^#\s+(.+)$/m.exec(head);
      if (m) title = m[1].trim();
    } catch {
      /* 忽略 */
    }
    out.push({ date, generatedAt, bytes, title, meta: readEntryMeta(date, homeDir) });
  }
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return out;
}

/** 读某一天日记的旁挂元信息（<date>.json） */
function readEntryMeta(date, homeDir) {
  try {
    const p = entryPaths(date, homeDir).meta;
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 写
 * ------------------------------------------------------------------ */

/** 旧版本的留档目录 */
export function historyDir(homeDir) {
  return join(diaryRoot(homeDir), "history");
}

/**
 * 覆盖之前先把旧稿挪进 history/。
 * 面板上「重写这篇」是一个很容易误点的按钮，不能因为手滑就永久丢掉一整天的记录。
 */
export function archiveExisting(date, homeDir) {
  const p = entryPaths(date, homeDir);
  if (!existsSync(p.markdown)) return null;
  try {
    const dir = ensureDir(historyDir(homeDir));
    // 毫秒精度 + 碰撞自增：同一秒里连点两次"重写"也必须留下两份存档，
    // 否则第二份会把第一份覆盖掉——那就等于没留档。
    const iso = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
    let dest = join(dir, `${date}.${iso}.md`);
    for (let n = 2; existsSync(dest) && n < 1000; n++) {
      dest = join(dir, `${date}.${iso}-${n}.md`);
    }
    copyFileSync(p.markdown, dest);
    if (existsSync(p.meta)) copyFileSync(p.meta, dest.replace(/\.md$/, ".json"));
    return dest;
  } catch {
    return null; // 留档失败不该挡住新稿落盘
  }
}

/** 某一天的历次旧稿（新的在前） */
export function listHistory(date, homeDir) {
  const dir = historyDir(homeDir);
  if (!existsSync(dir)) return [];
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const prefix = `${assertDate(date)}.`;
  return files
    .filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
    .sort()
    .reverse()
    .map((f) => ({ file: join(dir, f), stamp: f.slice(prefix.length, -3) }));
}

/**
 * 落一篇日记。先写正文，再写元信息——正文是"这篇日记存在"的唯一判据，
 * 所以元信息写失败也不该让整次生成算失败。
 */
export function writeEntry({ date, markdown, meta }, homeDir) {
  const d = assertDate(date);
  const dir = ensureDir(diaryDir(homeDir));
  const p = entryPaths(d, homeDir);
  const archived = archiveExisting(d, homeDir);
  const header = `<!-- 大肥鱼日记 · ${d} · 由 DSH 插件 fatfish-diary 生成 -->\n\n`;
  writeFileSync(p.markdown, markdown.startsWith("<!--") ? markdown : header + markdown, "utf8");
  let metaWritten = false;
  try {
    writeFileSync(p.meta, JSON.stringify({ ...meta, date: d }, null, 2), "utf8");
    metaWritten = true;
  } catch {
    /* 正文已落盘，元信息可选 */
  }
  return { dir, markdown: p.markdown, meta: p.meta, metaWritten, archived };
}

export function deleteEntry(date, homeDir) {
  const p = entryPaths(date, homeDir);
  let removed = false;
  for (const f of [p.markdown, p.meta]) {
    try {
      if (existsSync(f)) {
        unlinkSync(f);
        removed = true;
      }
    } catch {
      /* 忽略 */
    }
  }
  return removed;
}

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

export function storeState(homeDir) {
  const root = diaryRoot(homeDir);
  const entries = listEntries(homeDir);
  const dates = listDates(homeDir);
  return {
    root,
    diaryDir: diaryDir(homeDir),
    count: entries.length,
    firstDate: dates.length ? dates[0] : null,
    lastDate: entries.length ? entries[0].date : null,
    entries,
    dates,
  };
}

/* ------------------------------------------------------------------ *
 * 插件自己的元信息（目前只放 firstDay）
 * ------------------------------------------------------------------ */

export function metaPath(homeDir) {
  return join(diaryRoot(homeDir), "meta.json");
}

export function readMeta(homeDir) {
  try {
    const p = metaPath(homeDir);
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function writeMeta(patch, homeDir) {
  try {
    ensureDir(diaryRoot(homeDir));
    const next = { ...readMeta(homeDir), ...patch, updatedAt: Date.now() };
    writeFileSync(metaPath(homeDir), JSON.stringify(next, null, 2), "utf8");
    return next;
  } catch {
    return readMeta(homeDir);
  }
}

/**
 * 「第 N 天」的起点。
 *
 * 以前是从最早的会话目录**推算**的（`collect.estimateFirstDay`），
 * 但会话清理、换机器、目录被删都会让 N 突然跳 —— 一个每天都看的数字不该会跳。
 * 所以第一次算出来就写进 meta.json 钉死，之后一律以它为准。
 */
export function resolveFirstDay(homeDir, estimate) {
  const meta = readMeta(homeDir);
  if (typeof meta.firstDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(meta.firstDay)) {
    return { firstDay: meta.firstDay, pinned: true };
  }
  if (typeof estimate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(estimate)) {
    writeMeta({ firstDay: estimate, firstDaySource: "estimate" }, homeDir);
    return { firstDay: estimate, pinned: false };
  }
  return { firstDay: null, pinned: false };
}

/* ------------------------------------------------------------------ *
 * 连续打卡
 * ------------------------------------------------------------------ */

/** 把 'YYYY-MM-DD' 转成本地零点毫秒 */
function dayMs(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

function shiftDay(dateStr, delta) {
  const t = dayMs(dateStr);
  return toDateStrLocal(t + delta * 86400000);
}

function toDateStrLocal(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 按"写过日记的日期集合"算连续天数。
 *
 * 今天还没写不该算断 —— 白天还没到点呢。所以从今天往回看：
 * 今天写了就从今天起算，没写就从昨天起算，再往前必须逐日连续。
 *
 * @returns {{current:number, longest:number, total:number, lastDate:string|null, wroteToday:boolean}}
 */
export function streakOf(dates, today) {
  const set = new Set((Array.isArray(dates) ? dates : []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
  const todayStr = /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : toDateStrLocal(Date.now());

  const wroteToday = set.has(todayStr);
  let cursor = wroteToday ? todayStr : shiftDay(todayStr, -1);
  let current = 0;
  // 上限只是防呆，正常不会到
  for (let i = 0; i < 10000 && set.has(cursor); i++) {
    current++;
    cursor = shiftDay(cursor, -1);
  }

  // 最长连续：把日期排序后扫一遍
  const sorted = [...set].sort();
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const d of sorted) {
    run = prev && shiftDay(prev, 1) === d ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = d;
  }

  return { current, longest, total: set.size, lastDate: sorted.length ? sorted[sorted.length - 1] : null, wroteToday };
}

/* ------------------------------------------------------------------ *
 * 往期日记（给"她还记得前几天"用）
 * ------------------------------------------------------------------ */

export function listDates(homeDir) {
  let files;
  try {
    files = readdirSync(diaryDir(homeDir));
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith(".md") && /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .map((f) => f.slice(0, -3))
    .sort();
}

/** 去掉 markdown 标题行与 HTML 注释，压成一行，便于塞进提示词 */
export function condenseMarkdown(md, max = 400) {
  const t = String(md ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^#{1,6}\s+.*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 取某一天之前（不含当天）最近 n 篇日记，按时间升序返回。
 * 只读没写过的那几天会被自然跳过 —— 记忆不该因为中间断了一天就清零。
 */
export function recentEntries(n, beforeDate, homeDir) {
  const limit = Math.max(0, Number(n) || 0);
  if (limit === 0) return [];
  const before = /^\d{4}-\d{2}-\d{2}$/.test(beforeDate) ? beforeDate : null;
  const dates = listDates(homeDir).filter((d) => (before ? d < before : true));
  const picked = dates.slice(-limit);
  const out = [];
  for (const date of picked) {
    const e = readEntry(date, homeDir);
    if (!e) continue;
    const dayNumber = e.meta && Number.isFinite(Number(e.meta.dayNumber)) ? Number(e.meta.dayNumber) : undefined;
    out.push({ date, dayNumber, markdown: e.markdown });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 周记 / 月记
 * ------------------------------------------------------------------ */

export function rollupDir(homeDir) {
  return join(diaryRoot(homeDir), "rollups");
}

/** 区间标识：week → 2026-W40（ISO 周），month → 2026-10 */
export function rollupKeyFor(range, date) {
  const [y, m, d] = String(date).split("-").map(Number);
  if (range === "month") return `${y}-${String(m).padStart(2, "0")}`;
  // ISO 周：周四所在的年决定周所属的年份
  const t = new Date(y, m - 1, d);
  const day = (t.getDay() + 6) % 7; // 周一=0
  t.setDate(t.getDate() - day + 3);
  const isoYear = t.getFullYear();
  const jan4 = new Date(isoYear, 0, 4);
  const jan4Day = (jan4.getDay() + 6) % 7;
  const week1Mon = new Date(isoYear, 0, 4 - jan4Day);
  const week = 1 + Math.round((t.getTime() - week1Mon.getTime()) / (7 * 86400000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** 区间覆盖的日期范围（含首尾） */
export function rollupWindow(range, date) {
  const [y, m, d] = String(date).split("-").map(Number);
  if (range === "month") {
    const from = new Date(y, m - 1, 1);
    const to = new Date(y, m, 0);
    return { from: toDateStrLocal(from.getTime()), to: toDateStrLocal(to.getTime()) };
  }
  const t = new Date(y, m - 1, d);
  const day = (t.getDay() + 6) % 7;
  const mon = new Date(y, m - 1, d - day);
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
  return { from: toDateStrLocal(mon.getTime()), to: toDateStrLocal(sun.getTime()) };
}

export function rollupPaths(range, date, homeDir) {
  const key = rollupKeyFor(range, date);
  const dir = rollupDir(homeDir);
  return { key, markdown: join(dir, `${key}.md`), meta: join(dir, `${key}.json`) };
}

export function writeRollup({ range, date, markdown, meta }, homeDir) {
  const p = rollupPaths(range, date, homeDir);
  ensureDir(rollupDir(homeDir));
  const label = range === "month" ? "月记" : "周记";
  const header = `<!-- 大肥鱼的${label} · ${p.key} · 由 DSH 插件 fatfish-diary 生成 -->\n\n`;
  writeFileSync(p.markdown, markdown.startsWith("<!--") ? markdown : header + markdown, "utf8");
  try {
    writeFileSync(p.meta, JSON.stringify({ ...meta, range, key: p.key }, null, 2), "utf8");
  } catch {
    /* 元信息可选 */
  }
  return { key: p.key, markdown: p.markdown };
}

export function readRollup(range, date, homeDir) {
  const p = rollupPaths(range, date, homeDir);
  if (!existsSync(p.markdown)) return null;
  let markdown = "";
  let meta = null;
  try {
    markdown = readFileSync(p.markdown, "utf8");
  } catch {
    return null;
  }
  try {
    if (existsSync(p.meta)) meta = JSON.parse(readFileSync(p.meta, "utf8"));
  } catch {
    meta = null;
  }
  return { key: p.key, range, markdown, meta };
}

export function listRollups(homeDir) {
  let files;
  try {
    files = readdirSync(rollupDir(homeDir));
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort()
    .reverse()
    .map((key) => {
      const range = /W\d+$/.test(key) ? "week" : "month";
      let title = null;
      try {
        const head = readFileSync(join(rollupDir(homeDir), `${key}.md`), "utf8").slice(0, 400);
        const m = /^#\s+(.+)$/m.exec(head);
        if (m) title = m[1].trim();
      } catch {
        /* 忽略 */
      }
      return { key, range, title };
    });
}
