/** Single-file web client served by `usta serve`. */
export const WEB_UI = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>usta</title>
<link rel="icon" href="data:,">
<style>
:root {
  --bg: #faf9f7; --panel: #ffffff; --text: #1f1d1a; --muted: #6f6a63; --line: #e7e3dd;
  --accent: #c2622d; --accent-soft: #f6e6dc; --ok: #2f7d4f; --err: #b3372f; --warn: #9a6a00;
  --code-bg: #f3f1ed; --add-bg: #e6f4ea; --del-bg: #fbe9e7; --shadow: 0 1px 2px rgba(0,0,0,.06);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161514; --panel: #1f1d1b; --text: #ece8e2; --muted: #9b958c; --line: #33302c;
    --accent: #e0834f; --accent-soft: #3a2a20; --ok: #6cc28c; --err: #ef7d73; --warn: #e2b04a;
    --code-bg: #262422; --add-bg: #1d3325; --del-bg: #3d2220; --shadow: none;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; display: flex; }
button, select, input, textarea { font: inherit; color: inherit; }
button { cursor: pointer; border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 6px 12px; }
button:hover { border-color: var(--accent); }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.danger { color: var(--err); }
aside { width: 272px; flex: none; border-right: 1px solid var(--line); background: var(--panel); display: flex; flex-direction: column; }
aside header { padding: 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); }
.brand { font-weight: 700; letter-spacing: .2px; }
.brand span { color: var(--accent); }
#sessions { overflow-y: auto; flex: 1; padding: 8px; }
.sess { padding: 8px 10px; border-radius: 8px; cursor: pointer; margin-bottom: 2px; }
.sess:hover { background: var(--code-bg); }
.sess.active { background: var(--accent-soft); }
.sess .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sess .m { color: var(--muted); font-size: 12px; }
main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.top { display: flex; gap: 8px; align-items: center; padding: 10px 20px; border-bottom: 1px solid var(--line); background: var(--panel); flex-wrap: wrap; }
.top .grow { flex: 1; min-width: 120px; color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.top select, .top input { border: 1px solid var(--line); background: var(--bg); border-radius: 8px; padding: 5px 8px; max-width: 280px; }
#log { flex: 1; overflow-y: auto; padding: 24px 20px 40px; }
.inner { max-width: 860px; margin: 0 auto; }
.msg { margin: 0 0 18px; }
.user { background: var(--accent-soft); border-radius: 12px; padding: 10px 14px; white-space: pre-wrap; word-wrap: break-word; }
.assistant p:first-child { margin-top: 0; }
.assistant pre, .card pre { background: var(--code-bg); border-radius: 8px; padding: 10px 12px; overflow-x: auto; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
code { font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--code-bg); padding: 1px 5px; border-radius: 4px; }
pre code { background: none; padding: 0; }
.assistant table { border-collapse: collapse; }
.assistant td, .assistant th { border: 1px solid var(--line); padding: 4px 8px; }
.thinking { color: var(--muted); font-style: italic; font-size: 14px; margin-bottom: 8px; }
.thinking summary { cursor: pointer; }
.card { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); margin: 8px 0; box-shadow: var(--shadow); overflow: hidden; }
.card .head { display: flex; gap: 8px; align-items: center; padding: 8px 12px; cursor: pointer; }
.card .head b { font-weight: 600; }
.card .head .title { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; font: 13px ui-monospace, Menlo, monospace; }
.card .body { display: none; border-top: 1px solid var(--line); padding: 8px 12px; }
.card.open .body { display: block; }
.card pre { margin: 0; max-height: 360px; white-space: pre-wrap; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); flex: none; }
.dot.run { background: var(--accent); animation: pulse 1s infinite; }
.dot.ok { background: var(--ok); }
.dot.err { background: var(--err); }
@keyframes pulse { 50% { opacity: .3; } }
.diff { font: 12.5px/1.45 ui-monospace, Menlo, monospace; white-space: pre; overflow-x: auto; }
.diff .a { background: var(--add-bg); display: block; }
.diff .d { background: var(--del-bg); display: block; }
.diff .h { color: var(--muted); display: block; }
.notice { font-size: 14px; padding: 6px 10px; border-radius: 8px; margin: 6px 0; }
.notice.error { color: var(--err); background: var(--del-bg); }
.notice.warn { color: var(--warn); background: var(--code-bg); }
.notice.info { color: var(--muted); }
.turnend { color: var(--muted); font-size: 12.5px; margin: -6px 0 18px; }
.composer { border-top: 1px solid var(--line); background: var(--panel); padding: 12px 20px 16px; }
.composer .inner { display: flex; gap: 10px; align-items: flex-end; }
textarea { flex: 1; resize: none; min-height: 46px; max-height: 240px; border: 1px solid var(--line); border-radius: 12px; padding: 11px 14px; background: var(--bg); outline: none; }
textarea:focus { border-color: var(--accent); }
.status { max-width: 860px; margin: 6px auto 0; color: var(--muted); font-size: 12.5px; min-height: 18px; }
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: none; align-items: center; justify-content: center; padding: 16px; z-index: 10; }
.overlay.show { display: flex; }
.modal { background: var(--panel); border-radius: 14px; max-width: 720px; width: 100%; max-height: 86vh; overflow-y: auto; padding: 18px 20px; box-shadow: 0 10px 40px rgba(0,0,0,.25); }
.modal h3 { margin: 0 0 8px; }
.modal .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.modal input { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; background: var(--bg); margin-top: 10px; }
.empty { color: var(--muted); text-align: center; margin-top: 18vh; }
.empty h2 { color: var(--text); font-weight: 600; }
@media (max-width: 760px) {
  body { flex-direction: column; }
  aside { width: 100%; max-height: 32vh; border-right: none; border-bottom: 1px solid var(--line); }
  #log, .composer, .top { padding-left: 16px; padding-right: 16px; }
}
</style>
</head>
<body>
<aside>
  <header><div class="brand"><span>✻</span> usta</div><button id="new">New</button></header>
  <div id="sessions"></div>
</aside>
<main>
  <div class="top">
    <div class="grow" id="where"></div>
    <select id="mode" title="Permission mode">
      <option value="normal">Normal</option>
      <option value="auto-edit">Accept edits</option>
      <option value="plan">Plan mode</option>
    </select>
    <input id="model" list="models" placeholder="provider/model" title="Model">
    <datalist id="models"></datalist>
    <button id="export" title="Download this session as a self-contained HTML page">Export</button>
  </div>
  <div id="log"><div class="inner" id="inner"></div></div>
  <div class="composer">
    <div class="inner">
      <textarea id="input" rows="1" placeholder="Ask anything · @file to attach · Enter to send, Shift+Enter for a new line"></textarea>
      <button id="send" class="primary">Send</button>
      <button id="stop" class="danger" style="display:none">Stop</button>
    </div>
    <div class="status" id="status"></div>
  </div>
</main>
<div class="overlay" id="overlay"><div class="modal" id="modal"></div></div>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  let token = "";
  try {
    const u = new URL(location.href);
    token = u.searchParams.get("token") || sessionStorage.getItem("usta-token") || "";
    if (u.searchParams.has("token")) {
      sessionStorage.setItem("usta-token", token);
      u.searchParams.delete("token");
      history.replaceState(null, "", u.pathname + u.search);
    }
  } catch (e) {}
  const api = async (method, path, body) => {
    const res = await fetch("/api" + path, {
      method,
      headers: Object.assign({ "content-type": "application/json" }, token ? { authorization: "Bearer " + token } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  };

  function md(src) {
    const blocks = [];
    let text = String(src || "").replace(/\r/g, "");
    text = text.replace(/\x60\x60\x60([\w+#.-]*)\n([\s\S]*?)(\n\x60\x60\x60|$)/g, (_, lang, code) => {
      blocks.push('<pre><code>' + esc(code) + '</code></pre>');
      return "\u0000" + (blocks.length - 1) + "\u0000";
    });
    const inline = (s) => esc(s)
      .replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    const out = [];
    let list = null;
    let table = [];
    const flushList = () => { if (list) { out.push("<" + list.tag + ">" + list.items.map((i) => "<li>" + i + "</li>").join("") + "</" + list.tag + ">"); list = null; } };
    const flushTable = () => {
      if (!table.length) return;
      const rows = table.filter((r) => !/^\s*\|?\s*:?-+/.test(r)).map((r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim())));
      out.push("<table>" + rows.map((r, i) => "<tr>" + r.map((c) => (i ? "<td>" : "<th>") + c + (i ? "</td>" : "</th>")).join("") + "</tr>").join("") + "</table>");
      table = [];
    };
    for (const line of text.split("\n")) {
      if (/^\u0000\d+\u0000$/.test(line.trim())) { flushList(); flushTable(); out.push(line.trim()); continue; }
      if (/^\s*\|.*\|\s*$/.test(line)) { flushList(); table.push(line); continue; }
      flushTable();
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { flushList(); out.push("<h" + Math.min(6, h[1].length + 1) + ">" + inline(h[2]) + "</h" + Math.min(6, h[1].length + 1) + ">"); continue; }
      const li = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
      if (li) {
        const tag = li[1] ? "ol" : "ul";
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push(inline(li[2]));
        continue;
      }
      flushList();
      if (/^\s*>/.test(line)) { out.push("<blockquote>" + inline(line.replace(/^\s*>\s?/, "")) + "</blockquote>"); continue; }
      if (!line.trim()) { out.push(""); continue; }
      out.push("<p>" + inline(line) + "</p>");
    }
    flushList();
    flushTable();
    return out.join("\n").replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  }

  function diffHtml(diff) {
    return '<div class="diff">' + String(diff).split("\n").filter((l) => !l.startsWith("---") && !l.startsWith("+++")).map((l) => {
      const cls = l.startsWith("@@") ? "h" : l.startsWith("+") ? "a" : l.startsWith("-") ? "d" : "";
      return '<span class="' + cls + '">' + (esc(l) || " ") + "</span>";
    }).join("") + "</div>";
  }

  const state = { session: null, source: null, running: false, current: null, cards: new Map(), children: new Set() };
  const inner = $("inner");
  const log = $("log");
  const scroll = () => { log.scrollTop = log.scrollHeight; };
  const setStatus = (t) => { $("status").textContent = t || ""; };
  const setRunning = (r) => {
    state.running = r;
    $("send").style.display = r ? "none" : "";
    $("stop").style.display = r ? "" : "none";
  };

  function addUser(text) {
    const d = document.createElement("div");
    d.className = "msg user";
    d.textContent = text;
    inner.appendChild(d);
    scroll();
  }
  function newAssistant() {
    const d = document.createElement("div");
    d.className = "msg assistant";
    inner.appendChild(d);
    state.current = { el: d, text: "", think: null, thinkText: "", textEl: null, raf: 0 };
    return state.current;
  }
  function assistantText(delta) {
    const cur = state.current || newAssistant();
    if (!cur.textEl) { cur.textEl = document.createElement("div"); cur.el.appendChild(cur.textEl); }
    cur.text += delta;
    if (!cur.raf) cur.raf = requestAnimationFrame(() => { cur.raf = 0; cur.textEl.innerHTML = md(cur.text); scroll(); });
  }
  function assistantThinking(delta) {
    const cur = state.current || newAssistant();
    if (!cur.think) {
      cur.think = document.createElement("details");
      cur.think.className = "thinking";
      cur.think.innerHTML = "<summary>Thinking…</summary><div></div>";
      cur.el.appendChild(cur.think);
    }
    cur.thinkText += delta;
    cur.think.lastChild.textContent = cur.thinkText;
  }
  function toolCard(callId, name, title) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = '<div class="head"><span class="dot run"></span><b>' + esc(name) + '</b><span class="title">' + esc(title) + '</span></div><div class="body"><pre></pre></div>';
    card.querySelector(".head").onclick = () => card.classList.toggle("open");
    (state.current ? state.current.el : inner).appendChild(card);
    state.cards.set(callId, card);
    state.current = null;
    scroll();
    return card;
  }
  function finishCard(callId, result) {
    const card = state.cards.get(callId) || toolCard(callId, result.name, result.title || "");
    card.querySelector(".dot").className = "dot " + (result.isError ? "err" : "ok");
    const body = card.querySelector(".body");
    const meta = result.metadata || {};
    if (meta.diff) { body.innerHTML = diffHtml(meta.diff); card.classList.add("open"); }
    else body.querySelector("pre") && (body.querySelector("pre").textContent = result.output || "");
    if (result.isError) card.classList.add("open");
  }
  function notice(level, text) {
    const d = document.createElement("div");
    d.className = "notice " + level;
    d.textContent = text;
    inner.appendChild(d);
    scroll();
  }
  const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);

  function renderHistory(data) {
    inner.innerHTML = "";
    state.cards.clear();
    for (const m of data.messages) {
      if (m.role === "user") {
        if (m.origin === "prompt") addUser(m.parts.filter((p) => p.type === "text" && !p.synthetic).map((p) => p.text).join(""));
        else if (m.origin === "summary") notice("info", "Conversation compacted into a summary.");
        else for (const p of m.parts) if (p.type === "tool_result") finishCard(p.callId, p);
        continue;
      }
      state.current = null;
      const cur = newAssistant();
      for (const p of m.parts) {
        if (p.type === "reasoning" && p.text) assistantThinking(p.text);
        if (p.type === "text") assistantText(p.text);
        if (p.type === "tool_call") toolCard(p.id, p.name, JSON.stringify(p.input).slice(0, 160));
      }
      void cur;
    }
    state.current = null;
    if (!data.messages.length) inner.innerHTML = '<div class="empty"><h2>What should we build?</h2><p>Ask a question, describe a change, or attach files with @path.</p></div>';
    scroll();
  }

  async function loadSessions() {
    const { sessions } = await api("GET", "/sessions");
    const box = $("sessions");
    box.innerHTML = "";
    for (const s of sessions) {
      const d = document.createElement("div");
      d.className = "sess" + (state.session === s.id ? " active" : "");
      d.innerHTML = '<div class="t">' + esc(s.title || "Untitled") + '</div><div class="m">' + new Date(s.updated).toLocaleString() + " · " + s.messages + " msgs</div>";
      d.onclick = () => openSession(s.id);
      box.appendChild(d);
    }
  }

  function subscribe(id) {
    if (state.source) state.source.close();
    const q = "?session=" + encodeURIComponent(id) + (token ? "&token=" + encodeURIComponent(token) : "");
    const es = new EventSource("/api/events" + q);
    state.source = es;
    const on = (type, fn) => es.addEventListener(type, (ev) => fn(JSON.parse(ev.data)));
    const mine = (e) => e.sessionId === state.session;
    on("turn.start", (e) => { if (mine(e)) { setRunning(true); setStatus("Thinking…"); } });
    on("message.start", (e) => { if (mine(e)) state.current = null; });
    on("message.delta", (e) => { if (!mine(e)) return; e.kind === "text" ? assistantText(e.text) : assistantThinking(e.text); setStatus(e.kind === "text" ? "Writing…" : "Thinking…"); });
    on("message.discarded", (e) => { if (mine(e) && state.current) { state.current.el.remove(); state.current = null; } });
    on("tool.start", (e) => { if (mine(e)) { toolCard(e.callId, e.name, e.title); setStatus("Running " + e.name + "…"); } else setStatus("Sub-agent: " + e.name + " " + e.title); });
    on("tool.progress", (e) => { const c = state.cards.get(e.callId); if (c) { const pre = c.querySelector("pre"); if (pre) pre.textContent = (pre.textContent + e.chunk).slice(-20000); } });
    on("tool.end", (e) => { if (mine(e)) finishCard(e.callId, e.result); });
    on("notice", (e) => { if (mine(e)) notice(e.level, e.message); });
    on("retry", (e) => { if (mine(e)) setStatus("Retrying in " + Math.round(e.delayMs / 1000) + "s: " + e.error); });
    on("compaction", (e) => { if (mine(e) && e.phase === "end") notice("info", "Conversation compacted."); });
    on("turn.end", (e) => {
      if (!mine(e)) return;
      setRunning(false);
      state.current = null;
      const u = e.usage;
      const d = document.createElement("div");
      d.className = "turnend";
      const changes = e.changes && e.changes.length ? e.changes.length + " files changed · " : "";
      d.textContent = (e.reason === "done" ? "✓ " : e.reason + " · ") + changes + (e.durationMs / 1000).toFixed(1) + "s · " + fmt(u.input + u.cacheRead + u.cacheWrite) + " in · " + fmt(u.output) + " out" + (e.cost != null ? " · $" + e.cost.toFixed(3) : "");
      inner.appendChild(d);
      setStatus("");
      scroll();
      loadSessions();
    });
    on("permission.request", (e) => permissionModal(e.request));
    on("question.request", (e) => questionModal(e));
    on("plan.review", (e) => planModal(e));
    on("mode", (e) => { if (mine(e)) $("mode").value = e.mode; });
    es.onerror = () => setStatus("Connection lost; retrying…");
    es.addEventListener("hello", () => setStatus(""));
  }

  function modal(html, bind) {
    $("modal").innerHTML = html;
    $("overlay").classList.add("show");
    bind($("modal"), () => $("overlay").classList.remove("show"));
  }
  function permissionModal(req) {
    const d = req.detail || {};
    let detail = "";
    if (d.command) detail = "<pre>" + esc(d.command) + "</pre>";
    else if (d.diff) detail = diffHtml(d.diff);
    else if (d.url) detail = "<p><code>" + esc(d.url) + "</code></p>";
    else if (d.preview) detail = "<pre>" + esc(d.preview) + "</pre>";
    const scope = (req.always && req.always.length ? req.always : req.patterns).join(", ");
    modal('<h3>Allow ' + esc(req.tool) + '?</h3><p>' + esc(req.title) + '</p>' + detail +
      '<input id="fb" placeholder="Optional: tell usta what to do instead (used when denying)">' +
      '<div class="actions"><button class="primary" data-d="once">Allow once</button><button data-d="session">Allow ' + esc(scope) + ' this session</button><button data-d="always">Always allow in this project</button><button class="danger" data-d="deny">Deny</button></div>',
      (m, close) => m.querySelectorAll("button").forEach((b) => b.onclick = async () => {
        close();
        await api("POST", "/permissions/" + req.id, { decision: b.dataset.d, feedback: m.querySelector("#fb").value || undefined }).catch((err) => notice("error", err.message));
      }));
  }
  function questionModal(e) {
    const q = e.request;
    const opts = (q.options || []).map((o, i) => '<button data-i="' + i + '">' + esc(o.label) + (o.description ? " — " + esc(o.description) : "") + "</button>").join("");
    modal("<h3>" + esc(q.question) + "</h3>" + '<div class="actions">' + opts + '</div><input id="ans" placeholder="Or type your answer and press Enter">', (m, close) => {
      const answer = async (a) => { close(); await api("POST", "/questions/" + e.id, { answer: a }); };
      m.querySelectorAll("button").forEach((b) => b.onclick = () => answer(q.options[Number(b.dataset.i)].label));
      const inp = m.querySelector("#ans");
      inp.onkeydown = (ev) => { if (ev.key === "Enter" && inp.value.trim()) answer(inp.value.trim()); };
      inp.focus();
    });
  }
  function planModal(e) {
    modal('<h3>Ready to implement this plan?</h3><div class="assistant">' + md(e.plan) + '</div><input id="pf" placeholder="Feedback (optional, when asking for changes)">' +
      '<div class="actions"><button class="primary" data-a="auto">Yes, auto-accept edits</button><button data-a="manual">Yes, approve each edit</button><button data-a="no">Keep planning</button></div>',
      (m, close) => m.querySelectorAll("button").forEach((b) => b.onclick = async () => {
        close();
        const a = b.dataset.a;
        await api("POST", "/plans/" + e.id, a === "no" ? { approved: false, feedback: m.querySelector("#pf").value || undefined } : { approved: true, mode: a === "auto" ? "auto-edit" : "normal" });
      }));
  }

  async function openSession(id) {
    state.session = id;
    const data = await api("GET", "/sessions/" + id);
    $("mode").value = data.meta.mode || "normal";
    $("model").value = data.meta.model || "";
    renderHistory(data);
    setRunning(Boolean(data.running));
    subscribe(id);
    loadSessions();
  }
  async function newSession() {
    const { session } = await api("POST", "/sessions", { model: $("model").value || undefined, mode: $("mode").value });
    await openSession(session.id);
    $("input").focus();
  }

  async function send() {
    const text = $("input").value.trim();
    if (!text || state.running) return;
    if (!state.session) await newSession();
    $("input").value = "";
    autosize();
    if (inner.querySelector(".empty")) inner.innerHTML = "";
    addUser(text);
    setRunning(true);
    try { await api("POST", "/sessions/" + state.session + "/prompt", { text }); }
    catch (err) { notice("error", err.message); setRunning(false); }
  }
  const autosize = () => { const t = $("input"); t.style.height = "auto"; t.style.height = Math.min(240, t.scrollHeight) + "px"; };
  $("input").addEventListener("input", autosize);
  $("input").addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); send(); } });
  $("send").onclick = send;
  $("stop").onclick = () => state.session && api("POST", "/sessions/" + state.session + "/abort", {});
  $("export").onclick = async () => {
    if (!state.session) return notice("error", "Start or open a session first.");
    const res = await fetch("/api/sessions/" + state.session + "/export?format=html", { headers: token ? { authorization: "Bearer " + token } : {} });
    if (!res.ok) return notice("error", "Export failed: " + res.statusText);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await res.blob());
    a.download = "usta-" + state.session + ".html";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  $("new").onclick = () => newSession().catch((err) => notice("error", err.message));
  $("mode").onchange = () => state.session && api("PATCH", "/sessions/" + state.session, { mode: $("mode").value });
  $("model").onchange = () => state.session && api("PATCH", "/sessions/" + state.session, { model: $("model").value }).catch((err) => notice("error", err.message));

  (async () => {
    try {
      const info = await api("GET", "/info");
      $("where").textContent = info.root + (info.yolo ? "  ·  yolo mode" : "");
      $("model").value = info.model || "";
      const { models } = await api("GET", "/models");
      $("models").innerHTML = models.map((m) => '<option value="' + esc(m.id) + '">' + esc(m.name || "") + "</option>").join("");
      await loadSessions();
      renderHistory({ messages: [] });
    } catch (err) {
      inner.innerHTML = '<div class="empty"><h2>Cannot connect</h2><p>' + esc(err.message) + '</p><p>Open the URL printed by <code>usta serve</code> (it includes the access token).</p></div>';
    }
  })();
})();
</script>
</body>
</html>`;
