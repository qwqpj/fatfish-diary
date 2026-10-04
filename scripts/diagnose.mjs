/**
 * 诊断：今天到底采集到了什么、实录是怎么拼的、有没有被截断。
 *   node scripts/diagnose.mjs [YYYY-MM-DD]
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  collectDay, buildDigest, renderTranscript, digestSummary,
  todayStr, estimateFirstDay, dayNumberOf, listSessionSources, localDayWindow,
} from "../lib/collect.js";

const home = process.env.DSH_HOME || join(homedir(), ".dsh");
const date = process.argv[2] || todayStr();
const { start, end } = localDayWindow(date);

const hm = (ms) => (ms ? new Date(ms).toTimeString().slice(0, 8) : "--:--:--");

console.log(`日期 ${date}   本地窗口 ${hm(start)} .. ${hm(end)}\n`);

console.log("═══ 磁盘上的会话源（mtime 预筛前）═══");
const all = listSessionSources(home);
const inWindow = all.filter((s) => s.mtimeMs >= start - 12 * 3600e3);
console.log(`总共 ${all.length} 个，mtime 过筛后 ${inWindow.length} 个\n`);
for (const s of inWindow.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
  console.log(`  ${hm(s.mtimeMs)}  v${s.version}  ${(s.mtimeMs - start) / 3600e3 >= 0 ? "今天" : "昨天"}  ${s.sessionId}`);
}

const raw = collectDay({ homeDir: home, date });
console.log(`\n═══ 采集结果：${raw.sessions.length} 段有当日事件 ═══`);
for (const s of raw.sessions) {
  const us = s.events.filter((e) => e.type === "user/message").length;
  const tc = s.events.filter((e) => e.type === "tool/call").length;
  const first = s.events.find((e) => typeof e.time === "number")?.time;
  const last = [...s.events].reverse().find((e) => typeof e.time === "number")?.time;
  console.log(`  ${hm(first)}..${hm(last)}  ${String(s.events.length).padStart(5)} 事件  user=${String(us).padStart(3)}  tool=${String(tc).padStart(4)}  cwd=${s.cwd ?? "?"}  src=${s.source}`);
}

const firstDay = estimateFirstDay(home);
const digest = buildDigest({ date, dayNumber: dayNumberOf(firstDay, date), sessions: raw.sessions });
console.log(`\n═══ digest ═══`);
console.log(JSON.stringify(digestSummary(digest), null, 1));

const tr = renderTranscript(digest);
const CAP = 48000;
console.log(`\n═══ 实录 ═══`);
console.log(`长度 ${tr.length}  ${tr.length > CAP ? `⚠️ 超过 ${CAP} 会被截断` : "（未超上限）"}`);
console.log(`含「截断」标记: ${tr.includes("已截断")}`);

// 看每段会话在实录里占多少
console.log("\n── 每段在实录里的位置 ──");
let cursor = 0;
for (const item of digest.items) {
  const probe = `【项目：${item.project}】`;
  const idx = tr.indexOf(probe, cursor);
  if (idx < 0) continue;
  const next = tr.indexOf("【项目：", idx + 1);
  const blockLen = (next < 0 ? tr.length : next) - idx;
  console.log(`  @${String(idx).padStart(6)}  长度 ${String(blockLen).padStart(6)}  ${probe}  (子代理=${item.isSubagent})`);
  cursor = idx + 1;
}

console.log("\n── 前 1200 字 ──");
console.log(tr.slice(0, 1200));

// 单独 dump 一段会话在实录里的完整内容
const want = process.argv[3];
if (want) {
  const i = tr.indexOf(`【项目：${want}】`);
  if (i < 0) console.log(`\n（实录里没有项目 ${want}）`);
  else {
    const j = tr.indexOf("【项目：", i + 1);
    const end = j < 0 ? tr.indexOf("=== 我派出去的小分身", i) : j;
    console.log(`\n═══ 【${want}】这一段在实录里的完整内容 ═══`);
    console.log(tr.slice(i, end < 0 ? tr.length : end));
  }
}
