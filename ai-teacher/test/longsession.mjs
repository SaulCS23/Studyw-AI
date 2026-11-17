// End-to-end check of ai-teacher/index.html in real headless Chrome, with the two network services faked:
//   - the ElevenLabs SDK is replaced by a stub that lets this script fire the same events the SDK fires
//     (onMessage, onModeChange, onInterruption, onAudioAlignmentPlayback, and the agent's show_on_board client tool);
//   - api.anthropic.com is answered with canned streamed drawing steps from fixtures.js (or an error, to test fallbacks).
// It proves the page's wiring, not ElevenLabs' or Claude's quality. It needs no npm packages.
// The pen runs at 2x real speed here just to keep the test short; everything else is real.
//
// Run: node ai-teacher/test/integration.mjs        (CHROME_PATH overrides the Chrome location)

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fixtures = require("./fixtures.js");
const here = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = pathToFileURL(path.join(here, "..", "index.html")).href;
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- canned services ---------- */
const service = { delayMs: 0, planner: [], inflight: 0, maxInflight: 0, plans: new Map() };
const elevenLabsStub = `export const Conversation = { async startSession(opts){ window.__opts = opts; window.__sessions = (window.__sessions || 0) + 1;
  setTimeout(() => opts.onConnect && opts.onConnect({}), 0);
  const convo = { endSession: async () => { opts.onDisconnect && opts.onDisconnect({ reason: "user" }); }, sendUserMessage(){}, sendUserActivity(){}, getInputVolume(){ return window.__inputVolume ?? 0.2; }, getOutputVolume(){ return 0; }, isOpen(){ return !window.__closed; }, sendContextualUpdate(t){ (window.__updates = window.__updates || []).push(t); } };
  window.__convo = convo; return convo; } };`;

/** The text of a streamed Anthropic reply: server-sent events carrying text deltas. */
function sse(text) {
  const ev = (obj) => "event: " + obj.type + "\ndata: " + JSON.stringify(obj) + "\n\n";
  const pieces = text.match(/[\s\S]{1,40}/g) || [];
  return ev({ type: "message_start", message: { usage: { input_tokens: 800 } } }) + ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
    + pieces.map((p) => ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } })).join("")
    + ev({ type: "message_delta", usage: { output_tokens: Math.ceil(text.length / 4) } }) + ev({ type: "message_stop" });
}

/* ---------- Chrome DevTools Protocol, minimal ---------- */

const profile = mkdtempSync(path.join(tmpdir(), "ttl-chrome-"));
const chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0", "--user-data-dir=" + profile, "--window-size=1200,900", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const cleanup = () => { try { chrome.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup);

const wsUrl = await new Promise((resolve, reject) => {
  let log = ""; const timer = setTimeout(() => reject(new Error("Chrome did not start: " + log)), 15000);
  chrome.stderr.on("data", (chunk) => { log += chunk; const m = /DevTools listening on (ws:\/\/\S+)/.exec(log); if (m) { clearTimeout(timer); resolve(m[1]); } });
});
const port = new URL(wsUrl).port;
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

let nextId = 0; const waiting = new Map(); const pageErrors = []; const consoleLines = [];
socket.onmessage = async (message) => {
  const data = JSON.parse(message.data);
  if (data.id) { const w = waiting.get(data.id); waiting.delete(data.id); data.error ? w.reject(new Error(JSON.stringify(data.error))) : w.resolve(data.result); return; }
  if (data.method === "Fetch.requestPaused") return handlePaused(data.params);
  if (data.method === "Runtime.exceptionThrown") pageErrors.push(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text);
  if (data.method === "Runtime.consoleAPICalled") {
    const text = data.params.args.map((a) => a.value ?? a.description).join(" ");
    consoleLines.push({ type: data.params.type, text });
    if (data.params.type === "error" && !text.startsWith("[Whiteboard]")) pageErrors.push("console.error: " + text);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; waiting.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const cors = [["access-control-allow-origin", "*"], ["access-control-allow-headers", "*"], ["access-control-allow-methods", "*"]].map(([name, value]) => ({ name, value }));
async function fulfill(requestId, status, contentType, text) {
  await send("Fetch.fulfillRequest", { requestId, responseCode: status, responseHeaders: [...cors, { name: "content-type", value: contentType }], body: Buffer.from(text).toString("base64") });
}
async function handlePaused({ requestId, request }) {
  try {
    if (request.url.includes("@elevenlabs/client")) return await fulfill(requestId, 200, "text/javascript", elevenLabsStub);
    if (request.method === "OPTIONS") return await fulfill(requestId, 204, "text/plain", "");
    const answer = await answerAnthropic(request.postData);
    await fulfill(requestId, answer.status, answer.type, answer.text);
  } catch (error) { if (!/Invalid InterceptionId|Target closed|No resource/i.test(error.message)) pageErrors.push("test harness: " + error.message); } // a request the page cancelled is fine
}

await send("Page.enable"); await send("Runtime.enable");
await send("Fetch.enable", { patterns: [{ urlPattern: "https://cdn.jsdelivr.net/npm/@elevenlabs/*" }, { urlPattern: "https://api.anthropic.com/*" }] });


async function answerAnthropic(requestBody) {
  const body = JSON.parse(requestBody || "{}");
  service.inflight++; service.maxInflight = Math.max(service.maxInflight, service.inflight);
  try {
    if (service.delayMs) await sleep(service.delayMs);
    service.planner.push(body.messages ? body.messages[0].content.length : 0);
    const prompt = body.messages[0].content;
    const spoken = [...prompt.matchAll(/^Teacher: (.*)$/gm)].pop()?.[1] || "";
    const key = [...service.plans.keys()].find((k) => spoken.includes(k));
    const ops = key ? service.plans.get(key) : [{ op: "moment", kind: "speak_only" }];
    return { status: 200, type: "text/event-stream", text: sse(ops.map((o) => JSON.stringify(o)).join("\n") + "\n") };
  } finally { service.inflight--; }
}


/* ---------- helpers ---------- */
const page = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
async function waitFor(check, label, ms = 25000) {
  const start = Date.now();
  for (;;) { const value = await check(); if (value) return value; if (Date.now() - start > ms) throw new Error("timed out waiting for: " + label); await sleep(50); }
}

/* ---------- the long lesson ---------- */

const TURNS = Number(process.env.LS_TURNS || 60);       // 60 turns is about 30 minutes at one turn every 30 s
const PEN_SPEED = Number(process.env.LS_PEN || 6);      // the pen runs faster than real time so the run is short; everything else is real
const topics = ["rivers", "volcanoes", "glaciers", "deserts", "forests", "oceans", "mountains", "islands", "lakes", "caves", "plains", "canyons"];

await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
  const lag = { max: 0, total: 0, n: 0 }; window.__lag = lag; let last = performance.now();
  setInterval(() => { const now = performance.now(), l = Math.max(0, now - last - 50); last = now; lag.max = Math.max(lag.max, l); lag.total += l; lag.n++; }, 50);
  const timers = new Set(), st = window.setTimeout.bind(window), ct = window.clearTimeout.bind(window), si = window.setInterval.bind(window), ci = window.clearInterval.bind(window);
  window.__timers = timers;
  window.setTimeout = (fn, ms, ...a) => { const id = st((...x) => { timers.delete(id); return typeof fn === 'function' ? fn(...x) : undefined; }, ms, ...a); timers.add(id); return id; };
  window.clearTimeout = (id) => { timers.delete(id); ct(id); };
  window.setInterval = (fn, ms, ...a) => { const id = si(fn, ms, ...a); timers.add(id); return id; };
  window.clearInterval = (id) => { timers.delete(id); ci(id); };
  const listeners = new Map(); window.__listeners = listeners;
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
  const keyOf = (t, type) => (t === window ? 'window' : t === document ? 'document' : (t && t.nodeName) || 'other') + ':' + type;
  EventTarget.prototype.addEventListener = function (type, fn, o) { const k = keyOf(this, type); listeners.set(k, (listeners.get(k) || 0) + 1); return add.call(this, type, fn, o); };
  EventTarget.prototype.removeEventListener = function (type, fn, o) { const k = keyOf(this, type); listeners.set(k, (listeners.get(k) || 0) - 1); return rem.call(this, type, fn, o); };
  const frames = { deltas: [] }; window.__frames = frames; let lastFrame = performance.now(); const tick = (t) => { const d = t - lastFrame; lastFrame = t; if (d < 400) frames.deltas.push(d); requestAnimationFrame(tick); }; requestAnimationFrame(tick); // frame time while the pen draws
  window.__lagReset = () => { last = performance.now(); lag.max = 0; };
  window.__collect = (doAudit) => {
    const wb = window.__wb, t0 = performance.now(); let auditMs = null, checked = 0;
    try { if (doAudit && wb && wb.audit) { const r = wb.audit(); checked = r.checked; auditMs = performance.now() - t0; } } catch (e) { auditMs = -1; }
    const out = { heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null, dom: document.querySelectorAll('#wbBoard *').length, pages: wb ? wb.pages.length : 0, timers: timers.size, queue: wb ? wb.queue.length : 0,
      checkMs: wb ? Math.round(wb.checkCostMs || 0) : null, updates: (window.__updates || []).length, updateChars: (window.__updates || []).reduce((s, u) => s + u.length, 0), auditMs, auditStrokes: checked, listeners: Object.fromEntries([...listeners].filter(([, v]) => v !== 0)), sessions: window.__sessions };
    const ds = frames.deltas.splice(0), sorted = ds.sort((a, b) => a - b); out.frameMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; out.frameP95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : null; out.frames = sorted.length;
    const lagMax = lag.max; out.lagMax = lagMax; lag.max = 0; last = performance.now(); return out;
  };
})()` });

await send("Fetch.enable", { patterns: [{ urlPattern: "https://cdn.jsdelivr.net/npm/@elevenlabs/*" }, { urlPattern: "https://api.anthropic.com/*" }] });
await send("Page.navigate", { url: pageUrl });
await waitFor(() => page("document.readyState === 'complete'"), "page load");
await page(`localStorage.setItem('ttl-agent','agent_test'); localStorage.setItem('ttl-akey','sk-test'); localStorage.setItem('ttl-board','animated'); localStorage.setItem('ttl-wbmodel','claude-sonnet-5-5'); localStorage.setItem('ttl-hints', '${process.env.LS_HINTS || "on"}'); true`);
await send("Page.reload"); await sleep(300);
await waitFor(() => page("document.readyState === 'complete' && !!window.Whiteboard && !!window.WhiteboardCore && !!document.getElementById('call')"), "scripts loaded");
await page(`(() => { const Original = window.Whiteboard; window.Whiteboard = class extends Original { constructor(host, options) { super(host, { ...options, timeScale: ${PEN_SPEED} }); window.__wb = this; } }; return true; })()`);
if (process.env.LS_NOCHECK) await page("window.Whiteboard.prototype.scheduleCompositionCheck = () => {}; true");
await page("document.getElementById('call').click(); true");
await waitFor(() => page("!!window.__opts"), "stub conversation started");

const turnSpec = (n) => {
  const topic = topics[n % topics.length] + " " + (n + 1), kind = n % 3;
  const teacher = `Next we talk about ${topic}. It has a name, a size and a rule, so look at what we write.`;
  let ops;
  if (kind === 0) ops = [
    { op: "write", kind: "text", size: "title", content: "About " + topic, id: "lt" + n, cue: "about " + topic },
    { op: "write", kind: "text", content: "Size is number " + (n + 1), id: "ls" + n, cue: "a size" },
    { op: "write", kind: "math", content: `x_{${n + 1}} = ${n + 1}^2 + \\frac{${n + 1}}{2}`, id: "lm" + n, cue: "a rule" }];
  else if (kind === 1) ops = [
    { op: "graph", id: "g" + n, w: 380, h: 280, xmin: -3, xmax: 3, ymin: -1, ymax: 9, xlabel: "x", ylabel: "y", cue: "about " + topic },
    { op: "plot", graph: "g" + n, fn: "x^2", color: "blue", label: "y = x²", id: "gp" + n, cue: "a name" },
    { op: "plot", graph: "g" + n, fn: "2*x-1", color: "amber", label: "tangent at x = 1", id: "gt" + n, cue: "a size" },
    { op: "point", graph: "g" + n, px: 0, py: 0, label: "vertex", color: "red", id: "gv" + n, cue: "a rule" }];
  else ops = [{ op: "diagram", id: "dg" + n, title: "About " + topic, layout: "row", parts: [{ node: "a" + n, label: "Source", shape: "rounded", cue: "about " + topic }, { node: "b" + n, label: "Flow", shape: "rounded", cue: "a name" }, { node: "c" + n, label: "Result", shape: "rounded", cue: "a size" }, { from: "a" + n, to: "b" + n, label: "gives", style: "arrow", cue: "a rule" }, { from: "b" + n, to: "c" + n, style: "arrow" }] }];
  return { teacher, ops, topic };
};

const rows = []; let profiling = false;
let mainThreadProbe = [];
for (let n = 0; n < TURNS; n++) {
  if (process.env.LS_PROFILE && !profiling && n >= TURNS - 8) { await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 500 }); await send('Profiler.start'); profiling = true; }
  const spec = turnSpec(n), ack = n % 5 === 4, interrupt = n % 7 === 6, longPause = n % 11 === 10;
  const teacher = ack ? "Great!" : spec.teacher, student = ack ? "Okay." : "Can you explain " + spec.topic + " please?";
  if (!ack) service.plans.set(spec.teacher.slice(0, 40), spec.ops);
  if (longPause) await sleep(2500);
  const probe0 = Date.now(); await page("performance.now()"); const probeMs = Date.now() - probe0; // how long the page takes to answer: a busy main thread answers late
  for (let i = 0; i < 6; i++) { await page("__opts.onVadScore({ vadScore: 0.9 }); true"); await sleep(50); }
  for (let i = 0; i < 9; i++) { await page("__opts.onVadScore({ vadScore: 0.04 }); true"); await sleep(50); }
  await page(`__opts.onMessage({ source: 'user', message: ${JSON.stringify(student)} }); true`);
  await sleep(150); await page("__opts.onAudio('AAAA'); true");
  await page(`__opts.onModeChange({ mode: 'listening' }); __opts.onModeChange({ mode: 'speaking' }); __opts.onMessage({ source: 'ai', message: ${JSON.stringify(teacher)} }); __opts.onAudioAlignmentPlayback({ event_id: 1, alignment: { chars: ${JSON.stringify(Array.from(teacher.slice(0, 40)))} } }); true`);
  if (interrupt) { await sleep(700); await page(`__opts.onInterruption(); __opts.onModeChange({ mode: 'listening' }); __opts.onMessage({ source: 'user', message: 'Wait, sorry, one question.' }); true`); await sleep(400); }
  else await sleep(1400);
  await page("__opts.onModeChange({ mode: 'listening' }); true");
  const t0 = Date.now();
  await waitFor(() => page("(() => { const w = window.__wb; return !w || (!w.running && w.queue.length === 0); })()"), "board idle", 30000).catch(() => {});
  const settleMs = Date.now() - t0;
  const m = await page("window.__collect(" + ((n + 1) % 30 === 0) + ")"); // (the measuring audit runs only now and then, and its own time is not counted as lag)
  rows.push({ n: n + 1, probeMs, settleMs, plannerPrompt: service.planner.at(-1) || 0, inflight: service.maxInflight, ...m });
  if ((n + 1) % 10 === 0) console.log(`turn ${n + 1}: heap ${m.heapMB?.toFixed(0)} MB, dom ${m.dom}, pages ${m.pages}, audit ${m.auditMs?.toFixed(0)} ms (${m.auditStrokes} strokes), probe ${probeMs} ms, lag ${m.lagMax.toFixed(0)} ms, timers ${m.timers}, updates ${m.updates}`);
}

if (profiling) {
  const { profile } = await send('Profiler.stop'); const self = new Map(), byId = new Map(profile.nodes.map((nd) => [nd.id, nd]));
  profile.samples.forEach((id, i) => { const nd = byId.get(id), f = nd.callFrame, key = (f.functionName || '(anonymous)') + ' ' + f.url.split('/').pop() + ':' + f.lineNumber; self.set(key, (self.get(key) || 0) + (profile.timeDeltas[i] || 0) / 1000); });
  console.log('CPU PROFILE of the last 8 turns (self time ms):'); [...self].sort((a, b) => b[1] - a[1]).slice(0, 14).forEach(([k, v]) => console.log('  ' + v.toFixed(0).padStart(7) + '  ' + k));
}
/* ---------- report ---------- */
const med = (a) => { const s = a.filter((v) => v != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const slice = (from, to) => rows.slice(from, to);
const fmt = (v, d = 0) => (v == null ? "n/a" : Number(v).toFixed(d));
const early = slice(0, 6), late = slice(-6);
console.log("\nLONG SESSION: " + TURNS + " turns, pen x" + PEN_SPEED + ", hints " + (process.env.LS_HINTS || "on"));
console.log("metric".padEnd(34) + "first 6 turns".padEnd(16) + "last 6 turns");
for (const [label, key, d] of [["main-thread probe (ms, median)", "probeMs", 0], ["frame time median (ms)", "frameMs", 1], ["frame time 95th percentile (ms)", "frameP95", 1], ["event-loop lag per turn (ms, median)", "lagMax", 0], ["audit() time (ms, median)", "auditMs", 0], ["DOM nodes on the board", "dom", 0], ["JS heap (MB)", "heapMB", 1], ["notebook pages", "pages", 0], ["active timers", "timers", 0], ["board settle time (ms)", "settleMs", 0], ["planner prompt size (chars)", "plannerPrompt", 0], ["context updates sent so far", "updates", 0], ["context update chars so far", "updateChars", 0]])
  console.log(label.padEnd(34) + fmt(med(early.map((r) => r[key])), d).padEnd(16) + fmt(med(late.map((r) => r[key])), d));
console.log("max concurrent planner requests: " + service.maxInflight + "; sessions started: " + rows.at(-1).sessions + "; page errors: " + pageErrors.length);
const first = rows[1].listeners || {}, last = rows.at(-1).listeners || {}, grew = Object.keys(last).filter((k) => (last[k] || 0) - (first[k] || 0) > 5).map((k) => `${k} +${(last[k] || 0) - (first[k] || 0)}`);
console.log("listeners that grew by more than 5: " + (grew.join(", ") || "none"));
console.log("worst turn: lag " + fmt(Math.max(...rows.map((r) => r.lagMax))) + " ms, probe " + fmt(Math.max(...rows.map((r) => r.probeMs))) + " ms, audit " + fmt(Math.max(...rows.map((r) => r.auditMs ?? 0))) + " ms");
if (process.env.LS_JSON) (await import("node:fs")).writeFileSync(process.env.LS_JSON, JSON.stringify(rows, null, 1));

/* ---------- what must hold after a long lesson ---------- */
const results = []; const check = (name, ok, detail) => { results.push(ok); console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && detail !== undefined ? "  -> " + detail : "")); };
const lateRows = rows.slice(-6), earlyRows = rows.slice(0, 6);
check("no page errors during the whole lesson", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
check("event-loop lag does not grow with the lesson (late median " + fmt(med(lateRows.map((r) => r.lagMax))) + " ms, early " + fmt(med(earlyRows.map((r) => r.lagMax))) + " ms)", med(lateRows.map((r) => r.lagMax)) <= Math.max(60, 3 * med(earlyRows.map((r) => r.lagMax)) + 40));
check("frames stay smooth while the pen draws (95th percentile " + fmt(med(lateRows.map((r) => r.frameP95)), 1) + " ms)", med(lateRows.map((r) => r.frameP95)) <= 25);
check("the page's own composition check stays cheap however long the lesson (" + fmt(Math.max(...rows.map((r) => r.checkMs || 0))) + " ms at most)", Math.max(...rows.map((r) => r.checkMs || 0)) <= 150);
check("JS heap does not leak (" + fmt(rows[1].heapMB, 1) + " to " + fmt(rows.at(-1).heapMB, 1) + " MB)", rows.at(-1).heapMB - rows[1].heapMB < 20);
check("timers do not accumulate (" + rows.at(-1).timers + " active)", rows.at(-1).timers <= 6);
check("no listener grows during the lesson", grew.length === 0, grew.join(", "));
check("session context updates to the agent stay few and short (" + rows.at(-1).updates + " updates, " + rows.at(-1).updateChars + " characters in " + TURNS + " turns)", rows.at(-1).updates <= 10 && rows.at(-1).updateChars <= 4500);
check("never more than 2 planner requests in flight at once (" + service.maxInflight + ")", service.maxInflight <= 2);
check("the board settles as fast at the end as at the start (" + fmt(med(lateRows.map((r) => r.settleMs))) + " vs " + fmt(med(earlyRows.map((r) => r.settleMs))) + " ms)", med(lateRows.map((r) => r.settleMs)) <= 1.5 * med(earlyRows.map((r) => r.settleMs)) + 500);
check("the notebook kept every page (" + rows.at(-1).pages + ")", rows.at(-1).pages >= Math.floor(TURNS / 4));

/* ---------- failures in the middle of a long lesson: reported by layer, nothing silently lost ---------- */
const banner = () => page("(() => { const b = document.getElementById('health'); return { shown: !b.hidden, text: b.textContent, reconnect: !document.getElementById('reconnect').hidden }; })()");
const waitBanner = async (accept, ms = 6000) => { const t0 = Date.now(); for (;;) { const found = await banner(); if (accept(found) || Date.now() - t0 > ms) return found; await sleep(200); } }; // (the banner refreshes once a second)
const feed = async (ms, score) => { for (let t = 0; t < ms; t += 100) { await page(`__opts.onVadScore({ vadScore: ${score} }); true`); await sleep(100); } };
await page("Object.assign(window.__health, { transcriptStallMs: 2500, answerStallMs: 3000, vadSilenceMs: 2000, hiddenMs: 1000, audioStallMs: 3000 }); true");
await page("__opts.onModeChange({ mode: 'listening' }); true"); await feed(1500, 0.02);
check("healthy: no warning is shown", !(await banner()).shown, JSON.stringify(await banner()));
// stalled transcription
await feed(1500, 0.9); await feed(800, 0.02); await feed(3200, 0.02);
let b = await waitBanner((x) => x.shown && /transcription/.test(x.text));
check("stalled transcription: spoke, no transcript -> reported as the transcription / end-of-turn layer, not the microphone or the whiteboard", b.shown && /transcription/.test(b.text) && !/microphone \/ voice activity/.test(b.text), b.text.slice(0, 200));
const boardBefore = await page("window.__wb.items.size"), pagesBefore = await page("window.__wb.pages.length");
await page(`__opts.onMessage({ source: 'user', message: 'Hello?' }); true`); await sleep(1300);
check("a late transcript clears the warning", !(await banner()).shown, JSON.stringify(await banner()));
// the agent stalls after the transcript
await feed(3800, 0.02); b = await waitBanner((x) => x.shown && /agent \(LLM/.test(x.text)); // (the microphone itself keeps reporting)
check("agent stall: transcript received, no answer -> reported as the agent layer", b.shown && /agent/.test(b.text) && /not the whiteboard/.test(b.text), b.text.slice(0, 200));
await page(`__opts.onModeChange({ mode: 'speaking' }); __opts.onMessage({ source: 'ai', message: 'Sorry, I am here.' }); __opts.onAudioAlignmentPlayback({ event_id: 1, alignment: { chars: ['S','o'] } }); true`); await sleep(1200);
// the voice-activity stream goes quiet
await page("__opts.onModeChange({ mode: 'listening' }); true"); await feed(1200, 0.02); await sleep(2200); b = await waitBanner((x) => x.shown && /not hearing you/.test(x.text));
check("voice-activity updates stop -> reported as microphone / voice activity: the teacher is not hearing you", b.shown && /microphone/.test(b.text) && /not hearing you/.test(b.text), b.text.slice(0, 120) + " | " + await page("JSON.stringify({ t: window.__health.transcriptAt, x: window.__health.textAt, a: window.__health.audibleAt, now: performance.now(), mode: window.__health.mode, lastVad: window.__health.lastVadAt })"));
await feed(600, 0.02); await sleep(1200); check("they return -> the warning clears", !(await banner()).shown, JSON.stringify(await banner()));
// background tab
await page("Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); true"); await feed(1500, 0.02); b = await waitBanner((x) => x.shown && /background/.test(x.text)); check("background tab -> reported (browsers throttle audio and timers)", b.shown && /background/.test(b.text), b.text.slice(0, 160) + " | " + await page("JSON.stringify({ hidden: window.__health.hidden, hiddenAt: window.__health.hiddenAt, now: performance.now(), docHidden: document.hidden, lastVadAt: window.__health.lastVadAt })"));
await page("Object.defineProperty(document, 'hidden', { get: () => false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); true"); await feed(300, 0.02);
// the connection drops in the middle of the lesson
const transcriptBefore = await page("document.getElementById('caption').textContent");
await page("window.__closed = true; __opts.onDisconnect({ reason: 'error', message: 'socket closed' }); true"); await sleep(1200);
b = await banner();
if (process.env.SHOT_DIR) { const shot = await send('Page.captureScreenshot', { format: 'png' }); (await import('node:fs')).writeFileSync(path.join(process.env.SHOT_DIR, 'long_connection_lost.png'), Buffer.from(shot.data, 'base64')); }
check("connection lost: a clear message and a Reconnect button, never a silent reconnect", b.shown && /connection to ElevenLabs closed/.test(b.text) && b.reconnect && (await page("window.__sessions")) === 1, JSON.stringify(b).slice(0, 220));
check("connection lost: the whiteboard, its pages and the teacher's last words are kept", (await page("window.__wb.items.size")) === boardBefore && (await page("window.__wb.pages.length")) === pagesBefore && (await page("document.getElementById('caption').textContent")) === transcriptBefore, "items " + boardBefore + " pages " + pagesBefore);
await page("window.__closed = false; document.getElementById('reconnect').click(); true");
await waitFor(() => page("window.__sessions === 2"), "reconnected", 10000);
await sleep(1500);
const restored = await page("(window.__updates || []).filter((u) => u.includes('interrupted by a connection problem'))");
check("reconnect: a NEW session is started on the user's click, with a short honest summary (it does not remember the old one)", restored.length === 1 && restored[0].length <= 900 && /do not pretend to remember/.test(restored[0]), JSON.stringify(restored).slice(0, 200));
check("reconnect: the board and notebook are intact and the warning is gone", (await page("window.__wb.items.size")) === boardBefore && !(await banner()).shown && !(await banner()).reconnect, JSON.stringify(await banner()));
// a second, short failure in the same lesson
await page("window.__closed = true; __opts.onDisconnect({ reason: 'error', message: 'network' }); true"); await sleep(900);
check("a second failure is reported again", (await banner()).reconnect, JSON.stringify(await banner()));
const diag = await page("(() => { const h = window.__health; h.sample(performance.now()); return { samples: h.samples.length, text: JSON.stringify(h.samples.at(-1)) }; })()");
check("diagnostics: numbers only (no speech or keys) are kept in a bounded ring", diag.samples >= 1 && diag.samples <= 240 && !/sk-|Can you explain/.test(diag.text), diag.text.slice(0, 200));
console.log("\n" + (results.every(Boolean) ? "ALL CHECKS PASSED" : results.filter((r) => !r).length + " check(s) FAILED"));
process.exit(results.every(Boolean) ? 0 : 1);
