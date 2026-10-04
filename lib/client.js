/**
 * fatfish-diary — Browser 半边（手写 __ModuleLoader__ bundle，无需构建工具）。
 *
 * 只做展示：侧栏一个「大肥鱼日记」按钮 + 一个浮层面板。
 * 点按钮 = 一键写今天的日记（走 SSE 实时出字）；今天已经写过则直接翻开看。
 *
 * Host 侧契约： /fatfish-diary/{state,entry,preview,write,avatar.svg,icon.svg}
 */
window.__ModuleLoader__.load({
	id: "fatfish-diary",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;
		const { useState, useEffect, useRef, useCallback } = React;

		const BASE = "/fatfish-diary";
		/**
		 * 自画像。/avatar 会优先发用户在插件目录放的 assets/avatar.*，没有就发内置 SVG。
		 * 旧版 host 没有这条路由，所以带上 onError 退回 /avatar.svg —— 否则就是一张坏图。
		 */
		const AVATAR = BASE + "/avatar?size=104";
		const AVATAR_FALLBACK = BASE + "/avatar.svg?size=104";

		function avatarImg(extraProps) {
			const props = Object.assign({}, extraProps || {});
			props.src = props.src || AVATAR;
			props.alt = props.alt || "吃白饭的大肥鱼";
			props.className = props.className || "ffd-ava";
			props.onError = (ev) => {
				const img = (ev && ev.currentTarget) || (ev && ev.target);
				if (!img || img.dataset.ffdFb) return;
				img.dataset.ffdFb = "1";
				img.src = AVATAR_FALLBACK;
			};
			return h("img", props);
		}

		// 侧栏图标必须内联成 SVG，不能用 <img src="...svg">：
		// <img> 里的 SVG 是独立文档，拿不到页面的 currentColor，
		// stroke 会退回黑色 —— 深色侧栏上就几乎看不见了（实测踩过）。
		const ICON_BODY =
			"M12.8 5.4C17.8 5.4 21.6 8.6 21.6 12.4C21.6 16.2 17.8 19.4 12.8 19.4" +
			"C9.6 19.4 6.7 18.1 5 16.1L1.6 17.8L3.4 12.4L1.6 7L5.1 8.7" +
			"C6.8 6.7 9.6 5.4 12.8 5.4Z";
		const ICON_EYE =
			"M16.5 10.1C17.3 10.1 17.9 10.7 17.9 11.5C17.9 12.3 17.3 12.9 16.5 12.9" +
			"C15.7 12.9 15.1 12.3 15.1 11.5C15.1 10.7 15.7 10.1 16.5 10.1Z";
		const ICON_DROPS =
			"M11.2 1.1C12 1.1 12.7 1.8 12.7 2.6C12.7 3.4 12 4.1 11.2 4.1C10.4 4.1 9.7 3.4 9.7 2.6C9.7 1.8 10.4 1.1 11.2 1.1Z" +
			"M7.6 3.3C8.2 3.3 8.7 3.8 8.7 4.4C8.7 5 8.2 5.5 7.6 5.5C7 5.5 6.5 5 6.5 4.4C6.5 3.8 7 3.3 7.6 3.3Z";

		function Icon(props) {
			const size = (props && props.size) || 18;
			return h(
				"svg",
				{
					xmlns: "http://www.w3.org/2000/svg",
					viewBox: "0 0 24 24",
					width: size,
					height: size,
					fill: "currentColor",
					"aria-hidden": "true",
					focusable: "false",
					style: { display: "block" },
				},
				// evenodd：眼睛在身体内部 → 镂空成洞；水滴在身体之外 → 保持实心。
				// 小尺寸下镂空比描边眼圈更清晰，任何底色上都读得出来。
				h("path", {
					d: `${ICON_BODY} ${ICON_EYE} ${ICON_DROPS}`,
					fillRule: "evenodd",
					clipRule: "evenodd",
				}),
			);
		}

		/* ============================================================ *
		 * 状态容器（按钮和面板共享）
		 * ============================================================ */

		const store = {
			version: 0,
			listeners: new Set(),
			open: false,
			tab: "today",
			date: null,
			today: null,
			markdown: "",
			meta: null,
			stats: null,
			phase: null,
			streaming: false,
			error: null,
			notice: null,
			entries: [],
			entryCount: 0,
			loadingEntry: false,
			loadedOnce: false,
			/** 由 /state 下发：哪些素材槽位里用户放了真东西 */
			assets: { avatar: false, writing: false, names: [] },
			root: null,
			/** 第 N 天与连续打卡 */
			firstDay: null,
			dayNumber: null,
			streak: null,
			/** 已有日记的日期，用来在日期选择器里打勾 */
			dates: [],
			backfillDays: 60,
			/** 周记 / 月记 */
			rollups: [],
			rollupMarkdown: "",
			rollupKey: null,
			rollupStreaming: false,
			/** 「实录」标签页 */
			transcript: "",
			transcriptSegments: [],
			transcriptRecall: "",
			transcriptLoading: false,
			/**
			 * 错误必须**分页存放**。
			 * 以前三个标签页共用一个 error：实录页请求失败（比如旧 host 没这个接口），
			 * 切回日记页就把那条错误显示出来了 —— 明明日记好好的。
			 */
			transcriptError: null,
			rollupError: null,

			emit() {
				this.version++;
				for (const l of this.listeners) {
					try {
						l();
					} catch (e) {
						/* 一个组件出错不该拖垮其他 */
					}
				}
			},
			subscribe(l) {
				this.listeners.add(l);
				return () => this.listeners.delete(l);
			},
			set(patch) {
				Object.assign(this, patch);
				this.emit();
			},
		};

		/** 订阅 store 的极简 hook（不依赖 useSyncExternalStore，兼容性最好） */
		function useStore() {
			const [, force] = useState(0);
			useEffect(() => store.subscribe(() => force((n) => n + 1)), []);
			return store;
		}

		/* ============================================================ *
		 * Host 通信
		 * ============================================================ */

		async function getJson(path) {
			const r = await fetch(path, { headers: { Accept: "application/json" } });
			const body = await r.json().catch(() => ({}));
			if (!r.ok || body.ok === false) {
				// 把状态码带在 error 上：调用方要区分"接口不存在"（旧 host，重启就好）
				// 和"这次真的失败了"，给的提示完全不同。
				const err = new Error(body.error || `HTTP ${r.status}`);
				err.status = r.status;
				throw err;
			}
			return body;
		}

		/** 旧 host 没有这个接口时的友好提示 —— 用户看到"404"只会一头雾水 */
		function explainError(err, what) {
			const status = err && err.status;
			const msg = String((err && err.message) || err || "");
			if (status === 404) {
				return `${what}的接口在这台 host 上还没有（404）。重启一次 DSH 就会生效。`;
			}
			if (status === 403) return "请求被挡下来了（403）。";
			if (/Failed to fetch|NetworkError|load failed/i.test(msg)) return "连不上宿主，可能是 DSH 正在重启。";
			return msg || `${what}失败了`;
		}

		async function refreshState(date) {
			const q = date ? `?date=${encodeURIComponent(date)}` : "";
			const s = await getJson(`${BASE}/state${q}`);
			store.set({
				today: s.today,
				date: s.date,
				entries: s.entries || [],
				entryCount: s.entryCount || 0,
				root: s.root || null,
				stats: s.stats || store.stats,
				assets: s.assets || store.assets,
				firstDay: s.firstDay ?? store.firstDay,
				dayNumber: s.dayNumber ?? store.dayNumber,
				streak: s.streak || store.streak,
				dates: Array.isArray(s.dates) ? s.dates : store.dates,
				backfillDays: s.backfillDays || store.backfillDays,
				rollups: Array.isArray(s.rollups) ? s.rollups : store.rollups,
			});
			return s;
		}

		async function loadEntry(date) {
			store.set({ loadingEntry: true, error: null });
			try {
				const e = await getJson(`${BASE}/entry?date=${encodeURIComponent(date)}`);
				store.set({
					date,
					markdown: e.markdown || "",
					meta: e.meta || null,
					loadingEntry: false,
					notice: null,
				});
				return true;
			} catch (err) {
				store.set({
					date,
					markdown: "",
					meta: null,
					loadingEntry: false,
					notice: null,
					error: null,
				});
				return false;
			}
		}

		/** 一键生成：SSE 实时把字吐出来 */
		function startWriting(date, force) {
			if (store.streaming) return;
			const q = new URLSearchParams();
			if (date) q.set("date", date);
			if (force) q.set("force", "1");

			store.set({
				streaming: true,
				phase: "start",
				error: null,
				notice: null,
				markdown: force ? "" : store.markdown,
				meta: null,
				tab: "today",
			});

			let es;
			try {
				es = new EventSource(`${BASE}/write?${q.toString()}`);
			} catch (err) {
				store.set({ streaming: false, error: String(err && err.message ? err.message : err) });
				return;
			}

			const finish = () => {
				try {
					es.close();
				} catch (e) {
					/* 已关闭 */
				}
				store.set({ streaming: false, phase: null });
			};

			es.addEventListener("status", (ev) => {
				try {
					const d = JSON.parse(ev.data);
					store.set({ phase: d.phase });
				} catch (e) {
					/* 忽略坏帧 */
				}
			});

			es.addEventListener("delta", (ev) => {
				try {
					const d = JSON.parse(ev.data);
					store.set({ markdown: store.markdown + (d.text || ""), phase: "writing" });
				} catch (e) {
					/* 忽略坏帧 */
				}
			});

			es.addEventListener("done", (ev) => {
				try {
					const d = JSON.parse(ev.data);
					store.set({
						markdown: d.markdown || store.markdown,
						meta: d.meta || null,
						stats: d.stats || store.stats,
						date: d.date,
						streaming: false,
						phase: null,
						error: null,
						notice: d.reused ? "今天已经写过啦，这是之前那篇" : null,
					});
					refreshState().catch(() => {});
				} catch (e) {
					/* 忽略坏帧 */
				}
				finish();
			});

			es.addEventListener("error", (ev) => {
				let msg = "写日记的时候出岔子了";
				try {
					if (ev && ev.data) msg = JSON.parse(ev.data).message || msg;
				} catch (e) {
					/* 用默认文案 */
				}
				store.set({ error: msg });
				finish();
			});

			// 连接层的错误（没有 data）——SSE 断了
			es.onerror = () => {
				if (store.streaming) {
					store.set({ streaming: false, phase: null, error: store.error || "连接断开了，再点一次试试" });
				}
				try {
					es.close();
				} catch (e) {
					/* 已关闭 */
				}
			};
		}

		/** 侧栏按钮的一次点击 */
		async function onPrimaryClick() {
			store.set({ open: true, error: null, notice: null });
			if (store.streaming) return;
			try {
				const s = await refreshState();
				if (s.hasEntry && !store.markdown) {
					await loadEntry(s.date);
				} else if (!s.hasEntry) {
					store.set({ markdown: "", meta: null, date: s.date });
					startWriting(s.date, false);
				}
			} catch (err) {
				store.set({ error: String(err && err.message ? err.message : err) });
			}
		}

		async function openHistory(date) {
			store.set({ tab: "today" });
			await loadEntry(date);
		}

		/** 拉「她今天到底读到了什么」——用来自证，也用来排查"某段怎么没写进去" */
		async function loadTranscript(date) {
			const d = date || store.date || store.today;
			store.set({ transcriptLoading: true, transcriptError: null });
			try {
				const t = await getJson(`${BASE}/transcript?date=${encodeURIComponent(d)}`);
				store.set({
					transcript: t.transcript || "",
					transcriptSegments: t.segments || [],
					transcriptRecall: t.recall || "",
					transcriptLoading: false,
					transcriptError: null,
				});
			} catch (err) {
				store.set({ transcriptLoading: false, transcriptError: explainError(err, "看实录") });
			}
		}

		/** 周记 / 月记：和写日记一样走 SSE，实时出字 */
		function startRollup(range) {
			if (store.rollupStreaming) return;
			const anchor = store.date || store.today;
			store.set({
				tab: "history",
				rollupStreaming: true,
				rollupMarkdown: "",
				rollupKey: `${range}:${anchor}`,
				rollupError: null,
				notice: null,
			});

			let es;
			try {
				es = new EventSource(`${BASE}/rollup?range=${range}&anchor=${encodeURIComponent(anchor)}`);
			} catch (err) {
				store.set({ rollupStreaming: false, rollupError: explainError(err, "写汇总") });
				return;
			}

			const finish = () => {
				try {
					es.close();
				} catch (e) {
					/* 已关闭 */
				}
				store.set({ rollupStreaming: false });
			};

			es.addEventListener("delta", (ev) => {
				try {
					store.set({ rollupMarkdown: store.rollupMarkdown + (JSON.parse(ev.data).text || "") });
				} catch (e) {
					/* 忽略坏帧 */
				}
			});
			es.addEventListener("done", (ev) => {
				try {
					const d = JSON.parse(ev.data);
					store.set({
						rollupMarkdown: d.markdown || store.rollupMarkdown,
						rollupKey: d.key || store.rollupKey,
						notice: d.reused ? "这篇已经写过了，这是之前那篇" : null,
					});
					refreshState().catch(() => {});
				} catch (e) {
					/* 忽略坏帧 */
				}
				finish();
			});
			es.addEventListener("error", (ev) => {
				let msg = "写汇总的时候出岔子了";
				try {
					if (ev && ev.data) msg = JSON.parse(ev.data).message || msg;
				} catch (e) {
					/* 用默认文案 */
				}
				store.set({ rollupError: msg });
				finish();
			});
			es.onerror = () => {
				// 连接层错误（没有 data）。旧 host 没有 /rollup 时会走到这里。
				if (store.rollupStreaming) {
					store.set({
						rollupStreaming: false,
						rollupError: store.rollupError || "写汇总的接口在这台 host 上还没有，重启一次 DSH 就会生效。",
					});
				}
				try {
					es.close();
				} catch (e) {
					/* 已关闭 */
				}
			};
		}

		/** 只读地看一眼某个区间已有的汇总，没有就返回 null */
		async function peekRollup(range) {
			const anchor = store.date || store.today;
			try {
				const r = await fetch(`${BASE}/rollup?range=${range}&anchor=${encodeURIComponent(anchor)}&peek=1`);
				if (!r.ok) return null;
				return await r.json();
			} catch {
				return null;
			}
		}

		/* ============================================================ *
		 * Markdown 渲染（先转义，再做最小子集替换——不引入任何依赖）
		 * ============================================================ */

		const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
		function escapeHtml(s) {
			return String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
		}

		/**
		 * 去掉 HTML 注释。
		 * 落盘时文件头会写一行 `<!-- 大肥鱼日记 · 日期 · 由 DSH 插件 … 生成 -->` 当出处说明，
		 * 那是给记事本里直接打开看的；渲染时必须按 HTML 语义吃掉，
		 * 否则会被当成一段普通文字显示在正文最上面（转义过，所以是可见的裸文本）。
		 * 必须在 escapeHtml **之前**做，转义之后 `<` 就变成 `&lt;` 认不出来了。
		 */
		function stripHtmlComments(s) {
			return String(s ?? "").replace(/<!--[\s\S]*?-->/g, "");
		}
		function inlineMd(s) {
			return s
				.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
				.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
				.replace(/`([^`]+)`/g, "<code>$1</code>");
		}
		function renderMarkdown(md) {
			const lines = escapeHtml(stripHtmlComments(md)).split(/\r?\n/);
			const out = [];
			let listTag = null;
			let inQuote = false;

			const closeList = () => {
				if (listTag) {
					out.push(`</${listTag}>`);
					listTag = null;
				}
			};
			const closeQuote = () => {
				if (inQuote) {
					out.push("</blockquote>");
					inQuote = false;
				}
			};
			const closeAll = () => {
				closeList();
				closeQuote();
			};
			const openList = (tag) => {
				closeQuote();
				if (listTag !== tag) {
					closeList();
					out.push(`<${tag}>`);
					listTag = tag;
				}
			};

			for (const raw of lines) {
				const line = raw.replace(/\s+$/, "");
				if (!line.trim()) {
					closeAll();
					continue;
				}
				let m;
				if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
					closeAll();
					const lv = Math.min(6, m[1].length);
					out.push(`<h${lv}>${inlineMd(m[2])}</h${lv}>`);
					continue;
				}
				if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
					closeAll();
					out.push("<hr/>");
					continue;
				}
				if ((m = /^&gt;\s?(.*)$/.exec(line))) {
					closeList();
					if (!inQuote) {
						out.push("<blockquote>");
						inQuote = true;
					}
					out.push(`<p>${inlineMd(m[1])}</p>`);
					continue;
				}
				if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
					openList("ul");
					out.push(`<li>${inlineMd(m[1])}</li>`);
					continue;
				}
				if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
					openList("ol");
					out.push(`<li>${inlineMd(m[1])}</li>`);
					continue;
				}
				closeAll();
				out.push(`<p>${inlineMd(line)}</p>`);
			}
			closeAll();
			return out.join("\n");
		}

		/* ============================================================ *
		 * 样式
		 * ============================================================ */

		/**
		 * 配色原则：品牌蓝一律写死成 #3f8fe0，不用 --dsw-alias-brand-primary。
		 * 原因是实测踩过一次坑：把主题令牌当按钮底色、文字又写死 #fff，
		 * 某些主题下令牌是浅色 → 白底白字 → 按钮变成一个看不见字的空白方块。
		 * 文字色仍用令牌（浅深主题下都能读），底色/强调色用固定值保证对比度。
		 */
		const CSS = `
.ffd-btn{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border-radius:10px;
  background:transparent;border:1px solid transparent;color:var(--dsw-alias-label-secondary,#8a94a6);
  font:inherit;font-size:13px;cursor:pointer;text-align:left;transition:background .15s,color .15s,border-color .15s;
  box-sizing:border-box;min-width:0;position:relative;}
.ffd-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#e6e8ee);}
.ffd-btn .ffd-btn-ico{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:18px;height:18px;}
.ffd-btn .ffd-btn-ico svg{display:block;width:18px;height:18px;}
.ffd-btn .ffd-btn-txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
.ffd-btn[data-busy="1"]{color:#3f8fe0;}
.ffd-btn .ffd-dot{width:6px;height:6px;border-radius:50%;background:#3f8fe0;
  margin-left:auto;flex:0 0 auto;animation:ffd-pulse 1.1s ease-in-out infinite;}
/* 窄轨（56px rail）时只留图标，并且去掉文字占位 */
.ffd-btn[data-rail="1"]{justify-content:center;padding:8px 0;gap:0;}
.ffd-btn[data-rail="1"] .ffd-btn-txt{display:none;}
.ffd-btn[data-rail="1"] .ffd-dot{position:absolute;top:4px;right:8px;margin:0;}
@keyframes ffd-pulse{0%,100%{opacity:.25;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}

/* shell.overlay 整层是 click-through 的，占位者必须自己把 pointer-events 收回来，
   否则遮罩上的点击会全部穿透到下面的应用上（实测踩过）。 */
.ffd-mask{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
  background:rgba(8,12,20,.5);backdrop-filter:blur(3px);padding:24px;pointer-events:auto;box-sizing:border-box;}
.ffd-card{width:min(760px,100%);max-height:min(84vh,900px);display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-overlay,#1b1f28);color:var(--dsw-alias-label-primary,#e6e8ee);
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:16px;overflow:hidden;
  box-shadow:0 24px 70px rgba(0,0,0,.45);}
.ffd-head{display:flex;align-items:center;gap:12px;padding:14px 16px;
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));flex:0 0 auto;}
/* 头像一律透明底：用户可能丢进抠好的透明 PNG/GIF，垫一层底色就露馅了 */
.ffd-ava{width:46px;height:46px;flex:0 0 auto;object-fit:contain;
  background:transparent;animation:ffd-bob 4.5s ease-in-out infinite;}
@keyframes ffd-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
/* 用户提供的动图（通常是透明底 GIF）。不设底色、不裁切，让图自己动 */
.ffd-anim{width:auto;height:auto;max-width:150px;max-height:150px;object-fit:contain;
  background:transparent;display:block;}
.ffd-title{display:flex;flex-direction:column;gap:2px;min-width:0;}
.ffd-title b{font-size:15px;font-weight:600;}
.ffd-title span{font-size:12px;color:var(--dsw-alias-label-secondary,#8a94a6);}
.ffd-tabs{display:flex;gap:4px;margin-left:auto;align-items:center;}
.ffd-tab{padding:6px 12px;border-radius:8px;border:1px solid transparent;background:transparent;
  color:var(--dsw-alias-label-secondary,#8a94a6);font:inherit;font-size:13px;cursor:pointer;}
.ffd-tab:hover{color:var(--dsw-alias-label-primary,#e6e8ee);}
.ffd-tab[data-on="1"]{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary,#e6e8ee);}
.ffd-x{width:30px;height:30px;border-radius:8px;border:1px solid transparent;background:transparent;
  color:var(--dsw-alias-label-secondary,#8a94a6);font-size:17px;line-height:1;cursor:pointer;}
.ffd-x:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary,#e6e8ee);}

.ffd-body{padding:18px 22px 22px;overflow-y:auto;flex:1 1 auto;line-height:1.78;font-size:14.5px;}
.ffd-body h1{font-size:20px;margin:0 0 16px;font-weight:650;letter-spacing:.2px;
  padding-bottom:10px;border-bottom:2px solid rgba(63,143,224,.35);}
.ffd-body h2{font-size:16px;margin:20px 0 8px;}
.ffd-body h3{font-size:15px;margin:16px 0 6px;}
.ffd-body p{margin:0 0 13px;}
.ffd-body ul,.ffd-body ol{margin:0 0 13px;padding-left:22px;}
.ffd-body li{margin:0 0 5px;}
.ffd-body hr{border:0;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));margin:18px 0;}
.ffd-body blockquote{margin:0 0 13px;padding:2px 0 2px 12px;
  border-left:3px solid #3f8fe0;color:var(--dsw-alias-label-secondary,#8a94a6);}
.ffd-body code{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.18));padding:1px 5px;border-radius:5px;
  font-size:.92em;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}

.ffd-foot{display:flex;gap:8px;align-items:center;padding:12px 16px;flex:0 0 auto;
  border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));}
/* 次级按钮：透明底 + 描边，任何主题底色上都成立 */
.ffd-act{padding:7px 14px;border-radius:9px;font:inherit;font-size:13px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.38));background:transparent;
  color:var(--dsw-alias-label-primary,#e6e8ee);transition:border-color .15s,background .15s;}
.ffd-act:hover{border-color:#3f8fe0;color:#3f8fe0;}
.ffd-act[disabled]{opacity:.45;cursor:default;}
.ffd-act[disabled]:hover{border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.38));color:var(--dsw-alias-label-primary,#e6e8ee);}
/* 主按钮：固定品牌蓝底 + 白字，绝不依赖主题令牌当底色 */
.ffd-act.primary{background:#3f8fe0;border-color:#3f8fe0;color:#fff;font-weight:600;}
.ffd-act.primary:hover{background:#3379c2;border-color:#3379c2;color:#fff;}
.ffd-act.primary[disabled]{background:#9cbde4;border-color:#9cbde4;color:#fff;}
.ffd-act.primary[disabled]:hover{background:#9cbde4;border-color:#9cbde4;color:#fff;}
.ffd-hint{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary,#8a94a6);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52%;}

.ffd-empty{display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center;padding:26px 10px;color:var(--dsw-alias-label-secondary,#8a94a6);}
.ffd-empty img.ffd-ava{width:96px;height:96px;animation:ffd-bob 4.5s ease-in-out infinite;}
.ffd-empty b{color:var(--dsw-alias-label-primary,#e6e8ee);font-size:15px;}
.ffd-stats{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:2px;}
.ffd-chip{font-size:12px;padding:3px 10px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));}
.ffd-err{margin:0 0 14px;padding:9px 12px;border-radius:9px;font-size:13px;
  background:rgba(229,72,77,.14);border:1px solid var(--dsw-alias-state-error-primary,#e5484d);}
.ffd-note{margin:0 0 14px;padding:8px 12px;border-radius:9px;font-size:13px;
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,#8a94a6);}
.ffd-caret{display:inline-block;width:7px;height:15px;vertical-align:-2px;margin-left:2px;
  background:#3f8fe0;animation:ffd-blink 1s steps(2) infinite;}
@keyframes ffd-blink{0%,100%{opacity:1}50%{opacity:0}}
.ffd-list{display:flex;flex-direction:column;gap:6px;}
.ffd-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));background:transparent;}
.ffd-row:hover{border-color:#3f8fe0;}
.ffd-row .d{font-variant-numeric:tabular-nums;font-size:13px;font-weight:600;}
.ffd-row .t{font-size:12.5px;color:var(--dsw-alias-label-secondary,#8a94a6);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;}
.ffd-row .m{font-size:11.5px;color:var(--dsw-alias-label-secondary,#8a94a6);flex:0 0 auto;}

/* 日期选择：接口一直支持任意日期，以前界面只能写今天 */
.ffd-date{font:inherit;font-size:12.5px;padding:6px 8px;border-radius:9px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.38));background:transparent;
  color:var(--dsw-alias-label-primary,#e6e8ee);max-width:150px;}
.ffd-date:hover{border-color:#3f8fe0;}
.ffd-date option{background:var(--dsw-alias-bg-overlay,#1b1f28);color:var(--dsw-alias-label-primary,#e6e8ee);}

/* 「实录」页：一段一行，看到底喂了什么进去 */
.ffd-segs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;}
.ffd-pre{margin:0 0 16px;padding:12px 14px;border-radius:10px;overflow:auto;max-height:46vh;
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.65;
  white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary,#e6e8ee);}
.ffd-pre-dim{opacity:.75;max-height:26vh;}

/* 汇总 */
.ffd-rollbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px;
  padding-bottom:12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));}
.ffd-rollbar-lbl{font-size:12.5px;color:var(--dsw-alias-label-secondary,#8a94a6);}
.ffd-rollbar-list{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto;}
.ffd-chip-btn{cursor:pointer;border:1px solid transparent;color:inherit;font:inherit;}
.ffd-chip-btn:hover{border-color:#3f8fe0;}
`;

		/* ============================================================ *
		 * 组件
		 * ============================================================ */

		/**
		 * 「正在写日记」时中间那张图。
		 *
		 * 用户在 assets/ 里放了 writing.*（通常是透明底的 GIF）就用它；
		 * 没有就退回内置 SVG 自画像 —— 那个带一点点上下浮动，也算"活着"。
		 * 两种都不给背景色，抠好的透明图才能干净地贴上去。
		 */
		function writingArt() {
			if (store.assets && store.assets.writing) {
				return h("img", {
					className: "ffd-anim",
					src: `${BASE}/asset?name=writing`,
					alt: "",
					"aria-hidden": "true",
				});
			}
			return avatarImg();
		}

		/**
		 * 侧栏页脚按钮。owner 会传 wide：false 表示侧栏收成了 56px 窄轨，
		 * 这时候只能留图标，否则文字会被压出格子。
		 */
		function SidebarButton(props) {
			useStore();
			const wide = !props || props.wide !== false;
			const busy = store.streaming;
			const label = busy ? "大肥鱼正在写…" : "大肥鱼日记";
			return h(
				"button",
				{
					type: "button",
					className: "ffd-btn",
					"data-busy": busy ? "1" : "0",
					"data-rail": wide ? "0" : "1",
					title: "点一下，让大肥鱼把今天陪你干的事写成日记",
					"aria-label": label,
					onClick: onPrimaryClick,
				},
				h("span", { className: "ffd-btn-ico" }, h(Icon, { size: 18 })),
				h("span", { className: "ffd-btn-txt" }, label),
				busy ? h("span", { className: "ffd-dot" }) : null,
			);
		}

		function StatsChips({ stats }) {
			if (!stats) return null;
			const chips = [];
			if (stats.userTurns) chips.push(`主人说了 ${stats.userTurns} 句`);
			if (stats.toolCalls) chips.push(`干了 ${stats.toolCalls} 次活`);
			if (stats.tokenCount) {
				const n = stats.tokenCount;
				chips.push(
					n >= 1e8
						? `嚼了 ${(n / 1e8).toFixed(1)} 亿 token`
						: n >= 1e4
							? `嚼了 ${(n / 1e4).toFixed(1)} 万 token`
							: `嚼了 ${n} token`,
				);
			}
			if (stats.projects && stats.projects.length) chips.push(stats.projects.join(" / "));
			if (!chips.length) return null;
			return h(
				"div",
				{ className: "ffd-stats" },
				chips.map((c, i) => h("span", { className: "ffd-chip", key: i }, c)),
			);
		}

		const PHASE_TEXT = {
			start: "正在翻今天的记录…",
			collecting: "正在翻今天的记录…",
			thinking: "正在想怎么写…",
			writing: "正在写…",
			fallback: "模型没空，我自己凑合写…",
			saving: "正在收进抽屉…",
		};

		function TodayPane() {
			useStore();

			if (store.error) {
				return h(
					"div",
					{ className: "ffd-empty" },
					avatarImg(),
					h("b", null, "呜，出岔子了"),
					h("div", { className: "ffd-err", style: { maxWidth: 460 } }, store.error),
					h(
						"button",
						{ className: "ffd-act primary", onClick: () => startWriting(store.date, true) },
						"再试一次",
					),
				);
			}

			if (store.streaming && !store.markdown) {
				return h(
					"div",
					{ className: "ffd-empty" },
					writingArt(),
					h("b", null, PHASE_TEXT[store.phase] || "正在忙…"),
					h("div", null, "大肥鱼正在把今天嚼过的 token 翻出来数一数"),
					store.stats ? h(StatsChips, { stats: store.stats }) : null,
				);
			}

			if (store.markdown) {
				return h(
					"div",
					null,
					store.error ? h("div", { className: "ffd-err" }, store.error) : null,
					store.notice ? h("div", { className: "ffd-note" }, store.notice) : null,
					h("div", {
						dangerouslySetInnerHTML: { __html: renderMarkdown(store.markdown) },
					}),
					store.streaming ? h("span", { className: "ffd-caret" }) : null,
					store.stats ? h("div", { style: { marginTop: 18 } }, h(StatsChips, { stats: store.stats })) : null,
				);
			}

			if (store.loadingEntry) {
				return h("div", { className: "ffd-empty" }, avatarImg(), h("b", null, "翻抽屉中…"));
			}

			return h(
				"div",
				{ className: "ffd-empty" },
				h("img", { src: AVATAR, alt: "" }),
				h("b", null, "今天还没写日记呢"),
				h("div", null, "点下面那颗按钮，我就把今天陪你干的事都记下来"),
				store.stats ? h(StatsChips, { stats: store.stats }) : null,
				h(
					"button",
					{ className: "ffd-act primary", onClick: () => startWriting(store.date || store.today, false) },
					"现在就写今天的日记",
				),
			);
		}

		/** 'YYYY-MM-DD' → '10-04 周日' */
		const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
		function shortDate(d) {
			const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ""));
			if (!m) return String(d || "");
			const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
			return `${m[2]}-${m[3]} ${WEEK[t.getDay()]}`;
		}

		/** 可补写的日期列表（新的在前） */
		function backfillDates() {
			const today = store.today;
			if (!today) return [];
			const [y, mo, d] = today.split("-").map(Number);
			const out = [];
			const n = Math.max(1, Math.min(365, Number(store.backfillDays) || 60));
			for (let i = 0; i < n; i++) {
				const t = new Date(y, mo - 1, d - i);
				const p = (x) => String(x).padStart(2, "0");
				out.push(`${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`);
			}
			return out;
		}

		function HistoryPane() {
			useStore();
			const entries = store.entries || [];
			const rollups = store.rollups || [];
			const hasRollup = (key) => rollups.some((r) => r.key === key);

			const head = h(
				"div",
				{ className: "ffd-rollbar" },
				h("span", { className: "ffd-rollbar-lbl" }, "汇总："),
				h(
					"button",
					{ className: "ffd-act", disabled: store.rollupStreaming, onClick: () => startRollup("week") },
					"写周记",
				),
				h(
					"button",
					{ className: "ffd-act", disabled: store.rollupStreaming, onClick: () => startRollup("month") },
					"写月记",
				),
				rollups.length
					? h(
							"span",
							{ className: "ffd-rollbar-list" },
							rollups.slice(0, 4).map((r) =>
								h(
									"button",
									{
										className: "ffd-chip ffd-chip-btn",
										key: r.key,
										title: r.title || r.key,
										onClick: async () => {
											const got = await peekRollup(r.range === "month" ? "month" : "week");
											if (got && got.key === r.key) {
												store.set({ rollupMarkdown: got.markdown, rollupKey: r.key, notice: null });
											} else {
												store.set({ notice: "那篇不在当前区间，先点「写周记/月记」看这一段的" });
											}
										},
									},
									r.key,
								),
							),
						)
					: null,
			);

			const body = store.rollupMarkdown
				? h(
						"div",
						{ className: "ffd-rollup" },
						store.rollupKey ? h("div", { className: "ffd-note" }, `汇总：${store.rollupKey}`) : null,
						h("div", { dangerouslySetInnerHTML: { __html: renderMarkdown(store.rollupMarkdown) } }),
						store.rollupStreaming ? h("span", { className: "ffd-caret" }) : null,
					)
				: entries.length
					? h(
							"div",
							{ className: "ffd-list" },
							entries.map((e) =>
								h(
									"div",
									{ className: "ffd-row", key: e.date, onClick: () => openHistory(e.date) },
									h("span", { className: "d" }, shortDate(e.date)),
									h("span", { className: "t" }, e.title || "（无标题）"),
									h(
										"span",
										{ className: "m" },
										e.meta && e.meta.stats && e.meta.stats.toolCalls ? `${e.meta.stats.toolCalls} 次活` : "",
									),
								),
							),
						)
					: h(
							"div",
							{ className: "ffd-empty" },
							avatarImg(),
							h("b", null, "抽屉还是空的"),
							h("div", null, "写第一篇之后，这里就会一直攒着"),
						);

			return h(
				"div",
				null,
				store.rollupError ? h("div", { className: "ffd-err" }, store.rollupError) : null,
				head,
				body,
			);
		}

		/** 「实录」：她今天到底读到了什么。你上次问"为什么没提插件"，答案就在这一页 */
		function TranscriptPane() {
			useStore();
			const segs = store.transcriptSegments || [];

			if (store.transcriptLoading && !store.transcript) {
				return h("div", { className: "ffd-empty" }, avatarImg(), h("b", null, "正在翻…"));
			}
			if (!store.transcript) {
				// 失败了要**说出来**。以前这里不管有没有错误都显示"还没读呢"，
				// 点了按钮毫无反馈，看起来就像"没反应"。
				if (store.transcriptError) {
					return h(
						"div",
						{ className: "ffd-empty" },
						avatarImg(),
						h("b", null, "呜，读不到"),
						h("div", { className: "ffd-err", style: { maxWidth: 460 } }, store.transcriptError),
						h(
							"button",
							{
								className: "ffd-act primary",
								onClick: () => loadTranscript(store.date || store.today),
							},
							"再试一次",
						),
					);
				}
				return h(
					"div",
					{ className: "ffd-empty" },
					avatarImg(),
					h("b", null, "还没读呢"),
					h("div", null, "点下面的「看看她读到了什么」"),
				);
			}
			return h(
				"div",
				null,
				store.transcriptError ? h("div", { className: "ffd-err" }, store.transcriptError) : null,
				h(
					"div",
					{ className: "ffd-segs" },
					segs.map((s, i) =>
						h(
							"span",
							{ className: "ffd-chip", key: i, title: s.cwd || "" },
							`${s.isSubagent ? "分身 " : ""}${s.project}：${s.userTexts} 句 / ${s.files} 个文件 / ${s.toolCalls} 次活`,
						),
					),
				),
				h("div", { className: "ffd-note" }, `下面就是喂给她写日记的原文（${store.transcript.length} 字）。她只能照着这个写。`),
				h("pre", { className: "ffd-pre" }, store.transcript),
				store.transcriptRecall
					? h(
							"div",
							null,
							h("div", { className: "ffd-note" }, "另外还会带上前几天的记忆："),
							h("pre", { className: "ffd-pre ffd-pre-dim" }, store.transcriptRecall),
						)
					: null,
			);
		}

		function Panel() {
			useStore();
			const close = useCallback(() => store.set({ open: false }), []);

			useEffect(() => {
				if (!store.open) return undefined;
				const onKey = (e) => {
					if (e.key === "Escape") store.set({ open: false });
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [store.open]);

			if (!store.open) return null;

			const tab = store.tab;
			const onToday = tab === "today";
			const dateLabel = store.date || store.today || "";
			const st = store.streak;
			// 老 host 不返回 streak；那种情况下退回原来的"攒了几篇"，别误报成"第一篇还在路上"
			const sub = store.streaming
				? PHASE_TEXT[store.phase] || "正在忙…"
				: st && st.total
					? `连续 ${st.current} 天 · 共 ${st.total} 篇`
					: store.entryCount
						? `已经攒了 ${store.entryCount} 篇`
						: "第一篇还在路上";

			const tabBtn = (id, text) =>
				h(
					"button",
					{
						className: "ffd-tab",
						"data-on": tab === id ? "1" : "0",
						key: id,
						onClick: () => {
							store.set({ tab: id });
							// 切到实录页就顺手拉一次，别让用户进来看到空白还得再点一次按钮
							if (id === "transcript" && !store.transcript && !store.transcriptLoading) {
								loadTranscript(store.date || store.today).catch(() => {});
							}
							if (id === "history") refreshState().catch(() => {});
						},
					},
					text,
				);

			return h(
				"div",
				{
					className: "ffd-mask",
					onClick: (e) => {
						if (e.target === e.currentTarget) close();
					},
				},
				h(
					"div",
					{ className: "ffd-card", role: "dialog", "aria-label": "大肥鱼日记" },
					h(
						"div",
						{ className: "ffd-head" },
						avatarImg({ className: "ffd-ava" }),
						h(
							"div",
							{ className: "ffd-title" },
							h("b", null, "吃白饭的大肥鱼 · 日记"),
							h("span", null, `${dateLabel}　${sub}`),
						),
						h(
							"div",
							{ className: "ffd-tabs" },
							tabBtn("today", "日记"),
							tabBtn("transcript", "实录"),
							tabBtn("history", `历史${store.entryCount ? ` (${store.entryCount})` : ""}`),
						),
						h("button", { className: "ffd-x", onClick: close, title: "关闭" }, "×"),
					),
					h(
						"div",
						{ className: "ffd-body" },
						onToday ? h(TodayPane) : tab === "transcript" ? h(TranscriptPane) : h(HistoryPane),
					),
					h(
						"div",
						{ className: "ffd-foot" },
						// 日期选择：接口一直支持任意日期，以前界面只能写今天，忘了点那天就永远空着
						h(
							"select",
							{
								className: "ffd-date",
								value: store.date || store.today || "",
								title: "选一天：✓ 表示已经写过，可以回看或补写",
								onChange: (e) => {
									const d = e.target.value;
									store.set({ date: d, error: null, notice: null, rollupMarkdown: "", rollupKey: null });
									loadEntry(d).catch(() => {});
									if (store.tab === "transcript") loadTranscript(d).catch(() => {});
								},
							},
							backfillDates().map((d) => {
								const done = (store.dates || []).includes(d);
								return h(
									"option",
									{ value: d, key: d },
									`${shortDate(d)} ${done ? "✓" : "—"}${d === store.today ? "（今天）" : ""}`,
								);
							}),
						),
						onToday
							? h(
									"button",
									{
										className: "ffd-act primary",
										disabled: store.streaming,
										onClick: () => startWriting(store.date || store.today, !!store.markdown),
									},
									store.streaming
										? "写着呢…"
										: store.markdown
											? "重写这篇"
											: store.date && store.date !== store.today
												? "补写这天"
												: "写今天的日记",
								)
							: tab === "transcript"
								? h(
										"button",
										{
											className: "ffd-act primary",
											disabled: store.transcriptLoading,
											onClick: () => loadTranscript(store.date || store.today),
										},
										store.transcriptLoading ? "翻着呢…" : store.transcript ? "重新翻一遍" : "看看她读到了什么",
									)
								: null,
						h(
							"button",
							{
								className: "ffd-act",
								onClick: () => {
									refreshState().catch(() => {});
									if (store.date) loadEntry(store.date).catch(() => {});
								},
							},
							"刷新",
						),
						h(
							"span",
							{ className: "ffd-hint", title: store.root || "" },
							store.firstDay ? `第 ${store.dayNumber} 天 · ${store.root || ""}` : store.root || "",
						),
					),
				),
			);
		}

		/* ============================================================ *
		 * 挂载
		 * ============================================================ */

		const inject = ["slots"];

		function apply(ctx) {
			// 宿主上 slots 通常通过 ctx.get 取；老一些的客户端把它挂在 ctx.slots 上。
			const slots = (typeof ctx.get === "function" ? ctx.get("slots") : undefined) || ctx.slots;
			if (!slots || typeof slots.register !== "function") {
				console.warn("[fatfish-diary] 宿主没有 slots 服务，界面未挂载");
				return;
			}

			// 自己的样式表，随插件卸载一起清理
			ctx.effect(() => {
				const el = document.createElement("style");
				el.setAttribute("data-fatfish-diary", "");
				el.textContent = CSS;
				document.head.appendChild(el);
				return () => {
					if (el.parentNode) el.parentNode.removeChild(el);
				};
			}, "fatfish-diary: styles");

			// 侧栏页脚的动作位：一键写日记
			// 把 owner 传下来的 props（含 wide：侧栏是否展开）透传给组件，
			// 丢了它窄轨下就不知道要收起文字。
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register(
					{
						name: "sidebar.footer.action",
						id: "fatfish-diary-button",
						order: 20,
						label: () => "大肥鱼日记",
					},
					(ownerProps) => h(SidebarButton, ownerProps || {}),
				),
			);

			// 浮层面板
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: "fatfish-diary-panel",
						order: 60,
						label: () => "大肥鱼日记",
					},
					() => h(Panel),
				),
			);

			// 首屏预热一次状态，让按钮知道今天写没写
			ctx.effect(() => {
				let alive = true;
				refreshState()
					.then((s) => {
						if (alive && s.hasEntry) loadEntry(s.date).catch(() => {});
					})
					.catch(() => {});
				return () => {
					alive = false;
				};
			}, "fatfish-diary: warmup");
		}

		exports.apply = apply;
		exports.inject = inject;
		// 纯函数暴露给测试用。加载器只读 apply / inject，多挂一个键不影响任何行为；
		// 但渲染器不这么测就没法测（它不经过任何导出的入口）。
		// 纯函数与组件暴露给测试/预览用。加载器只读 apply / inject，多挂这些键不影响任何行为；
		// 但渲染器和面板不这么测就没法测（它们不经过任何导出的入口）。
		exports.__internals = { renderMarkdown, stripHtmlComments, escapeHtml, css: CSS, Panel, store, avatarImg };
		return module.exports;
	},
});
