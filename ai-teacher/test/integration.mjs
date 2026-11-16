// End-to-end check of ai-teacher/index.html in real headless Chrome, with the two network services faked:
//   - the ElevenLabs SDK is replaced by a stub that lets this script fire the same events the SDK fires
//     (onMessage, onModeChange, onInterruption, onAudioAlignmentPlayback, client tools);
//   - api.anthropic.com is answered with canned planner responses from fixtures.js (or an error, to test the fallback).
// It proves the page's wiring, not ElevenLabs' or Claude's quality. It needs no npm packages.
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
const turnsByText = [...fixtures.all.flatMap((l) => l.turns), elephantTurn];
const service = { delayMs: 0, plannerStatus: 200, planner: [], classic: [] }; // what the page asked for is logged here

const elevenLabsStub = `export const Conversation = { async startSession(opts){ window.__opts = opts;
  setTimeout(() => opts.onConnect && opts.onConnect({}), 0);
  return { endSession: async () => { opts.onDisconnect && opts.onDisconnect({ reason: "user" }); }, sendUserMessage(){}, sendUserActivity(){} }; } };`;

async function answerAnthropic(requestBody) {
  const body = JSON.parse(requestBody || "{}");
  if (service.delayMs) await sleep(service.delayMs);
  if (!body.tools) { service.classic.push(body); return { status: 200, json: { stop_reason: "end_turn", content: [{ type: "text", text: "<h2>Classic sketch</h2><p>fallback board</p>" }] } }; }
  service.planner.push(body);
  if (service.plannerStatus !== 200) return { status: service.plannerStatus, json: { error: { message: "stub error" } } };
  const prompt = body.messages[0].content;
  const spoken = [...prompt.matchAll(/^Teacher: (.*)$/gm)].pop()?.[1] || "";
  // If consecutive teacher messages were merged into one transcript line, answer for the one spoken last.
  const turn = turnsByText.map((t) => ({ t, at: spoken.lastIndexOf(t.teacher.slice(0, 30)) })).filter((m) => m.at >= 0).sort((a, b) => b.at - a.at)[0]?.t;
  return { status: 200, json: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "update_whiteboard", input: { ops: turn ? turn.ops : [] } }] } };
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

let nextId = 0; const waiting = new Map(); const pageErrors = [];
socket.onmessage = async (message) => {
  const data = JSON.parse(message.data);
  if (data.id) { const w = waiting.get(data.id); waiting.delete(data.id); data.error ? w.reject(new Error(JSON.stringify(data.error))) : w.resolve(data.result); return; }
  if (data.method === "Fetch.requestPaused") return handlePaused(data.params);
  if (data.method === "Runtime.exceptionThrown") pageErrors.push(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text);
  if (data.method === "Runtime.consoleAPICalled" && data.params.type === "error") pageErrors.push("console.error: " + data.params.args.map((a) => a.value ?? a.description).join(" "));
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
    await fulfill(requestId, answer.status, "application/json", JSON.stringify(answer.json));
  } catch (error) { pageErrors.push("test harness: " + error.message); }
}

await send("Page.enable"); await send("Runtime.enable");
await send("Fetch.enable", { patterns: [{ urlPattern: "https://cdn.jsdelivr.net/npm/@elevenlabs/*" }, { urlPattern: "https://api.anthropic.com/*" }] });

/* ---------- helpers ---------- */

const page = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
async function waitFor(check, label, ms = 20000) {
  const start = Date.now();
  for (;;) { const value = await check(); if (value) return value; if (Date.now() - start > ms) throw new Error("timed out waiting for: " + label); await sleep(100); }
}
async function load(boardStyle) {
  await send("Page.navigate", { url: pageUrl });
  await waitFor(() => page("document.readyState === 'complete'"), "page load");
  await page(`localStorage.setItem('ttl-agent','agent_test'); localStorage.setItem('ttl-akey','sk-test'); localStorage.setItem('ttl-board','${boardStyle}'); true`);
  await send("Page.reload");
  await sleep(300);
  await waitFor(() => page("document.readyState === 'complete' && !!window.Whiteboard && !!window.WhiteboardCore && !!document.getElementById('call')"), "scripts loaded");
  await page("document.getElementById('call').click(); true");
  await waitFor(() => page("!!window.__opts"), "stub conversation started");
}
const count = () => page("document.querySelectorAll('#wbBoard [data-wb-id]').length");
const has = (id) => page(`!!document.querySelector('#wbBoard [data-wb-id="${id}"]')`);
const visible = (id) => page(`!document.getElementById('${id}').hidden`);
const speak = (text) => page(`__opts.onModeChange({ mode: 'speaking' }); __opts.onMessage({ source: 'ai', message: ${JSON.stringify(text)} }); true`);
const hear = (text) => page(`__opts.onMessage({ source: 'user', message: ${JSON.stringify(text)} }); true`);
const stable = async (ms = 1500) => { let last = await count(), since = Date.now(); while (Date.now() - since < ms) { await sleep(150); const now = await count(); if (now !== last) { last = now; since = Date.now(); } } return last; };

let failures = 0;
const check = (name, ok, detail) => { if (!ok) failures++; console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && detail !== undefined ? "  -> " + detail : "")); };

/* ---------- scenarios ---------- */

try {
  await load("animated");
  check("lesson starts; call button switches to End lesson", (await page("document.getElementById('callWord').textContent")) === "End lesson");
  check("animated board is hidden and classic welcome is shown before the first plan", (await visible("board")) && !(await visible("wbBoard")));

  // 1. A teacher turn: subtitles at once, then the board draws progressively
  const t0 = Date.now(); const planned = service.planner.length;
  await speak(math.turns[0].teacher);
  check("subtitles show the teacher's words immediately", (await page("document.getElementById('caption').textContent")) === math.turns[0].teacher);
  const samples = [];
  await waitFor(async () => { const c = await count(); if (samples[samples.length - 1] !== c) samples.push(c); return c === math.turns[0].ops.length; }, "math board drawn");
  check("board drew progressively (saw partial counts, not one jump)", samples.length >= 3 && samples[0] < math.turns[0].ops.length, JSON.stringify(samples));
  check("planner was called once, as a forced tool call with the transcript", service.planner.length === planned + 1 && service.planner.at(-1).tool_choice.name === "update_whiteboard" && service.planner.at(-1).messages[0].content.includes("Teacher: " + math.turns[0].teacher));
  check("animated board replaced the classic one on screen", (await visible("wbBoard")) && (await page("document.getElementById('board').hidden")));
  check("equation was typeset by KaTeX", await page("!!document.querySelector('#wbBoard .katex')"));
  check("curve was drawn from the expression", await has("curve"));
  console.log("      (first board fully drawn " + (Date.now() - t0) + " ms after the teacher turn began, including the 400 ms debounce; planner was instant here)");

  // 2. Follow-up adds to the board and the planner is told what is already there
  await page("__opts.onModeChange({ mode: 'listening' }); true");
  await hear("Where does it cross the x axis?"); // a real conversation alternates teacher and student
  await speak(math.turns[1].teacher);
  await waitFor(async () => (await count()) === 6, "follow-up drawn");
  check("follow-up kept the existing content", (await Promise.all(["title", "eq", "g", "curve"].map(has))).every(Boolean));
  const secondPrompt = service.planner.at(-1).messages[0].content;
  check("planner sees what is already on the board", secondPrompt.includes("eq math") && secondPrompt.includes("g graph"), secondPrompt.slice(0, 200));

  // 3. The student interrupts mid-drawing
  service.delayMs = 0;
  await speak(biology.turns[0].teacher);
  const beforeBiology = await count();
  await waitFor(async () => (await count()) >= beforeBiology + 3, "biology started drawing");
  const atInterrupt = await count();
  await page("__opts.onInterruption({ event_id: 1 }); true");
  await sleep(250);
  const afterInterrupt = await count();
  await sleep(3500);
  const later = await count();
  check("interruption stops the remaining drawing", later === afterInterrupt && later < beforeBiology + biology.turns[0].ops.length, `${atInterrupt} -> ${afterInterrupt} -> ${later}`);
  check("what was already drawn stays on the board", (await Promise.all(["title", "eq", "g", "curve"].map(has))).every(Boolean));
  check("no stroke is left half-drawn", await page("![...document.querySelectorAll('#wbBoard path')].some((p) => p.style.strokeDashoffset && p.style.strokeDashoffset !== '0')"));

  // 4. The student speaks while the planner is still thinking: the stale plan is dropped
  const before = await count();
  service.delayMs = 1500;
  await speak(history.turns[0].teacher);
  await sleep(500);
  await hear("Wait, can you go back to the parabola?");
  check("student words appear as subtitles", (await page("document.getElementById('caption').textContent")) === "You: Wait, can you go back to the parabola?" && (await page("document.getElementById('caption').classList.contains('you')")));
  await sleep(2500);
  check("plan that arrives after the student spoke is not drawn", (await count()) === before, `${before} -> ${await count()}`);
  service.delayMs = 0;

  // 5. Changing the subject: the model asks to clear, then draws new content
  await speak(topic.turns[0].teacher);
  await waitFor(() => has("nucleus"), "new subject drawn");
  await stable();
  check("old subject is gone", !(await has("curve")) && !(await has("title")) && !(await has("chloroplast")));
  check("new subject is on the board", (await Promise.all(["title2", "cell", "nucleus", "nlabel"].map(has))).every(Boolean));

  // 6. Voice timing: with alignment events, a step waits for the words it belongs to
  await speak(elephantTurn.teacher);
  await page("__opts.onAudioAlignmentPlayback({ alignment: { chars: 'Now look at '.split('') } }); true");
  await sleep(2200);
  check("a step waits while its cue has not been spoken yet", !(await has("el")));
  await page("__opts.onAudioAlignmentPlayback({ alignment: { chars: 'the purple elephant'.split('') } }); true");
  await waitFor(() => has("el"), "step released by the voice cue", 6000);
  check("the step draws once the voice reaches its cue", await has("el"));

  // 7. The agent's own show_on_board tool still works and uses the classic board, content on the animated board is kept
  const kept = await count();
  await page("__opts.clientTools.show_on_board({ content: '<h2>Tool board</h2><p>from the agent</p>' }); true");
  check("show_on_board shows the classic board", !(await page("document.getElementById('board').hidden")) && (await page("document.getElementById('wbBoard').hidden")) && (await page("document.getElementById('board').textContent")).includes("Tool board"));
  check("the animated drawing is kept underneath", (await count()) === kept);

  // 8. Fallbacks: instructions that can't be used, and a failing planner, fall back to the classic board
  service.plannerStatus = 200; const classicBefore = service.classic.length;
  await hear("Can you fix the date?");
  await speak(history.turns[1].teacher); // refers to elements that are not on the board -> every op is rejected
  await waitFor(() => service.classic.length > classicBefore, "fallback to classic for unusable instructions");
  await waitFor(() => page("document.getElementById('board').textContent.includes('Classic sketch')"), "classic board shown");
  check("unusable instructions fall back to the classic whiteboard", true);

  service.plannerStatus = 500; const classicBefore2 = service.classic.length;
  await hear("Tell me about volcanoes.");
  await speak("Let's try something else about volcanoes.");
  await waitFor(() => service.classic.length > classicBefore2, "fallback to classic after a failed planner call");
  check("a failing planner call falls back to the classic whiteboard", true);

  service.plannerStatus = 401; const classicBefore3 = service.classic.length;
  await hear("And lava?");
  await speak("And one more thing about lava.");
  await waitFor(() => page("document.getElementById('status').textContent.includes('key')"), "key message");
  check("a rejected API key is reported and does not trigger the classic call", service.classic.length === classicBefore3);

  service.plannerStatus = 200;
  await hear("Let's go back to parabolas.");
  await speak(math.turns[0].teacher);
  await waitFor(() => visible("wbBoard"), "animated board returns after a fallback");
  await waitFor(() => has("curve"), "new drawing finished");
  check("animated board returns on the next good plan, with its earlier content", (await has("nucleus")) && (await has("curve")));

  // 9. Ending the lesson
  await page("document.getElementById('call').click(); true");
  check("lesson ends cleanly", (await waitFor(() => page("document.getElementById('callWord').textContent === 'Start lesson'"), "end lesson")) === true);

  // 10. Classic mode makes no animated calls and shows no animated board
  service.planner.length = 0; service.classic.length = 0;
  await load("classic");
  await speak(math.turns[0].teacher);
  await waitFor(() => service.classic.length > 0, "classic request", 8000);
  await waitFor(() => page("document.getElementById('board').textContent.includes('Classic sketch')"), "classic board shown");
  check("Classic setting: original whiteboard works as before", service.planner.length === 0 && (await page("document.getElementById('wbBoard').hidden")));

  check("no uncaught errors in the page", pageErrors.length === 0, pageErrors.join(" | "));
} catch (error) {
  failures++; console.log("FAIL  test run aborted  -> " + (error.stack || error));
  console.log("page errors so far: " + JSON.stringify(pageErrors));
}
console.log(failures ? "\n" + failures + " check(s) FAILED" : "\nALL CHECKS PASSED");
cleanup();
process.exit(failures ? 1 : 0);
