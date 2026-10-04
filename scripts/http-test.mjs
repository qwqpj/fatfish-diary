/**
 * Host 半边集成测试：起一个真的 HTTP 服务器把插件跑起来，发真的请求。
 *
 *   node scripts/http-test.mjs
 *
 * 为什么要有这个文件：DSH 里 Host 侧的 ESM 模块会被缓存，改完必须重启才生效。
 * 这里用一个假的 ctx（但背后是真 http.Server）把 apply() 挂起来，
 * 于是路由、SSE、素材分发、落盘全都能在没有 DSH 的情况下验证。
 */

import { createServer } from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(name + (detail ? `  → ${detail}` : ""));
    console.log(`FAIL  ${name}${detail ? `  → ${detail}` : ""}`);
  }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
function group(t) {
  console.log(`\n── ${t} ──`);
}

/* ------------------------------------------------------------------ *
 * 脚手架
 * ------------------------------------------------------------------ */

/** 假的 webServer：把 register() 的路由挂到真 http.Server 上 */
function makeWebServer() {
  const routes = [];
  return {
    routes,
    register(route) {
      routes.push(route);
      return () => {
        const i = routes.indexOf(route);
        if (i >= 0) routes.splice(i, 1);
      };
    },
    dispatch(req, res) {
      let pathname = "/";
      try {
        pathname = new URL(req.url, "http://127.0.0.1").pathname;
      } catch {
        /* 用默认值 */
      }
      for (const r of routes) {
        if (r.kind === "exact" && r.path === pathname) return r.handler(req, res);
      }
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain");
      res.end("no route");
    },
  };
}

/** 假 DSH_HOME：写一个真实的会话日志（多帧 zstd），让采集链路也有东西可读 */
function makeFakeHome() {
  const home = mkdtempSync(join(tmpdir(), "fatfish-http-"));
  const now = Date.now();
  const sdir = join(home, "sessions", "--C-fake--", "session-http-1");
  mkdirSync(sdir, { recursive: true });
  if (typeof zlib.zstdCompressSync === "function") {
    const lines = [
      JSON.stringify({ type: "session", version: 4, id: "session-http-1", createdAt: now, cwd: "C:\\fake", isSeeded: false }),
      JSON.stringify({ type: "user/message", seq: 1, time: now, data: { content: [{ type: "text", text: "帮我把这个脚本修一下" }] } }),
      JSON.stringify({ type: "tool/call", seq: 2, time: now + 1, data: { name: "read", arguments: '{"file_path":"C:\\\\fake\\\\a.py"}' } }),
      JSON.stringify({ type: "assistant/message", seq: 3, time: now + 2, data: { message: { role: "assistant", content: [{ type: "text", text: "好的" }] }, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } }),
    ];
    writeFileSync(
      join(sdir, "session.v4.jsonl.zstd"),
      Buffer.concat(lines.map((l) => zlib.zstdCompressSync(Buffer.from(l + "\n", "utf8")))),
    );
  }
  return home;
}

/**
 * 一个假的 llm 服务。
 *   explode        —— prepareCall 和 stream 都挂（模拟模型彻底不可用）
 *   prepareBroken  —— 只有 prepareCall 挂，裸 stream 还能用
 *                     （这是宿主老版本或缺能力元数据时的正常降级路径，必须继续可用）
 */
function makeLlm({ explode = false, prepareBroken = false, text = "" } = {}) {
  const body = text || "# 第 3 天 · 2026-10-04\n\n今天很困，但活还是干完了。\n";
  const chunker = () => {
    if (explode) {
      return (async function* () {
        throw new Error("模拟模型不可用");
      })();
    }
    return (async function* () {
      const parts = body.match(/[\s\S]{1,24}/g) || [body];
      for (const p of parts) yield { type: "text-delta", index: 0, text: p };
      yield { type: "usage", usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 } };
      yield { type: "finish", reason: { kind: "stop" } };
    })();
  };
  return {
    async prepareCall(config) {
      if (explode || prepareBroken) throw new Error("模拟 prepareCall 不可用");
      return { config, stream: () => chunker() };
    },
    stream: () => chunker(),
  };
}

async function withServer({ home, llm, defaultModel }, fn) {
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;

  const webServer = makeWebServer();
  const disposers = [];
  const ctx = {
    webServer,
    logger: { info() {}, error() {} },
    get(name) {
      if (name === "llm") return llm;
      if (name === "agentDefaultModel") return defaultModel;
      if (name === "sessions") return { list: () => [] };
      return undefined;
    },
    effect(cb) {
      const d = cb();
      disposers.push(d);
      return () => {};
    },
  };

  const plug = await import(`../lib/index.js?v=${Date.now()}`);
  plug.apply(ctx);

  const server = createServer((req, res) => webServer.dispatch(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    return await fn(base, { webServer, ctx, plug });
  } finally {
    await new Promise((r) => server.close(r));
    for (const d of disposers) {
      try {
        d();
      } catch {
        /* 忽略 */
      }
    }
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  }
}

/** 读一条 SSE 流，返回 { events: [[name, data]], text } */
async function readSSE(url) {
  const res = await fetch(url);
  const raw = await res.text();
  const events = [];
  for (const block of raw.split("\n\n")) {
    const em = /^event: (\w+)/m.exec(block);
    const dm = /^data: (.*)$/m.exec(block);
    if (!em || !dm) continue;
    let data = null;
    try {
      data = JSON.parse(dm[1]);
    } catch {
      data = dm[1];
    }
    events.push([em[1], data]);
  }
  return { status: res.status, events };
}

/* ================================================================== *
 * 跑起来
 * ================================================================== */

const home = makeFakeHome();

// 素材分发那一段需要 assets/ 里真的有一个 writing 素材。
// 已经有用户投放的（webp/gif/…）就直接用；没有才临时造一个最小合法 GIF，跑完删掉 ——
// 这样自定义素材路径**永远**被覆盖到，又不会在仓库里留垃圾。
const assetsDir = fileURLToPath(new URL("../assets/", import.meta.url));
const writingGif = join(assetsDir, "writing.gif");
const ASSET_EXT_ORDER = ["png", "webp", "gif", "apng", "jpg", "jpeg", "svg"];
const writingAlreadyThere = ASSET_EXT_ORDER.some((e) => existsSync(join(assetsDir, `writing.${e}`)));
const avatarAlreadyThere = ASSET_EXT_ORDER.some((e) => existsSync(join(assetsDir, `avatar.${e}`)));
let createdGif = false;
if (!writingAlreadyThere) {
  mkdirSync(assetsDir, { recursive: true });
  // 1x1 透明 GIF，43 字节，合法可解析
  writeFileSync(writingGif, Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
  createdGif = true;
}
const hadWritingGif = true;

try {
  await withServer({ home, llm: makeLlm(), defaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) } }, async (base) => {
    /* ---------- 基础路由 ---------- */
    group("基础路由");

    const health = await fetch(`${base}/fatfish-diary/health`);
    eq("health 200", health.status, 200);
    const hj = await health.json();
    eq("health ok", hj.ok, true);
    eq("health 报出插件名", hj.plugin, "fatfish-diary");
    ok("health 报出 DSH_HOME", hj.home === home, hj.home);

    eq("未知路由 404", (await fetch(`${base}/fatfish-diary/nope`)).status, 404);

    /* ---------- 素材分发 ---------- */
    group("素材分发");

    // /avatar 永远有东西可发：投放了就发自定义图，没投放就发内置 SVG
    const av = await fetch(`${base}/fatfish-diary/avatar?size=64`);
    eq("avatar 200", av.status, 200);
    const avType = av.headers.get("content-type") || "";
    if (avatarAlreadyThere) {
      ok("avatar 发了自定义图", /^image\//.test(avType) && !avType.includes("svg"), avType);
      ok("自定义头像有字节", (await av.arrayBuffer()).byteLength > 200);
    } else {
      eq("avatar 默认是 SVG", avType, "image/svg+xml; charset=utf-8");
      const avBody = await av.text();
      ok("avatar 是内置自画像", avBody.includes("吃白饭的大肥鱼") && avBody.includes('width="64"'));
    }

    // 别名永远发内置 SVG，忽略 assets/
    const avs = await fetch(`${base}/fatfish-diary/avatar.svg?size=32`);
    eq("avatar.svg 也 200", avs.status, 200);
    eq("avatar.svg 一定是 SVG", avs.headers.get("content-type"), "image/svg+xml; charset=utf-8");
    ok("avatar.svg 忽略 assets/", (await avs.text()).includes('width="32"'));

    const icon = await fetch(`${base}/fatfish-diary/icon.svg?size=20`);
    eq("icon 200", icon.status, 200);
    ok("icon 是 currentColor 单色", (await icon.text()).includes('fill="currentColor"'));

    // 未投放的槽位
    eq("未投放的槽位 404", (await fetch(`${base}/fatfish-diary/asset?name=nothere`)).status, 404);

    // 路径穿越必须被挡住
    for (const evil of ["../lib/index", "..%2F..%2Fpackage", "a/b", "a\\b", "", "../../etc/passwd"]) {
      const r = await fetch(`${base}/fatfish-diary/asset?name=${encodeURIComponent(evil)}`);
      eq(`穿越被挡: ${JSON.stringify(evil)}`, r.status, 404);
    }

    // 投放了 writing.* 之后应该能发出来
    if (hadWritingGif) {
      const w = await fetch(`${base}/fatfish-diary/asset?name=writing`);
      eq("writing 素材 200", w.status, 200);
      const ct = w.headers.get("content-type") || "";
      ok("writing 是图片类型", /^image\//.test(ct), ct);
      ok("writing 有字节", (await w.arrayBuffer()).byteLength > 20);
    } else {
      console.log("  (assets/writing.* 不存在，跳过自定义素材用例)");
    }

    // ---- 协商缓存：动图两三百 KB，绝不能每次开面板都重下 ----
    const a1 = await fetch(`${base}/fatfish-diary/avatar`);
    const etag = a1.headers.get("etag");
    const cc = a1.headers.get("cache-control") || "";
    await a1.arrayBuffer();
    ok("素材带弱 ETag", typeof etag === "string" && etag.startsWith('W/"'), String(etag));
    ok("素材用 no-cache（可缓存但每次验证）", cc.includes("no-cache"), cc);
    ok("素材不再用 no-store（那会导致每次重下）", !cc.includes("no-store"), cc);

    const a2 = await fetch(`${base}/fatfish-diary/avatar`, { headers: { "If-None-Match": etag } });
    eq("ETag 命中回 304", a2.status, 304);
    await a2.arrayBuffer();

    const a3 = await fetch(`${base}/fatfish-diary/avatar`, { headers: { "If-None-Match": 'W/"stale"' } });
    eq("ETag 不匹配回 200", a3.status, 200);
    await a3.arrayBuffer();

    if (hadWritingGif) {
      const w1 = await fetch(`${base}/fatfish-diary/asset?name=writing`);
      const wEtag = w1.headers.get("etag");
      await w1.arrayBuffer();
      const w2 = await fetch(`${base}/fatfish-diary/asset?name=writing`, { headers: { "If-None-Match": wEtag } });
      eq("writing 也能 304", w2.status, 304);
      await w2.arrayBuffer();
    }

    /* ---------- 状态 ---------- */
    group("状态接口");

    const st = (await (await fetch(`${base}/fatfish-diary/state`)).json());
    eq("state ok", st.ok, true);
    ok("state 报出 assets 清单", st.assets && typeof st.assets === "object");
    eq("assets.writing 与文件是否投放一致", st.assets.writing, hadWritingGif);
    eq("assets.avatar 与文件是否投放一致", st.assets.avatar, avatarAlreadyThere);
    ok("assets.names 是数组", Array.isArray(st.assets.names));
    ok(
      "assets.names 只列真实槽位（README 之类不算）",
      st.assets.names.every((n) => !n.includes(".")),
      JSON.stringify(st.assets.names),
    );
    eq("初始没有日记", st.hasEntry, false);
    eq("初始篇数 0", st.entryCount, 0);
    ok("state 报出日记目录", typeof st.root === "string" && st.root.includes("fatfish-diary"));
    ok("state 报出留档目录", typeof st.historyDir === "string" && st.historyDir.endsWith("history"));
    ok("state 带今日统计", st.stats && st.stats.userTurns >= 1, JSON.stringify(st.stats && st.stats.userTurns));
    // ⑧⑨ 固定天数 + 打卡
    ok("state 带 firstDay", typeof st.firstDay === "string", String(st.firstDay));
    ok("state 带 dayNumber", Number.isFinite(st.dayNumber), String(st.dayNumber));
    ok("state 带 streak", st.streak && typeof st.streak.current === "number");
    eq("streak.total 等于篇数", st.streak.total, st.entryCount);
    ok("state 带 dates 数组", Array.isArray(st.dates));
    eq("state 带 backfillDays", st.backfillDays, 60);
    ok("state 带 rollups 数组", Array.isArray(st.rollups));

    const pv = await (await fetch(`${base}/fatfish-diary/preview`)).json();
    eq("preview ok", pv.ok, true);
    eq("preview 非空", pv.empty, false);
    ok("preview 抓到工具调用", pv.summary.toolCalls >= 1);

    eq("不存在的日记 404", (await fetch(`${base}/fatfish-diary/entry?date=1999-01-01`)).status, 404);

    /* ---------- CSRF ---------- */
    group("CSRF 防护");

    const cross = await fetch(`${base}/fatfish-diary/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
      body: "{}",
    });
    eq("跨站 POST 被拒", cross.status, 403);

    const evilOrigin = await fetch(`${base}/fatfish-diary/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: "{}",
    });
    eq("外站 Origin 被拒", evilOrigin.status, 403);

    eq("只读接口不受 CSRF 影响", (await fetch(`${base}/fatfish-diary/state`)).status, 200);

    /* ---------- 生成（SSE） ---------- */
    group("写日记（SSE 流式，用假模型）");

    const sse = await readSSE(`${base}/fatfish-diary/write?date=2026-10-04`);
    eq("SSE 200", sse.status, 200);
    const names = sse.events.map((e) => e[0]);
    ok("有 status 事件", names.includes("status"));
    ok("有 delta 事件", names.filter((n) => n === "delta").length > 0);
    ok("有 done 事件", names.includes("done"));
    ok("没有 error 事件", !names.includes("error"), JSON.stringify(sse.events.filter((e) => e[0] === "error")));

    const done = (sse.events.find((e) => e[0] === "done") || [])[1];
    ok("done 带正文", !!done && done.markdown.includes("今天很困"));
    eq("done 标记为新生成", done.generated, true);
    eq("done 复用标记为假", done.reused, false);
    eq("记录了模型", done.meta.model, "p/m");
    eq("没有走兜底", done.meta.fellBack, false);
    eq("usage 被记下", done.meta.usage.totalTokens, 33);

    // 流式拼出来的字应该和最终正文一致（证明 delta 没丢）
    const streamed = sse.events.filter((e) => e[0] === "delta").map((e) => e[1].text).join("");
    eq("delta 拼回等于正文", streamed.trim(), done.markdown.trim());

    // 落盘了
    const mdPath = join(home, "fatfish-diary", "diary", "2026-10-04.md");
    ok("日记落盘", existsSync(mdPath));
    ok("落盘内容含正文", readFileSync(mdPath, "utf8").includes("今天很困"));
    ok("元信息落盘", existsSync(join(home, "fatfish-diary", "diary", "2026-10-04.json")));

    // 回读
    const entry = await (await fetch(`${base}/fatfish-diary/entry?date=2026-10-04`)).json();
    eq("entry 回读 ok", entry.ok, true);
    ok("entry 正文完整", entry.markdown.includes("今天很困"));
    ok("entry 带生成来源注释", entry.markdown.startsWith("<!--"));

    // 再写一次：默认复用，不重新生成
    const again = await readSSE(`${base}/fatfish-diary/write?date=2026-10-04`);
    const againDone = (again.events.find((e) => e[0] === "done") || [])[1];
    eq("重复写会复用", againDone.reused, true);
    eq("重复写没重新生成", againDone.generated, false);
    eq("复用时不发 delta", again.events.filter((e) => e[0] === "delta").length, 0);

    // force=1 覆盖：应该留下旧稿
    const forced = await readSSE(`${base}/fatfish-diary/write?date=2026-10-04&force=1`);
    const forcedDone = (forced.events.find((e) => e[0] === "done") || [])[1];
    eq("force 会重新生成", forcedDone.generated, true);
    const histDir = join(home, "fatfish-diary", "history");
    ok("覆盖留档目录已创建", existsSync(histDir));
    ok(
      "覆盖留下了旧稿",
      existsSync(histDir) && readdirSync(histDir).some((f) => f.startsWith("2026-10-04") && f.endsWith(".md")),
    );

    // 同一天并发写：第二次应该被 409 挡下（或者至少不炸）
    const [c1, c2] = await Promise.all([
      fetch(`${base}/fatfish-diary/write?date=2026-10-05&force=1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
      fetch(`${base}/fatfish-diary/write?date=2026-10-05&force=1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
    ]);
    const codes = [c1.status, c2.status].sort();
    ok("并发写同一天不会双双成功", codes[0] === 200 && (codes[1] === 409 || codes[1] === 200), JSON.stringify(codes));
    // 至少有一篇落盘，且没崩
    ok("并发后日期 10-05 有日记", existsSync(join(home, "fatfish-diary", "diary", "2026-10-05.md")));

    /* ---------- 删除 ---------- */
    group("删除");

    const del = await fetch(`${base}/fatfish-diary/entry?date=2026-10-05`, { method: "DELETE" });
    eq("删除 200", del.status, 200);
    eq("删除返回 removed", (await del.json()).removed, true);
    eq("删除后 404", (await fetch(`${base}/fatfish-diary/entry?date=2026-10-05`)).status, 404);

    const crossDel = await fetch(`${base}/fatfish-diary/entry?date=2026-10-04`, {
      method: "DELETE",
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    eq("跨站删除被拒", crossDel.status, 403);

    /* ---------- ② 实录接口 ---------- */
    group("② 实录接口 /transcript");

    const ts = await (await fetch(`${base}/fatfish-diary/transcript?date=2026-10-04`)).json();
    eq("transcript ok", ts.ok, true);
    eq("transcript 日期", ts.date, "2026-10-04");
    ok("带回实录正文", typeof ts.transcript === "string" && ts.transcript.length > 50, `len=${ts.transcript.length}`);
    ok("实录含采集到的会话段", ts.transcript.includes("【项目：fake】"), ts.transcript.slice(0, 160));
    ok("带分段概览", Array.isArray(ts.segments) && ts.segments.length >= 1);
    ok("分段有 project 名", ts.segments[0].project === "fake", JSON.stringify(ts.segments[0]));
    ok("分段有计数", typeof ts.segments[0].userTexts === "number" && typeof ts.segments[0].toolCalls === "number");
    ok("带 summary", !!ts.summary);
    ok("recall 字段是字符串", typeof ts.recall === "string");
    eq("recallDays", ts.recallDays, 3);

    /* ---------- ① 连续性：写日记时要带上前几天的记忆 ---------- */
    group("① 连续性（记忆进提示词）");

    {
      // 先给"前两天"各写一篇，再写今天，看提示词里有没有把记忆带进去
      for (const d of ["2026-10-02", "2026-10-03"]) {
        await fetch(`${base}/fatfish-diary/write?date=${d}&force=1`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
      }
      let seenUser = "";
      let innerStatus = 0;
      let innerBody = "";
      // 注意：这两个方法都要给。callLlm 开头就会检查 `typeof llm.stream === "function"`，
      // 只实现 prepareCall 会被判成"llm 服务不可用"直接走兜底 —— 状态码还是 200，很难发现。
      const captureLlm = (() => {
        const run = (opts) => {
          seenUser = opts.messages?.[0]?.content?.[0]?.text || "";
          return (async function* () {
            yield { type: "text-delta", index: 0, text: "# 第 5 天 · 2026-10-04\n\n今天很困。" };
            yield { type: "finish", reason: { kind: "stop" } };
          })();
        };
        return {
          stream: run,
          async prepareCall(config) {
            return { config, stream: run };
          },
        };
      })();

      await withServer(
        {
          home,
          llm: captureLlm,
          defaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
        },
        async (base2) => {
          const r = await fetch(`${base2}/fatfish-diary/write?date=2026-10-04&force=1`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          innerStatus = r.status;
          innerBody = (await r.text()).slice(0, 200);
        },
      );
      ok("内部那次生成成功", innerStatus === 200, `status=${innerStatus} body=${innerBody}`);
      ok(
        "提示词里带了「你还记得」段",
        /你还记得|记得的前几天/.test(seenUser),
        `len=${seenUser.length} tail=${seenUser.slice(-300)}`,
      );
      ok("记忆里含前一天的日期", seenUser.includes("2026-10-03"));
      ok("今天实录仍在提示词里", seenUser.includes("今日实录"));
      ok("记忆段排在实录之后", seenUser.indexOf("今日实录结束") < seenUser.indexOf("记得"), "顺序不对");
    }

    /* ---------- ⑤ 周记 / 月记 ---------- */
    group("⑤ 周记 / 月记 /rollup");

    eq(
      "peek 不存在 → 404",
      (await fetch(`${base}/fatfish-diary/rollup?range=week&anchor=2026-10-04&peek=1`)).status,
      404,
    );

    const ru = await readSSE(`${base}/fatfish-diary/rollup?range=week&anchor=2026-10-04`);
    const ruDone = (ru.events.find((e) => e[0] === "done") || [])[1];
    ok("汇总有 done", !!ruDone, JSON.stringify(ru.events.map((e) => e[0])));
    ok("汇总正文非空", ruDone && ruDone.markdown.length > 20);
    eq("汇总区间是周一到周日", `${ruDone.from}~${ruDone.to}`, "2026-09-28~2026-10-04");
    eq("汇总 key", ruDone.key, "2026-W40");
    ok("汇总落了盘", existsSync(join(home, "fatfish-diary", "rollups", "2026-W40.md")));

    const pk = await (await fetch(`${base}/fatfish-diary/rollup?range=week&anchor=2026-10-04&peek=1`)).json();
    eq("peek 读回 ok", pk.ok, true);
    ok("peek 正文一致", pk.markdown.includes("今天很困"));
    ok("peek 带来源注释", pk.markdown.startsWith("<!--"));

    const ru2 = await readSSE(`${base}/fatfish-diary/rollup?range=week&anchor=2026-10-04`);
    const ru2Done = (ru2.events.find((e) => e[0] === "done") || [])[1];
    eq("重复写会复用", ru2Done.reused, true);
    eq("复用时不发 delta", ru2.events.filter((e) => e[0] === "delta").length, 0);

    // 月记是另一个 key，互不干扰
    const rm = await readSSE(`${base}/fatfish-diary/rollup?range=month&anchor=2026-10-04`);
    const rmDone = (rm.events.find((e) => e[0] === "done") || [])[1];
    eq("月记 key", rmDone.key, "2026-10");
    eq("月记区间", `${rmDone.from}~${rmDone.to}`, "2026-10-01~2026-10-31");

    const stAfter = (await (await fetch(`${base}/fatfish-diary/state`)).json());
    eq("state 里能看到两篇汇总", stAfter.rollups.length, 2);

    // 跨站写汇总也要被挡
    eq(
      "跨站写汇总被拒",
      (
        await fetch(`${base}/fatfish-diary/rollup?range=week`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
          body: "{}",
        })
      ).status,
      403,
    );

    /* ---------- ③ 补写往日 ---------- */
    group("③ 补写往日（任意日期都写得出来）");

    // 用一个早就过去、原本没日志的日期：不该崩，且要落盘
    const oldDate = "2026-09-15";
    const oldDay = await fetch(`${base}/fatfish-diary/write?date=${oldDate}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    eq("补写往日 200", oldDay.status, 200);
    const oldJson = await oldDay.json();
    eq("补写的就是那一天", oldJson.date, oldDate);
    ok("补写落盘了", existsSync(join(home, "fatfish-diary", "diary", `${oldDate}.md`)));
    ok("补写的日记有正文", oldJson.markdown.length > 10);
    // 那天的实录是空的，应该走"主人没来"的分支而不是报错
    const oldTs = await (await fetch(`${base}/fatfish-diary/transcript?date=${oldDate}`)).json();
    eq("空日实录标记 empty", oldTs.empty, true);
    ok("空日实录有兜底文案", oldTs.transcript.includes("空"));
  });

  /* ---------- 模型挂掉时要走兜底，而不是把这一天弄丢 ---------- */
  group("模型不可用 → 兜底模板");

  const home2 = makeFakeHome();
  try {
    await withServer({ home: home2, llm: makeLlm({ explode: true }), defaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) } }, async (base) => {
      const sse = await readSSE(`${base}/fatfish-diary/write?date=2026-10-04`);
      const names = sse.events.map((e) => e[0]);
      ok("没有 error 事件（不该整条失败）", !names.includes("error"), JSON.stringify(sse.events.filter((e) => e[0] === "error")));
      const done = (sse.events.find((e) => e[0] === "done") || [])[1];
      ok("仍然写出了日记", !!done && done.markdown.length > 40);
      eq("标记为走了兜底", done.meta.fellBack, true);
      ok("记下兜底原因", typeof done.meta.fallbackReason === "string" && done.meta.fallbackReason.length > 0);
      eq("没有模型名", done.meta.model, null);
      ok("兜底正文含标题行", /^#\s+第\s+\d+\s+天/m.test(done.markdown), done.markdown.slice(0, 60));
      ok("兜底引用了真实统计", done.markdown.includes("1 句") || done.markdown.includes("句话"), done.markdown.slice(0, 160));
      ok("兜底也落盘了", existsSync(join(home2, "fatfish-diary", "diary", "2026-10-04.md")));
    });
  } finally {
    rmSync(home2, { recursive: true, force: true });
  }

  /* ---------- prepareCall 挂了、裸 stream 可用：应降级而不是报错 ---------- */
  group("prepareCall 不可用 → 降级到裸 stream");

  const home4 = makeFakeHome();
  try {
    await withServer({ home: home4, llm: makeLlm({ prepareBroken: true }), defaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) } }, async (base) => {
      const sse = await readSSE(`${base}/fatfish-diary/write?date=2026-10-04`);
      const done = (sse.events.find((e) => e[0] === "done") || [])[1];
      ok("降级后仍然出正文", !!done && done.markdown.includes("今天很困"));
      eq("不该算兜底", done.meta.fellBack, false);
      eq("仍然记下模型", done.meta.model, "p/m");
    });
  } finally {
    rmSync(home4, { recursive: true, force: true });
  }

  /* ---------- 完全没有 llm 服务 ---------- */
  group("连 llm 服务都没有");

  const home3 = makeFakeHome();
  try {
    await withServer({ home: home3, llm: undefined, defaultModel: undefined }, async (base) => {
      const sse = await readSSE(`${base}/fatfish-diary/write?date=2026-10-04`);
      const done = (sse.events.find((e) => e[0] === "done") || [])[1];
      ok("没有 llm 也能产出兜底日记", !!done && done.markdown.length > 40);
      eq("标记兜底", done.meta.fellBack, true);
    });
  } finally {
    rmSync(home3, { recursive: true, force: true });
  }
} finally {
  rmSync(home, { recursive: true, force: true });
  if (createdGif) {
    try {
      rmSync(writingGif, { force: true });
    } catch {
      /* 忽略 */
    }
  }
}

console.log(`\n${"─".repeat(52)}`);
if (fail === 0) console.log(`全部通过：${pass} 项断言`);
else {
  console.log(`通过 ${pass} 项，失败 ${fail} 项：`);
  for (const f of failures) console.log("  ✗ " + f);
}
console.log("─".repeat(52));
process.exit(fail === 0 ? 0 : 1);
