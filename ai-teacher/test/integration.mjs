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

const [math, biology, history, topic] = fixtures.all;
const elephantTurn = { teacher: "Now look at the purple elephant over there.", ops: [{ op: "write", kind: "text", size: "body", content: "elephant", id: "el", cue: "purple elephant" }] };
const toolRequestOps = [{ op: "write", kind: "text", size: "title", content: "Triangles", id: "tri-title" }, { op: "shape", shape: "polygon", points: [[300, 420], [500, 220], [700, 420]], color: "blue", id: "tri" }, { op: "write", kind: "text", size: "small", content: "three sides", x: 420, y: 450, id: "tri-label" }];
const turnsByText = [...fixtures.all.flatMap((l) => l.turns), ...fixtures.revisit.turns, ...fixtures.sentences.turns, ...fixtures.speakOnly.turns, ...fixtures.graphWithReference.turns, ...fixtures.tangentLesson.turns, ...fixtures.pointAndExplain.turns, ...fixtures.question.turns, ...fixtures.questionAfterDrawing.turns, ...fixtures.missingReference.turns, ...fixtures.longLesson(10).turns, elephantTurn];
const service = { delayMs: 0, plannerStatus: 200, planner: [], classic: [] }; // what the page asked for is logged here

const elevenLabsStub = `export const Conversation = { async startSession(opts){ window.__opts = opts;
  setTimeout(() => opts.onConnect && opts.onConnect({}), 0);
  return { endSession: async () => { opts.onDisconnect && opts.onDisconnect({ reason: "user" }); }, sendUserMessage(){}, sendUserActivity(){}, sendContextualUpdate(t){ (window.__updates = window.__updates || []).push(t); } }; } };`;

/** The text of a streamed Anthropic reply: server-sent events carrying text deltas. */
function sse(text) {
  const ev = (obj) => "event: " + obj.type + "\ndata: " + JSON.stringify(obj) + "\n\n";
  const pieces = text.match(/[\s\S]{1,40}/g) || [];
  return ev({ type: "message_start", message: { usage: { input_tokens: 800 } } }) + ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
    + pieces.map((p) => ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } })).join("")
    + ev({ type: "message_delta", usage: { output_tokens: Math.ceil(text.length / 4) } }) + ev({ type: "message_stop" });
}

async function answerAnthropic(requestBody) {
  const body = JSON.parse(requestBody || "{}");
  if (service.delayMs) await sleep(service.delayMs);
  if (!body.stream) { service.classic.push(body); return { status: 200, type: "application/json", text: JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "<h2>Classic sketch</h2><p>fallback board</p>" }] }) }; }
  service.planner.push(body);
  if (service.plannerStatus !== 200) return { status: service.plannerStatus, type: "application/json", text: JSON.stringify({ error: { message: "stub error" } }) };
  const prompt = body.messages[0].content;
  if (prompt.includes("asked for this to be shown")) return { status: 200, type: "text/event-stream", text: sse(toolRequestOps.map((o) => JSON.stringify(o)).join("\n") + "\n") };
  const spoken = [...prompt.matchAll(/^Teacher: (.*)$/gm)].pop()?.[1] || "";
  // If consecutive teacher messages were merged into one transcript line, answer for the one spoken last.
  const turn = turnsByText.map((t) => ({ t, at: spoken.lastIndexOf(t.teacher.slice(0, 30)) })).filter((m) => m.at >= 0).sort((a, b) => b.at - a.at)[0]?.t;
  let steps = turn ? turn.ops : [];
  // A turn planned in two parts: the first request sees only the first sentence, the continuation only what is left.
  if (turn === fixtures.sentences.turns[0]) { if (prompt.includes("Only plan what comes after")) steps = steps.slice(1); else if (!spoken.includes("Then we mark")) steps = steps.slice(0, 1); }
  return { status: 200, type: "text/event-stream", text: sse(steps.map((o) => JSON.stringify(o)).join("\n") + "\n") };
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

/* ---------- helpers ---------- */

const page = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
async function waitFor(check, label, ms = 25000) {
  const start = Date.now();
  for (;;) { const value = await check(); if (value) return value; if (Date.now() - start > ms) throw new Error("timed out waiting for: " + label); await sleep(100); }
}
async function load(boardStyle, plannerModel) {
  await send("Page.navigate", { url: pageUrl });
  await waitFor(() => page("document.readyState === 'complete'"), "page load");
  await page(`localStorage.setItem('ttl-agent','agent_test'); localStorage.setItem('ttl-akey','sk-test'); localStorage.setItem('ttl-board','${boardStyle}'); localStorage.setItem('ttl-wbmodel','${plannerModel || 'claude-sonnet-5-5'}'); true`);
  await send("Page.reload");
  await sleep(300);
  await waitFor(() => page("document.readyState === 'complete' && !!window.Whiteboard && !!window.WhiteboardCore && !!window.WhiteboardHand && !!document.getElementById('call')"), "scripts loaded");
  // Run the pen at 2x so the whole test is shorter. The page itself is untouched.
  await page("(() => { const Original = window.Whiteboard; window.Whiteboard = class extends Original { constructor(host, options) { super(host, { ...options, timeScale: 2 }); window.__wb = this; } }; return true; })()");
  await page("document.getElementById('call').click(); true");
  await waitFor(() => page("!!window.__opts"), "stub conversation started");
}
const count = () => page("document.querySelectorAll('#wbBoard [data-wb-id]').length");
const has = (id) => page(`!!document.querySelector('#wbBoard [data-wb-id="${id}"]')`);
const visible = (id) => page(`!document.getElementById('${id}').hidden`);
const badge = () => page("document.getElementById('boardBadge').textContent");
const status = () => page("document.getElementById('status').textContent");
const events = (kind) => page(`window.__whiteboardLog.filter((e) => e.kind === ${JSON.stringify(kind)}).map((e) => e.message)`);
// The way the SDK reports a teacher turn: the voice stops listening and starts speaking, and the text arrives.
const speak = (text) => page(`__opts.onModeChange({ mode: 'listening' }); __opts.onModeChange({ mode: 'speaking' }); __opts.onMessage({ source: 'ai', message: ${JSON.stringify(text)} }); true`);
const hear = (text) => page(`__opts.onMessage({ source: 'user', message: ${JSON.stringify(text)} }); true`);
/** Strokes of handwriting on the animated board: finished, being drawn, or waiting; and the pencil's opacity. */
const strokeState = () => page(`(() => { const ps = [...document.querySelectorAll('#wbBoard [data-wb-hand] path')]; let done = 0, partial = 0, waiting = 0;
  for (const p of ps) { if (p.style.visibility === 'hidden') waiting++; else if (p.style.strokeDashoffset === '' || parseFloat(p.style.strokeDashoffset) === 0) done++; else partial++; }
  const pen = document.querySelector('#wbBoard [data-wb-pencil]'); return { total: ps.length, done, partial, waiting, pencil: pen ? +pen.style.opacity : 0 }; })()`);
const info = () => page("document.getElementById('pageInfo').textContent");
const pageButtons = () => page("[...document.querySelectorAll('#pageList .pg')].map((b) => ({ n: b.textContent, current: b.getAttribute('aria-current') === 'page', live: b.classList.contains('live'), unseen: b.classList.contains('unseen') }))");
const click = (id) => page(`document.getElementById('${id}').click(); true`);
const clickPage = (n) => page(`[...document.querySelectorAll('#pageList .pg')].find((b) => b.textContent === '${n}').click(); true`);
const returnVisible = () => page("!document.getElementById('pageLive').hidden");
const wbState = () => page("window.__wb.state()");
const pageOpacity = (n) => page(`document.querySelector('#wbBoard [data-wb-page="p${n}"]').style.opacity`);
/** Overlap and bounds, checked on the real page from the layout rectangles of every top-level element. */
const overlaps = () => page(`(() => { const out = []; for (const page of window.__wb.pages) { const top = [...page.ids].map((id) => window.__wb.items.get(id)).filter((i) => i && !i.parent && i.bbox);
  for (const i of top) if (i.bbox.x < 30 || i.bbox.y < 30 || i.bbox.x + i.bbox.w > 970 || i.bbox.y + i.bbox.h > 570) out.push(page.id + ': ' + i.id + ' leaves the page');
  for (let a = 0; a < top.length; a++) for (let b = a + 1; b < top.length; b++) { const p = top[a].bbox, q = top[b].bbox; if (!(p.x + p.w + 4 <= q.x || q.x + q.w + 4 <= p.x || p.y + p.h + 4 <= q.y || q.y + q.h + 4 <= p.y)) out.push(page.id + ': ' + top[a].id + ' overlaps ' + top[b].id); } } return out; })()`);
/** Wait until nothing on the board has changed for a while (drawing finished). */
async function settled(quietMs = 2500, maxMs = 150000) {
  const start = Date.now(); let lastKey = null, since = Date.now();
  for (;;) {
    const st = await strokeState(), key = JSON.stringify([await count(), st.done, st.partial, st.waiting]);
    // Steps may be waiting for their spoken cue, so a quiet board is not enough: the queue must be empty too.
    const busy = await page("!!(window.__wb && (window.__wb.running || window.__wb.queue.length))");
    if (key !== lastKey || busy) { lastKey = key; since = Date.now(); }
    if (Date.now() - since >= quietMs && st.partial === 0 && st.waiting === 0) return st;
    if (Date.now() - start > maxMs) throw new Error("drawing never settled: " + key);
    await sleep(150);
  }
}

// Optional: SHOT_DIR=/some/folder saves screenshots of the real page mid-drawing, for looking at.
const { writeFileSync } = await import("node:fs");
const shoot = async (name) => { if (!process.env.SHOT_DIR) return; const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(path.join(process.env.SHOT_DIR, name + ".png"), Buffer.from(r.data, "base64")); };

let failures = 0;
const check = (name, ok, detail) => { if (!ok) failures++; console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && detail !== undefined ? "  -> " + detail : "")); };

/* ---------- scenarios ---------- */

try {
  await load("animated");
  check("lesson starts; call button switches to End lesson", (await page("document.getElementById('callWord').textContent")) === "End lesson");
  check("badge says Animated and the classic welcome board is showing before the first plan", (await badge()).includes("Animated") && (await visible("board")) && !(await visible("wbBoard")));

  // 1. A teacher turn: subtitles at once, then the pen writes progressively
  const t0 = Date.now(); const planned = service.planner.length;
  await speak(math.turns[0].teacher);
  check("subtitles show the teacher's words immediately", (await page("document.getElementById('caption').textContent")) === math.turns[0].teacher);
  const samples = []; let sawPartial = false, sawPencil = false, firstStroke = null, maxPartialSeen = 0;
  await waitFor(async () => {
    const c = await count(); if (samples[samples.length - 1] !== c) samples.push(c);
    const st = await strokeState();
    if (st.done + st.partial > 0 && firstStroke === null) firstStroke = Date.now() - t0;
    if (st.partial > 0) { if (!sawPartial && (await count()) >= 2) await shoot("live_mid_write"); sawPartial = true; maxPartialSeen = Math.max(maxPartialSeen, st.partial); } if (st.pencil > 0) sawPencil = true;
    return c === math.turns[0].ops.length;
  }, "math board started", 90000);
  const st1 = await settled();
  await shoot("live_math_done");
  check("board drew progressively (saw partial counts, not one jump)", samples.length >= 3 && samples[0] < math.turns[0].ops.length, JSON.stringify(samples));
  check("a letter was caught half-written on the real page (a stroke part-drawn)", sawPartial);
  check("the pencil tip was visible while writing", sawPencil);
  check("everything is made of pen strokes and all strokes finished", st1.total >= 25 && st1.done === st1.total && st1.pencil === 0, JSON.stringify(st1));
  check("equations are NOT typed or typeset HTML", await page("!document.querySelector('#wbBoard foreignObject, #wbBoard .katex, #wbBoard text')"));
  check("planner was asked for a streamed answer with the transcript", service.planner.length === planned + 1 && service.planner.at(-1).stream === true && service.planner.at(-1).messages[0].content.includes("Teacher: " + math.turns[0].teacher));
  check("animated board replaced the classic one on screen", (await visible("wbBoard")) && (await page("document.getElementById('board').hidden")));
  check("curve was drawn from the expression", await has("curve"));
  check("badge shows the animated board", (await badge()).includes("Animated"), await badge());
  const log1 = await page("window.__whiteboardLog.map((e) => e.kind)");
  check("diagnostics logged each stage (turn, planning, first step, drawing)", ["turn", "planning", "first-step", "animated"].every((k) => log1.includes(k)), JSON.stringify(log1));
  console.log("      (first stroke visible " + firstStroke + " ms after the teacher message; the fake Claude answers instantly, so this is the board's own overhead)");

  // 2. Follow-up adds to the board and the planner is told what is already there
  await page("__opts.onModeChange({ mode: 'listening' }); true");
  await hear("Where does it cross the x axis?"); // a real conversation alternates teacher and student
  await speak(math.turns[1].teacher);
  await waitFor(async () => (await count()) === 6, "follow-up drawn", 90000);
  check("follow-up kept the existing content", (await Promise.all(["title", "eq", "g", "curve"].map(has))).every(Boolean));
  const secondPrompt = service.planner.at(-1).messages[0].content;
  check("planner sees what is already on the board", secondPrompt.includes("eq math") && secondPrompt.includes("g graph"), secondPrompt.slice(0, 200));
  await settled();

  // 3. The student interrupts mid-drawing
  await hear("Okay, now photosynthesis please.");
  await speak(biology.turns[0].teacher);
  const beforeBiology = await count();
  await waitFor(async () => (await count()) >= beforeBiology + 2, "biology started drawing", 90000);
  await page("__opts.onInterruption({ event_id: 1 }); true");
  await sleep(300);
  const afterInterrupt = await count(), stateAtInterrupt = await strokeState();
  await sleep(3500);
  const later = await count(), stateLater = await strokeState();
  check("interruption stops the remaining drawing", later === afterInterrupt && later < beforeBiology + 10, `${beforeBiology} -> ${afterInterrupt} -> ${later}`);
  check("what was already drawn stays on the board", (await Promise.all(["title", "eq", "g", "curve"].map(has))).every(Boolean));
  check("no stroke is left half-drawn and the pencil is put away", stateLater.partial === 0 && stateLater.pencil === 0 && stateLater.done === stateAtInterrupt.done, JSON.stringify({ stateAtInterrupt, stateLater }));

  // 4. The student speaks while the planner is still thinking: the stale plan is dropped and its request cancelled
  const before = await count();
  service.delayMs = 1500;
  await speak(history.turns[0].teacher);
  await sleep(500);
  await hear("Wait, can you go back to the parabola?");
  check("student words appear as subtitles", (await page("document.getElementById('caption').textContent")) === "You: Wait, can you go back to the parabola?" && (await page("document.getElementById('caption').classList.contains('you')")));
  await sleep(2500);
  check("plan that arrives after the student spoke is not drawn", (await count()) === before, `${before} -> ${await count()}`);
  check("the cancelled plan is reported in the log", (await events("planner")).some((m) => m.includes("cancelled")), JSON.stringify(await events("planner")));
  service.delayMs = 0;

  // 5. Changing the subject: a NEW PAGE, and the earlier pages are kept with their handwriting
  const pagesBeforeTopic = (await wbState()).pages.length;
  await speak(topic.turns[0].teacher);
  await waitFor(() => has("wall"), "new subject drawn", 90000);
  await settled();
  check("topic change: the old subject is still in the notebook, on its earlier page", (await has("curve")) && (await has("title")) && (await has("eq")) && (await has("btitle")) && (await has("photo"))); // biology was interrupted after its first two elements, so only those are guaranteed
  check("topic change: the new subject is on a new page of its own", (await Promise.all(["title2", "cellg", "cell", "nuc", "mito", "wall"].map(has))).every(Boolean) && (await wbState()).pages.length === pagesBeforeTopic + 1 && (await page("window.__wb.items.get('title2').page.number")) === pagesBeforeTopic + 1);
  check("topic change: the earlier page still shows its own writing", (await page("window.__wb.items.get('eq').page.number")) === 1 && (await page("window.__wb.pages[0].g.querySelectorAll('[data-wb-hand] path').length")) > 20);
  await shoot("live_cell_diagram");
  const nb = await pageButtons();
  check("notebook controls: appear with one numbered button per page, the live page marked and current", (await visible("notebook")) && nb.length === pagesBeforeTopic + 1 && nb.at(-1).live && nb.at(-1).current && !(await returnVisible()), JSON.stringify(nb));
  check("notebook controls: say which page it is", (await info()).startsWith("Page " + nb.length + " of " + nb.length) && (await info()).includes("(live)"), await info());

  // 6. Voice timing: with alignment events, a step waits for the words it belongs to
  await hear("Is anything else there?");
  await speak(elephantTurn.teacher);
  await page("__opts.onAudioAlignmentPlayback({ alignment: { chars: 'Now look at '.split('') } }); true");
  await sleep(2200);
  check("a step waits while its cue has not been spoken yet", !(await has("el")));
  await page("__opts.onAudioAlignmentPlayback({ alignment: { chars: 'the purple elephant'.split('') } }); true");
  await waitFor(() => has("el"), "step released by the voice cue", 15000);
  check("the step draws once the voice reaches its cue", await has("el"));
  await settled();

  // 6b. Student navigation: look at an earlier page while the teacher keeps speaking and writing
  const total = (await wbState()).pages.length;
  await click("pagePrev");
  check("student: Previous goes back one page and says where the teacher is", (await info()).startsWith("Page " + (total - 1) + " of " + total) && (await info()).includes("teacher is on page " + total), await info());
  check("student: Return to live page appears while looking at an older page", await returnVisible());
  await clickPage(1);
  check("student: a page button goes straight to that page; the older page is shown and the live page hidden", (await pageOpacity(1)) === "1" && (await pageOpacity(total)) === "0" && (await wbState()).followLive === false);
  await hear("Can you show me the triangle steps again?");
  await speak(fixtures.sentences.turns[0].teacher);
  await waitFor(() => has("s3"), "teacher kept writing on the live page", 90000);
  const dur = await wbState();
  check("student: the teacher kept writing on the live page while the student was reading page 1", dur.view === "p1" && dur.live !== "p1" && (await page("window.__wb.items.get('s3').page.id")) === dur.live);
  const nb2 = await pageButtons();
  check("student: the student stayed on page 1 (control is never taken away) and the live page is flagged as having new writing", nb2[0].current && !nb2.at(-1).current && nb2.at(-1).live && (nb2.at(-1).unseen || dur.pages.at(-1).unseen) && (await returnVisible()), JSON.stringify(nb2));
  await shoot("live_student_on_older_page");
  await settled();
  await click("pageLive");
  const back = await wbState();
  check("student: Return to live page goes to the teacher's page and follows again", back.view === back.live && back.followLive === true && !(await returnVisible()));
  const problems = await overlaps();
  check("every page so far: zero overlap and everything inside the page", problems.length === 0, problems.join(" | "));

  // 6c. The teacher goes back to an earlier page, points at the equation, and returns
  await hear("Wait, what was the first equation?");
  const livePageBefore = (await wbState()).live, itemsBefore = await count();
  let sawLiveOnP1 = false, sawRing = false, viewedP1 = false;
  const watcher = setInterval(async () => { try { const st = await page("({ live: window.__wb.state().live, view: window.__wb.state().view, ring: !!document.querySelector('#wbBoard [data-wb-pointer]') })"); if (st.live === "p1") sawLiveOnP1 = true; if (st.ring) { sawRing = true; if (st.view === "p1") viewedP1 = true; } } catch {} }, 40);
  await speak(fixtures.revisit.turns[0].teacher);
  await waitFor(async () => sawRing, "pointing", 60000);
  await settled(2500);
  clearInterval(watcher);
  check("revisit: the teacher went to page 1 and circled the equation there", sawLiveOnP1 && sawRing && viewedP1, JSON.stringify({ sawLiveOnP1, sawRing, viewedP1 }));
  check("revisit: afterwards the teacher is back on the page being written, and nothing was added or changed", (await wbState()).live === livePageBefore && (await count()) === itemsBefore && !(await page("!!document.querySelector('#wbBoard [data-wb-pointer]')")), `${(await wbState()).live} vs ${livePageBefore}; ${await count()} vs ${itemsBefore}`);
  check("revisit: the notebook marks exactly one live page", (await pageButtons()).filter((b) => b.live).length === 1);
  // The student, reading page 1 meanwhile, is not moved
  await hear("Okay. Let me look at page 1 myself.");
  await clickPage(1);
  const gatesBefore = await page("window.__wb.gates.length");
  await speak(fixtures.revisit.turns[0].teacher + " ");
  await waitFor(async () => (await page("window.__wb.gates.length")) > gatesBefore, "revisit planned again", 30000);
  await settled(3000);
  check("revisit: a student who is already reading page 1 stays there throughout", (await wbState()).view === "p1" && (await wbState()).followLive === false, JSON.stringify(await wbState()));
  await click("pageLive");

  // 6d. Planning in two parts when the agent streams its text (agent_chat_response_part), to start the pen earlier
  await hear("Show me how to find the area of a triangle.");
  const sentenceTurn = fixtures.sentences.turns[0], firstSentence = "First we look at the triangle. ";
  await page("['s1','s2','s3'].forEach((id) => window.__wb.items.has(id) && window.__wb.removeItem(id)); true");
  const requestsBefore = service.planner.length;
  await page("__opts.onModeChange({ mode: 'speaking' }); __opts.onAgentChatResponsePart({ type: 'start', text: '' }); __opts.onAgentChatResponsePart({ type: 'delta', text: " + JSON.stringify(firstSentence) + " }); true");
  await waitFor(() => has("s1"), "the first sentence is drawn before the reply is complete", 30000);
  check("early start: the pen started from the first streamed sentence, before the full reply existed", service.planner.length === requestsBefore + 1 && !(await has("s2")) && service.planner.at(-1).messages[0].content.includes("First we look at the triangle."), service.planner.at(-1).messages[0].content.slice(-200));
  check("early start: it says so in the log", (await events("turn")).some((m) => m.includes("Streaming text: planning from the first sentence")));
  await page("__opts.onMessage({ source: 'ai', message: " + JSON.stringify(sentenceTurn.teacher) + " }); true");
  await waitFor(() => has("s3"), "the rest is planned as a continuation", 60000);
  const continuation = service.planner.at(-1).messages[0].content;
  check("early start: the rest of the turn is planned as a continuation that knows what is already drawn", service.planner.length === requestsBefore + 2 && continuation.includes("Only plan what comes after") && continuation.includes("First we look at the triangle."), continuation.slice(-300));
  check("early start: steps are drawn in speaking order across the two plans (1, 2, 3)", (await page("[...window.__wb.items.keys()].filter((k) => /^s[123]$/.test(k)).join(',')")) === "s1,s2,s3");
  await settled(2500);

  // 6e. ElevenLabs alignment with per-character times: each step starts when its own words are played
  await hear("And the right angle?");
  await page("['s1','s2','s3'].forEach((id) => window.__wb.items.has(id) && window.__wb.removeItem(id)); __opts.onModeChange({ mode: 'listening' }); true");
  const alignedText = sentenceTurn.teacher, starts = Array.from(alignedText).map((_, i) => i * 40); // 40 ms per character
  await speak(alignedText);
  const t0a = Date.now();
  await page(`__opts.onAudioAlignmentPlayback({ alignment: { chars: ${JSON.stringify(Array.from(alignedText))}, char_start_times_ms: ${JSON.stringify(starts)} } }); true`);
  await sleep(150); const early = [await has("s1"), await has("s2"), await has("s3")];
  await sleep(Math.max(0, 1700 - (Date.now() - t0a))); const mid = [await has("s1"), await has("s2"), await has("s3")];
  await waitFor(() => has("s3"), "last step at its time", 20000); const lateAt = Date.now() - t0a;
  check("alignment times: nothing is drawn before its words, and the last step waits for the last sentence", !early[2] && !mid[2] && lateAt > 1800, JSON.stringify({ early, mid, lateAt }));
  check("alignment times: the second step was already drawn by the time the last sentence began", mid[1] === true, JSON.stringify(mid));
  const syncLog = await events("sync");
  check("alignment times: every released step is reported with its reason in the log", syncLog.length >= 3 && syncLog.some((m) => m.includes("aligned")), JSON.stringify(syncLog.slice(-3)));
  await settled(2500);

  // 6e2. Early plan and the final message arriving in the same instant: both plans must run (the second must not cancel the first)
  await hear("One more time, the triangle please.");
  await page("['s1','s2','s3'].forEach((id) => window.__wb.items.has(id) && window.__wb.removeItem(id)); __opts.onModeChange({ mode: 'listening' }); true");
  const reqBeforeTick = service.planner.length;
  await page("__opts.onModeChange({ mode: 'listening' }); __opts.onModeChange({ mode: 'speaking' }); __opts.onAgentChatResponsePart({ type: 'start', text: '' }); __opts.onAgentChatResponsePart({ type: 'delta', text: " + JSON.stringify(firstSentence) + " }); __opts.onMessage({ source: 'ai', message: " + JSON.stringify(sentenceTurn.teacher) + " }); true");
  await waitFor(() => has("s3"), "both parts drawn", 60000);
  check("same-instant early plan and final message: both plans ran and all three steps were drawn, in order", service.planner.length === reqBeforeTick + 2 && (await page("[...window.__wb.items.keys()].filter((k) => /^s[123]$/.test(k)).join(',')")) === "s1,s2,s3", `${service.planner.length - reqBeforeTick} requests`);
  await settled(2500);

  // 6e3. A teacher text that arrives long after its voice ended must not be taken for the start of the next turn
  await hear("Say something short.");
  await page("__opts.onModeChange({ mode: 'listening' }); __opts.onMessage({ source: 'ai', message: 'Late words that were never spoken aloud.' }); true");
  await sleep(4400);
  await page("['s1','s2','s3'].forEach((id) => window.__wb.items.has(id) && window.__wb.removeItem(id)); true");
  await speak(sentenceTurn.teacher);
  const freshClock = await page("({ text: window.__wb.clock.text, started: window.__wb.clock.startedAt !== null, ended: window.__wb.clock.endedAt !== null })");
  check("late text: the next turn starts with a fresh clock (its own text and its own voice start)", freshClock.text === sentenceTurn.teacher && freshClock.started && !freshClock.ended, JSON.stringify(freshClock));
  await sleep(300);
  check("late text: so the last sentence of the next turn is not drawn early", !(await has("s3")));
  await settled(2500);

  // 6e4. Keyboard focus survives the teacher writing (the page buttons are updated in place, not rebuilt)
  await page("document.querySelector('#pageList .pg').focus(); true");
  const focusBefore = await page("document.activeElement.textContent");
  await page("window.__wb.emit(); window.__wb.emit(); true");
  await hear("Anything else?"); // a real conversation alternates student and teacher (otherwise the page merges the two teacher turns)
  await page("document.querySelector('#pageList .pg').focus(); true");
  await speak("Now one more small thing.");
  await sleep(500);
  await settled(1500);
  check("page buttons keep keyboard focus while the teacher writes and the notebook changes", (await page("document.activeElement.className.includes('pg') && document.activeElement.textContent")) === focusBefore, await page("document.activeElement.tagName + ' ' + document.activeElement.textContent"));
  await page("document.activeElement.blur(); true");

  // 6f. A long lesson fills pages and starts new ones by itself
  await page("window.__wb.timeScale = 14; true");
  const pagesBeforeLong = (await wbState()).pages.length;
  const longTurns = fixtures.longLesson(10).turns;
  for (const turn of longTurns) { await hear("Tell me more."); await speak(turn.teacher); await waitFor(() => page(`window.__wb.items.has(${JSON.stringify(turn.ops[2].id)})`), "long lesson step " + turn.ops[2].id, 60000); await settled(600); await page("__opts.onModeChange({ mode: 'listening' }); true"); }
  await settled(2500);
  const afterLong = await wbState();
  check("long lesson: pages were created automatically as they filled", afterLong.pages.length >= pagesBeforeLong + 2, `${pagesBeforeLong} -> ${afterLong.pages.length}`);
  check("long lesson: the notebook lists every page and the student's view followed the teacher", (await pageButtons()).length === afterLong.pages.length && afterLong.view === afterLong.live, JSON.stringify(afterLong));
  const problemsLong = await overlaps();
  check("long lesson: zero overlap and everything inside the page, on every page, on the real page", problemsLong.length === 0, problemsLong.slice(0, 4).join(" | "));
  check("long lesson: every earlier page is still intact", (await has("eq")) && (await has("curve")) && (await has("lt0")) && (await has("lt" + (longTurns.length - 1))));
  await page("window.__wb.timeScale = 2; true");
  await shoot("live_notebook");

  // 6g. TEACHING MOMENTS on the real page: speak only, a question, a visual reference, and what the planner is told
  await page("window.__wb.timeScale = 2; true");
  // (a) A verbal introduction: nothing is drawn, the badge says so, and it is NOT treated as a failure (no classic fallback)
  await hear("Why do graphs matter?");
  const itemsBeforeSpeak = await count(), classicBeforeSpeak = service.classic.length, plannerBeforeSpeak = service.planner.length;
  await speak(fixtures.speakOnly.turns[0].teacher);
  await waitFor(() => service.planner.length > plannerBeforeSpeak, "planner asked", 10000);
  await waitFor(async () => (await badge()).includes("speaking only"), "speaking-only badge", 10000);
  check("speak only: the board is unchanged, the badge says the teacher is only speaking, and there is no classic fallback", (await count()) === itemsBeforeSpeak && service.classic.length === classicBeforeSpeak && !(await badge()).includes("fallback"), await badge());
  check("speak only: the planner is not asked to draw (the log says the teacher explains without drawing) and the moment is recorded", (await events("nothing")).some((m) => m.includes("explains without drawing")) && (await events("moment")).some((m) => m.includes("speak only")));
  // (b) A question to the student: nothing is drawn, the board waits
  await hear("I am not sure.");
  const itemsBeforeQ = await count(), plannerBeforeQ = service.planner.length;
  await speak(fixtures.question.turns[0].teacher);
  await waitFor(() => service.planner.length > plannerBeforeQ, "planner asked about the question", 10000);
  await waitFor(async () => (await badge()).includes("waiting for the student"), "waiting badge", 10000);
  const questionPrompt = service.planner.at(-1).messages[0].content;
  check("question: the board is unchanged, the badge says it is waiting for the student", (await count()) === itemsBeforeQ && (await badge()).includes("waiting for the student"), await badge());
  check("question: the planner was told the turn ends with a question and must not give the answer", questionPrompt.includes("ends with a question") && questionPrompt.includes("never the answer"));
  // (c) A visual reference: the planner is told, and the drawing is ready in time (measured on the real page)
  await hear("Can you show the parabola?");
  const refTurn = fixtures.graphWithReference.turns[0], plannerBeforeRef = service.planner.length;
  await speak(refTurn.teacher);
  await waitFor(() => service.planner.length > plannerBeforeRef, "planner asked about the graph", 10000);
  const refPrompt = service.planner.at(-1).messages[0].content;
  check("reference: the planner is told which of the teacher's words refer to something visible", refPrompt.includes("Visual references") && refPrompt.includes("look at the vertex"), refPrompt.slice(-400));
  await waitFor(() => has("pvertex"), "vertex drawn", 60000);
  await settled(3000);
  const refLogs = await events("sync");
  const refLine = refLogs.find((m) => m.includes('Reference "look at the vertex"'));
  check("reference: the page measured it, and the vertex was finished before the teacher said 'look at the vertex'", !!refLine && !refLine.includes("too late") && refLine.includes("before"), String(refLine) + " | " + JSON.stringify(refLogs.slice(-3)));
  check("reference: the graph, its curve and the labelled vertex are all there, and the pointer came with the words", (await Promise.all(["pg", "pcurve", "pvertex"].map(has))).every(Boolean) && (await page("window.__wb.timeline.some((t) => t.op === 'point_to')")));
  await shoot("live_reference_graph");
  const overlapsNow = await overlaps();
  check("reference: still zero overlap on every page", overlapsNow.length === 0, overlapsNow.join(" | "));
  // (d) The sync summary is reported, from measurements
  await page("__opts.onModeChange({ mode: 'listening' }); true");
  await sleep(1100);
  check("sync report: the page reports how the writing kept up (references checked, late ones counted)", (await events("sync")).some((m) => m.startsWith("Sync so far:") && m.includes("spoken references checked")), JSON.stringify((await events("sync")).slice(-2)));
  // (d2) Pencil measurements and session-only hints to the agent
  await waitFor(async () => (await page("(window.__updates || []).some((t) => t.startsWith('Board status:'))")), "board status sent to the agent", 15000);
  const updates = await page("window.__updates");
  check("hints: the teaching style was sent to the agent as a session message (not a setting) when the lesson started", /one step at a time/i.test(updates[0]) && /do not slow your voice/i.test(updates[0]), String(updates[0]).slice(0, 120));
  check("hints: after the pencil finished, the agent was told what is on the board", updates.some((t) => t.startsWith("Board status:") && t.includes("written so far")), JSON.stringify(updates.slice(-1)));
  check("pencil: the page reports the pencil's real writing time against the voice", (await events("pen")).some((m) => m.startsWith("Pencil so far:") && m.includes("steps written")), JSON.stringify((await events("pen")).slice(-1)));
  check("planner: later plans include what the pencil has actually done (pacing)", service.planner.at(-1).messages[0].content.includes("Pacing:"), service.planner.at(-1).messages[0].content.slice(-300));
  await page("document.getElementById('teachHints').value = 'off'; window.__updates.length = 0; true");
  await page("__opts.onModeChange({ mode: 'speaking' }); true"); await sleep(50); await page("__opts.onModeChange({ mode: 'listening' }); true");
  await sleep(2500);
  check("hints: switched off, nothing is sent to the agent", (await page("window.__updates.length")) === 0, String(await page("window.__updates.length")));
  await page("document.getElementById('teachHints').value = 'on'; true");
  // (e) Audio events arriving out of order (by event id) are put back in speaking order
  await hear("Say that again, slowly.");
  await speak(fixtures.sentences.turns[0].teacher);
  const sentenceChunks = ["First we look at the triangle. ", "Then we mark the right angle. ", "Finally we write the formula for the area."];
  await page(`__opts.onAudioAlignmentPlayback({ event_id: 3, alignment: { chars: ${JSON.stringify(Array.from(sentenceChunks[2]))} } }); __opts.onAudioAlignmentPlayback({ event_id: 1, alignment: { chars: ${JSON.stringify(Array.from(sentenceChunks[0]))} } }); __opts.onAudioAlignmentPlayback({ event_id: 2, alignment: { chars: ${JSON.stringify(Array.from(sentenceChunks[1]))} } }); true`);
  check("audio events out of order: the page puts them back in order", (await page("window.__wb.clock.chars.join('')")) === sentenceChunks.join(""), await page("window.__wb.clock.chars.join('')"));
  await settled(2500);

  // 6g2. THE SCREENSHOT LESSON on the real page: a tangent and a derivative planned in separate turns; real strokes are audited
  await page("window.__wb.timeScale = 6; true");
  for (const turn of fixtures.tangentLesson.turns) {
    await hear("Continue with the tangent."); const before = service.planner.length;
    await speak(turn.teacher); await waitFor(() => service.planner.length > before, "planner asked (tangent lesson)", 15000); await settled(1800);
  }
  const tangentAudit = await page("(() => { const r = window.__wb.audit(); return { problems: r.problems, checked: r.checked }; })()");
  check("tangent lesson on the real page: the orange tangent label, the blue derivative text and the vertex label are clear of axes, numbers, curves and each other (" + tangentAudit.checked + " strokes measured)", tangentAudit.problems.length === 0, tangentAudit.problems.slice(0, 4).join(" | "));
  await page("window.__wb.viewPage(window.__wb.pages.findIndex((p) => p.ids.has('tg')) + 1); true");
  await shoot("live_tangent_lesson");
  await sleep(600);
  check("tangent lesson: the page's own overlap check ran after drawing and found nothing to report", !(await events("engine")).some((m) => m.startsWith("Overlap check")), JSON.stringify((await events("engine")).filter((m) => m.startsWith("Overlap check")).slice(0, 2)));

  // 6h. CONVERSATION LATENCY INSTRUMENTATION on the real page, and: the whiteboard never blocks the voice conversation
  await page("document.getElementById('timing').open = true; true");
  const voiceUtterance = async (talkMs, transcriptDelayMs) => { // the student talks (voice-activity scores every 100 ms), stops, and the transcript arrives later
    for (let t = 0; t < talkMs; t += 100) { await page("__opts.onVadScore({ vadScore: 0.9 }); true"); await sleep(100); }
    for (let t = 0; t < 700; t += 100) { await page("__opts.onVadScore({ vadScore: 0.04 }); true"); await sleep(100); }
    await sleep(transcriptDelayMs);
  };
  const timing = () => page("(() => { const r = window.__timing.report(); return { rows: Object.fromEntries(r.rows.map((x) => [x.key, x.ms])), verdict: r.verdict.text, plannerCalls: r.plannerCalls, plannerSkipped: r.plannerSkipped, unavailable: r.unavailable.length }; })()");
  const turnText = fixtures.graphWithReference.turns[0].teacher;
  const alignmentOf = (text) => `__opts.onAudioAlignmentPlayback({ event_id: 1, alignment: { chars: ${JSON.stringify(Array.from(text))} } });`;
  // (a) a normal turn: every part is measured on the page's own clock, and what the SDK does not report is listed as unavailable
  await settled(1500);
  await voiceUtterance(800, 300);                                    // stops speaking, ~300 ms of waiting before the transcript below
  await page(`__opts.onMessage({ source: 'user', message: 'Can you show the parabola?' }); true`);
  await sleep(500);
  await page(`__opts.onAudio('AAAA'); true`); await sleep(100);       // first teacher audio data
  await speak(turnText); await sleep(120);                            // the speaking mode and the text
  await page(`${alignmentOf(turnText.slice(0, 30))} true`);           // the exact playback event
  await sleep(300);
  let t = await timing();
  check("latency (a): the stop of the student's speech is found from the voice-activity scores and the transcript delay is measured", t.rows.stopToTranscript >= 650 && t.rows.stopToTranscript <= 2000, JSON.stringify(t.rows) + " TURNS " + await page("JSON.stringify(window.__timing.turns.map((x) => [x.kind, x.marks]))"));
  check("latency (a): teacher text, first audio and audible are each timed from the transcript", t.rows.transcriptToText >= 400 && t.rows.transcriptToAudioChunk >= 400 && t.rows.chunkToAudible >= 0 && t.rows.stopToAudible > t.rows.stopToTranscript, JSON.stringify(t.rows));
  check("latency (a): the diagnostic names the largest measured part, and lists what the SDK does not report", t.verdict.startsWith("largest part") && t.unavailable === 2, t.verdict);
  const shown = await page("document.getElementById('timingBody').textContent");
  check("latency (a): the panel shows the numbers and 'unavailable' for what is not reported, and no speech text or key", shown.includes("ms") && shown.includes("Not reported by the SDK") && !shown.includes("parabola") && !shown.includes("sk-ant"), shown.slice(0, 300));
  // (b) a SLOW planner: the voice events are handled at once, and the planner's own delay is reported as the planner's
  await settled(2500);
  service.delayMs = 3000;
  await page("window.__wb.timeScale = 2; true");
  await voiceUtterance(500, 100);
  await page(`__opts.onMessage({ source: 'user', message: 'And the vertex?' }); true`);
  const plannerBefore = service.planner.length;
  await page(`__opts.onModeChange({ mode: 'listening' }); true`);
  const handlerMs = await page(`(() => { const t0 = performance.now(); __opts.onModeChange({ mode: 'speaking' }); __opts.onMessage({ source: 'ai', message: ${JSON.stringify(turnText)} }); __opts.onAudioAlignmentPlayback({ event_id: 1, alignment: { chars: ${JSON.stringify(Array.from(turnText.slice(0, 20)))} } }); return performance.now() - t0; })()`);
  check("never blocks the voice: the voice events are processed in a few milliseconds while the planner is still waiting", handlerMs < 60 && service.planner.length === plannerBefore, handlerMs + " ms");
  await sleep(600);
  t = await timing();
  check("slow planner: the voice is heard long before the planner answers (the planner is not on the voice's path)", t.rows.stopToAudible !== null && t.rows.stopToAudible < 2500, JSON.stringify(t.rows));
  await waitFor(() => service.planner.length > plannerBefore, "slow planner asked", 10000);
  await waitFor(async () => (await timing()).rows.plannerLatency !== null, "planner answer measured", 20000);
  t = await timing();
  check("slow planner: its own delay is measured as the planner's (about 3 s), separately from the voice", t.rows.plannerLatency >= 2800 && t.rows.plannerLatency < 9000, JSON.stringify(t.rows));
  service.delayMs = 0;
  // (c) a slow TRANSCRIPTION is blamed on speech-to-text and turn-taking, not on the whiteboard
  await settled(3000);
  await voiceUtterance(500, 2600);
  await page(`__opts.onMessage({ source: 'user', message: 'Why is it a parabola?' }); true`);
  await sleep(250); await page(`__opts.onAudio('AAAA'); true`); await sleep(100); await speak("Because the square makes both sides rise."); await page(`${alignmentOf("Because the square")} true`);
  t = await timing();
  check("slow transcription: the largest part is the stop-to-transcript delay, and it is not blamed on the whiteboard", t.verdict.includes("speech-to-text") && t.rows.stopToTranscript >= 3000, t.verdict + " " + JSON.stringify(t.rows));
  // (d) tiny acknowledgements get no planner call; an identical repeated message is not planned twice
  await settled(3000);
  let plannerCount = service.planner.length;
  await hear("Okay."); await speak("Great!"); await sleep(600);
  check("efficiency: a short acknowledgement is not sent to the planner", service.planner.length === plannerCount && (await timing()).plannerSkipped >= 1 && (await events("turn")).some((m) => m.includes("nothing to draw, so no planner call")), JSON.stringify(await timing()));
  const plannedBefore = service.planner.length; await hear("Show me the curve again."); await speak(turnText); await waitFor(() => service.planner.length > plannedBefore, "first plan requested", 15000); await sleep(600); plannerCount = service.planner.length; // (the first plan has been asked for; only a DUPLICATE could add another)
  await page(`__opts.onMessage({ source: 'ai', message: ${JSON.stringify(turnText)} }); true`); await sleep(500);
  check("efficiency: the same teacher message arriving twice is planned once", service.planner.length === plannerCount && (await events("turn")).some((m) => m.includes("arrived again")), String(service.planner.length - plannerCount));
  await settled(3000);

  // 7. THE AGENT'S show_on_board TOOL: in Animated mode its finished HTML must not appear at once.
  await hear("Can you show me a triangle?");
  const keptItems = await count(), planBefore = service.planner.length, classicBefore0 = service.classic.length;
  const toolReply = await page("__opts.clientTools.show_on_board({ content: '<h2>Triangles</h2><p>A triangle has three sides</p><svg viewBox=\"0 0 100 100\"><polygon points=\"10,90 50,10 90,90\"/></svg>' })");
  check("the tool still answers the agent", typeof toolReply === "string" && toolReply.length > 0);
  check("tool call is logged and says it is routed to the animated board", (await events("tool")).some((m) => m.includes("show_on_board") && m.includes("by hand")), JSON.stringify(await events("tool")));
  check("the agent's finished HTML is NOT painted on the classic board", !(await page("document.getElementById('board').textContent")).includes("A triangle has three sides"));
  // Silent tool call: the agent says nothing, so the safety timer starts the drawing after ~2.5 s.
  await waitFor(async () => service.planner.length > planBefore, "tool-triggered plan", 12000);
  check("the tool's request was passed to the planner (not drawn from HTML)", service.planner.at(-1).messages[0].content.includes("asked for this to be shown") && service.planner.at(-1).messages[0].content.includes("A triangle has three sides"), service.planner.at(-1).messages[0].content.slice(-300));
  await waitFor(() => has("tri"), "triangle drawn by hand", 60000);
  const stTool = await settled();
  await shoot("live_tool_done");
  check("the tool's content was written and drawn by the pen, stroke by stroke", (await has("tri-title")) && stTool.total > 10 && stTool.done === stTool.total, JSON.stringify(stTool));
  check("animated board stayed on screen and kept earlier drawing", (await visible("wbBoard")) && (await count()) > keptItems && (await has("wall")));
  check("no classic request was made for the tool call", service.classic.length === classicBefore0);

  // 7b. Tool call that arrives after this turn's drawing already started: the teacher's words keep driving it
  await hear("And now a different shape?");
  await speak(elephantTurn.teacher + " Really.");
  await sleep(700);
  await page("__opts.clientTools.show_on_board({ content: '<h2>Late tool</h2>' }); true");
  check("a tool call after the drawing started is noted and does not repaint", (await events("tool")).some((m) => m.includes("after this turn's drawing had already started")));
  await settled();

  // 8. Fallbacks are visible: console, status line and badge
  service.plannerStatus = 200; const classicBefore = service.classic.length;
  await hear("Can you fix the date?");
  await speak(history.turns[1].teacher); // refers to elements that are not on the board -> every step is rejected
  await waitFor(() => service.classic.length > classicBefore, "fallback to classic for unusable steps", 30000);
  await waitFor(() => page("document.getElementById('board').textContent.includes('Classic sketch')"), "classic board shown");
  await shoot("live_fallback");
  check("unusable steps fall back to the classic board, which is shown", (await visible("board")) && !(await visible("wbBoard")));
  check("fallback is visible in the badge", (await badge()).includes("Classic fallback"), await badge());
  check("fallback is visible in the status line", (await status()).toLowerCase().includes("classic fallback"), await status());
  check("fallback is visible in the console", consoleLines.some((l) => l.text.startsWith("[Whiteboard] Classic fallback")), JSON.stringify(consoleLines.slice(-4)));
  check("fallback is recorded in window.__whiteboardLog", (await events("fallback")).length >= 1);

  service.plannerStatus = 500; const classicBefore2 = service.classic.length;
  await hear("Tell me about volcanoes.");
  await speak("Let's try something else about volcanoes.");
  await waitFor(() => service.classic.length > classicBefore2, "fallback to classic after a failed planner call", 30000);
  check("a failing planner call falls back to the classic board and says why", (await badge()).includes("planner error 500") && (await events("fallback")).some((m) => m.includes("500")), await badge());

  service.plannerStatus = 401; const classicBefore3 = service.classic.length;
  await hear("And lava?");
  await speak("And one more thing about lava.");
  await waitFor(() => page("document.getElementById('status').textContent.includes('key')"), "key message");
  check("a rejected API key is reported (status and badge) and does not trigger the classic call", service.classic.length === classicBefore3 && (await badge()).toLowerCase().includes("key rejected"), await badge());

  service.plannerStatus = 200;
  await hear("Let's go back to parabolas.");
  await speak(math.turns[0].teacher);
  await waitFor(() => visible("wbBoard"), "animated board returns after a fallback", 30000);
  await waitFor(() => has("curve"), "new drawing finished", 90000);
  check("animated board returns on the next good plan, with its earlier content", (await has("wall")) && (await has("curve")));
  await settled();
  check("badge returns to Animated", (await badge()).includes("Animated"), await badge());

  // 9. Ending the lesson
  await page("document.getElementById('call').click(); true");
  check("lesson ends cleanly", (await waitFor(() => page("document.getElementById('callWord').textContent === 'Start lesson'"), "end lesson")) === true);

  // 10. Classic mode: the original whiteboard and the agent's tool work exactly as before
  service.planner.length = 0; service.classic.length = 0;
  await load("classic");
  check("Classic setting: badge says so", (await badge()).includes("Classic"), await badge());
  await speak(math.turns[0].teacher);
  await waitFor(() => service.classic.length > 0, "classic request", 8000);
  await waitFor(() => page("document.getElementById('board').textContent.includes('Classic sketch')"), "classic board shown");
  check("Classic setting: original whiteboard works as before, no animated calls", service.planner.length === 0 && (await page("document.getElementById('wbBoard').hidden")));
  await page("__opts.clientTools.show_on_board({ content: '<h2>Tool board</h2><p>from the agent</p>' }); true");
  check("Classic setting: the agent's show_on_board tool paints the classic board as before", (await page("document.getElementById('board').textContent")).includes("Tool board") && service.planner.length === 0);

  // 11. The planner model chosen in Setup is the one used
  service.planner.length = 0;
  await load("animated", "claude-haiku-5-5");
  await speak(math.turns[0].teacher);
  await waitFor(() => service.planner.length > 0, "planner request", 8000);
  check("Setup: the faster planner model (Haiku 5.5) is used when chosen", service.planner[0].model === "claude-haiku-5-5", service.planner[0].model);
  check("planner prompt includes the notebook summary", service.planner[0].messages[0].content.includes("Notebook:"));

  check("no uncaught errors in the page", pageErrors.length === 0, pageErrors.join(" | "));
} catch (error) {
  failures++; console.log("FAIL  test run aborted  -> " + (error.stack || error));
  console.log("page errors so far: " + JSON.stringify(pageErrors));
  console.log("last whiteboard log: " + JSON.stringify(await page("window.__whiteboardLog.slice(-8)").catch(() => null)));
  console.log("hidden strokes belong to: " + JSON.stringify(await page("[...document.querySelectorAll('#wbBoard [data-wb-hand] path')].filter((p) => p.style.visibility === 'hidden').map((p) => { const own = p.closest('[data-wb-id]'); return own && own.dataset.wbId + '@' + (own.closest('[data-wb-page]') || {}).dataset.wbPage + ' text=' + (window.__wb.items.get(own.dataset.wbId) || {}).text; })").catch(() => null)));
  console.log("board state: " + JSON.stringify(await page("({ ids: [...document.querySelectorAll('#wbBoard [data-wb-id]')].map((e) => e.dataset.wbId), hidden: document.hidden, wbHidden: document.getElementById('wbBoard').hidden })").catch(() => null)) + " strokes " + JSON.stringify(await strokeState().catch(() => null)));
}
console.log(failures ? "\n" + failures + " check(s) FAILED" : "\nALL CHECKS PASSED");
cleanup();
process.exit(failures ? 1 : 0);
