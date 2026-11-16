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
const turnsByText = [...fixtures.all.flatMap((l) => l.turns), elephantTurn];
const service = { delayMs: 0, plannerStatus: 200, planner: [], classic: [] }; // what the page asked for is logged here

const elevenLabsStub = `export const Conversation = { async startSession(opts){ window.__opts = opts;
  setTimeout(() => opts.onConnect && opts.onConnect({}), 0);
  return { endSession: async () => { opts.onDisconnect && opts.onDisconnect({ reason: "user" }); }, sendUserMessage(){}, sendUserActivity(){} }; } };`;

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
  return { status: 200, type: "text/event-stream", text: sse((turn ? turn.ops : []).map((o) => JSON.stringify(o)).join("\n") + "\n") };
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
async function load(boardStyle) {
  await send("Page.navigate", { url: pageUrl });
  await waitFor(() => page("document.readyState === 'complete'"), "page load");
  await page(`localStorage.setItem('ttl-agent','agent_test'); localStorage.setItem('ttl-akey','sk-test'); localStorage.setItem('ttl-board','${boardStyle}'); true`);
  await send("Page.reload");
  await sleep(300);
  await waitFor(() => page("document.readyState === 'complete' && !!window.Whiteboard && !!window.WhiteboardCore && !!window.WhiteboardHand && !!document.getElementById('call')"), "scripts loaded");
  // Run the pen at 2x so the whole test is shorter. The page itself is untouched.
  await page("(() => { const Original = window.Whiteboard; window.Whiteboard = class extends Original { constructor(host, options) { super(host, { ...options, timeScale: 2 }); } }; return true; })()");
  await page("document.getElementById('call').click(); true");
  await waitFor(() => page("!!window.__opts"), "stub conversation started");
}
const count = () => page("document.querySelectorAll('#wbBoard [data-wb-id]').length");
const has = (id) => page(`!!document.querySelector('#wbBoard [data-wb-id="${id}"]')`);
const visible = (id) => page(`!document.getElementById('${id}').hidden`);
const badge = () => page("document.getElementById('boardBadge').textContent");
const status = () => page("document.getElementById('status').textContent");
const events = (kind) => page(`window.__whiteboardLog.filter((e) => e.kind === ${JSON.stringify(kind)}).map((e) => e.message)`);
const speak = (text) => page(`__opts.onModeChange({ mode: 'speaking' }); __opts.onMessage({ source: 'ai', message: ${JSON.stringify(text)} }); true`);
const hear = (text) => page(`__opts.onMessage({ source: 'user', message: ${JSON.stringify(text)} }); true`);
/** Strokes of handwriting on the animated board: finished, being drawn, or waiting; and the pencil's opacity. */
const strokeState = () => page(`(() => { const ps = [...document.querySelectorAll('#wbBoard [data-wb-hand] path')]; let done = 0, partial = 0, waiting = 0;
  for (const p of ps) { if (p.style.visibility === 'hidden') waiting++; else if (p.style.strokeDashoffset === '' || parseFloat(p.style.strokeDashoffset) === 0) done++; else partial++; }
  const pen = document.querySelector('#wbBoard [data-wb-pencil]'); return { total: ps.length, done, partial, waiting, pencil: pen ? +pen.style.opacity : 0 }; })()`);
/** Wait until nothing on the board has changed for a while (drawing finished). */
async function settled(quietMs = 2500, maxMs = 150000) {
  const start = Date.now(); let lastKey = null, since = Date.now();
  for (;;) {
    const st = await strokeState(), key = JSON.stringify([await count(), st.done, st.partial, st.waiting]);
    if (key !== lastKey) { lastKey = key; since = Date.now(); }
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
  console.log("      (first stroke visible " + firstStroke + " ms after the teacher message, including the 250 ms debounce; the fake Claude answers instantly)");

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
  check("interruption stops the remaining drawing", later === afterInterrupt && later < beforeBiology + biology.turns[0].ops.length, `${beforeBiology} -> ${afterInterrupt} -> ${later}`);
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

  // 5. Changing the subject: the model asks to clear, then draws new content
  await speak(topic.turns[0].teacher);
  await waitFor(() => has("nucleus"), "new subject drawn", 90000);
  await settled();
  check("old subject is gone", !(await has("curve")) && !(await has("title")) && !(await has("chloroplast")));
  check("new subject is on the board", (await Promise.all(["title2", "cell", "nucleus", "nlabel"].map(has))).every(Boolean));

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
  check("animated board stayed on screen and kept earlier drawing", (await visible("wbBoard")) && (await count()) > keptItems && (await has("nucleus")));
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
  check("animated board returns on the next good plan, with its earlier content", (await has("nucleus")) && (await has("curve")));
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

  check("no uncaught errors in the page", pageErrors.length === 0, pageErrors.join(" | "));
} catch (error) {
  failures++; console.log("FAIL  test run aborted  -> " + (error.stack || error));
  console.log("page errors so far: " + JSON.stringify(pageErrors));
  console.log("last whiteboard log: " + JSON.stringify(await page("window.__whiteboardLog.slice(-8)").catch(() => null)));
  console.log("board state: " + JSON.stringify(await page("({ ids: [...document.querySelectorAll('#wbBoard [data-wb-id]')].map((e) => e.dataset.wbId), hidden: document.hidden, wbHidden: document.getElementById('wbBoard').hidden })").catch(() => null)) + " strokes " + JSON.stringify(await strokeState().catch(() => null)));
}
console.log(failures ? "\n" + failures + " check(s) FAILED" : "\nALL CHECKS PASSED");
cleanup();
process.exit(failures ? 1 : 0);
