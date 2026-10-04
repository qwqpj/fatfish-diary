/**
 * 开发用探针：对着真实的 DSH 会话目录跑一遍采集器。
 * 用法： node scripts/probe.mjs [YYYY-MM-DD]
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { collectDay, buildDigest, renderTranscript, digestSummary, listSessionSources, todayStr, estimateFirstDay, dayNumberOf } from "../lib/collect.js";

const home = process.env.DSH_HOME || join(homedir(), ".dsh");
const date = process.argv[2] || todayStr();

console.log("DSH_HOME =", home);
console.log("target date =", date);

const firstDay = estimateFirstDay(home);
console.log("第一天 =", firstDay, " → 第", dayNumberOf(firstDay, date), "天");

const t0 = Date.now();
const sources = listSessionSources(home);
console.log(`会话源文件：${sources.length} 个（扫描 ${Date.now() - t0}ms）`);
const versions = new Map();
for (const s of sources) versions.set(s.version, (versions.get(s.version) ?? 0) + 1);
console.log("日志版本分布：", JSON.stringify([...versions.entries()]));

const t1 = Date.now();
const raw = collectDay({ homeDir: home, date });
console.log(`采集到 ${raw.sessions.length} 段会话（耗时 ${Date.now() - t1}ms）`);

const digest = buildDigest({ date, dayNumber: dayNumberOf(firstDay, date), sessions: raw.sessions });
console.log("\n=== summary ===");
console.log(JSON.stringify(digestSummary(digest), null, 1));

console.log("\n=== transcript ===");
const tr = renderTranscript(digest);
console.log(`(共 ${tr.length} 字符)`);
console.log(tr.slice(0, 3000));
