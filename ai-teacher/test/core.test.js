// Run with: node --test ai-teacher/test/core.test.js
// No dependencies: uses Node's built-in test runner.
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../whiteboard-core.js");
const fixtures = require("./fixtures.js");

/* ---------- expression parser ---------- */

test("expressions: arithmetic, precedence and implicit multiplication", () => {
  const f = (src, x) => core.compileExpression(src)(x);
  assert.equal(f("x^2 - 3x + 1", 2), -1);
  assert.equal(f("2x^2", 3), 18);          // 2*(x^2), not (2x)^2
  assert.equal(f("-x^2", 3), -9);          // -(x^2)
  assert.equal(f("2^-1", 0), 0.5);
  assert.equal(f("3(x+1)", 1), 6);
  assert.equal(f("2 sin(x)", Math.PI / 2), 2);
  assert.equal(f("y = x + 1", 1), 2);      // leading "y =" is allowed
  assert.equal(f("f(x) = x * 2", 4), 8);
  assert.ok(Math.abs(f("e^x", 1) - Math.E) < 1e-12);
  assert.ok(Math.abs(f("sqrt(x)", 16) - 4) < 1e-12);
  assert.ok(Number.isNaN(f("sqrt(x)", -1)));
  assert.equal(f("1/x", 0), Infinity);
});

test("expressions: anything that is not plain maths is rejected", () => {
  for (const bad of ["", "x;y", "alert(1)", "Math.sin(x)", "constructor", "__proto__", "x.y", "this", "process.exit()", "sin x", "x2", "(x", "x +", "'a'", "x".repeat(81), "a+b"]) {
    assert.throws(() => core.compileExpression(bad), undefined, "should reject " + JSON.stringify(bad));
  }
});

/* ---------- validator ---------- */

/** Validate a lesson turn by turn the way the board does: each turn sees what earlier turns created. */
function validateLesson(lesson) {
  const context = { ids: [], graphs: [], groups: {}, pages: ["p1"] };
  const allOps = [];
  for (const turn of lesson.turns) {
    const { ops, errors } = core.validatePlan({ ops: turn.ops }, { ids: [...context.ids], graphs: [...context.graphs], groups: { ...context.groups }, pages: [...context.pages] });
    assert.deepEqual(errors, [], lesson.subject + ": " + errors.join("; "));
    assert.equal(ops.length, turn.ops.length, lesson.subject + " lost steps");
    for (const op of ops) {
      if (op.id) context.ids.push(op.id);
      if (op.op === "graph") context.graphs.push(op.id);
      if (op.op === "group") context.groups[op.id] = { w: op.w, h: op.h };
      if (op.op === "new_page") context.pages.push("p" + (context.pages.length + 1));
    }
    allOps.push(...ops);
  }
  return allOps;
}

test("fixtures: every simulated lesson validates with no errors, across turns", () => {
  for (const lesson of [...fixtures.all, fixtures.sentences, fixtures.longLesson(12)]) validateLesson(lesson);
});

test("fixtures: every cue really occurs in the teacher's words for its turn (so it can be matched)", () => {
  for (const lesson of [...fixtures.all, fixtures.revisit, fixtures.sentences, fixtures.longLesson(12)]) {
    for (const turn of lesson.turns) for (const op of turn.ops) {
      if (!op.cue) continue;
      assert.ok(core.locateCue(turn.teacher, op.cue), `${lesson.subject}: cue "${op.cue}" is not in "${turn.teacher}"`);
    }
  }
});

test("validator: Claude does not choose positions: x, y and w are dropped for ordinary steps", () => {
  const { ops } = core.validatePlan({ ops: [
    { op: "write", content: "far", x: 900, y: 500, w: 300, id: "a" },
    { op: "graph", id: "g", x: 700, y: 400, w: 440, h: 320 },
    { op: "shape", shape: "arrow", points: [[10, 10], [50, 50]], x: 5, id: "s" },
  ] });
  assert.equal(ops[0].x, undefined); assert.equal(ops[0].y, undefined); assert.equal(ops[0].w, undefined);
  assert.equal(ops[1].x, undefined); assert.equal(ops[1].y, undefined);
  assert.equal(ops[1].w, 440);
  assert.deepEqual(ops[2].points, [[10, 10], [50, 50]]);
});

test("validator: diagram groups give local coordinates, clamped to the frame", () => {
  const { ops, errors } = core.validatePlan({ ops: [
    { op: "group", id: "d", w: 300, h: 200 },
    { op: "write", group: "d", content: "label", x: 9999, y: -5, id: "l" },
    { op: "shape", group: "d", shape: "circle", x: 500, y: 100, r: 30, id: "c" },
    { op: "shape", group: "d", shape: "arrow", points: [[0, 0], [900, 900]], id: "ar" },
    { op: "write", group: "nope", content: "x", id: "bad" },
  ] });
  assert.equal(ops[1].x, 300); assert.equal(ops[1].y, 0);
  assert.equal(ops[2].x, 300);
  assert.deepEqual(ops[3].points[1], [300, 200]);
  assert.equal(ops.length, 4);
  assert.ok(errors[0].includes("group does not exist"));
  assert.equal(core.validatePlan({ ops: [{ op: "group", id: "g" }] }).ops.length, 0, "a group needs a size");
});

test("validator: layout hints (near/side/calc) are kept only when valid", () => {
  const ctx = { ids: ["g"] };
  const { ops } = core.validatePlan({ ops: [
    { op: "write", content: "a", near: "g", side: "below", calc: "solve", id: "a" },
    { op: "write", content: "b", near: "missing", side: "right", id: "b" },
    { op: "write", content: "c", near: "g", side: "diagonal", id: "c" },
  ] }, ctx);
  assert.deepEqual([ops[0].near, ops[0].side, ops[0].calc], ["g", "below", "solve"]);
  assert.equal(ops[1].near, undefined);
  assert.equal(ops[2].side, "right");
});

test("validator: pages: new_page, go_to_page (ids and keywords), point_to, and clear becomes new_page", () => {
  const ctx = { ids: ["eq"], pages: ["p1", "p2"] };
  const { ops, errors } = core.validatePlan({ ops: [
    { op: "new_page", title: "Cells" },
    { op: "clear" },
    { op: "go_to_page", page: "p1" }, { op: "go_to_page", page: "latest" }, { op: "go_to_page", page: 2 }, { op: "go_to_page", page: "p9" },
    { op: "point_to", target: "eq" }, { op: "point_to", target: "ghost" }, { op: "point_to", target: "eq", return: false },
  ] }, ctx);
  assert.deepEqual(ops.map((o) => o.op), ["new_page", "new_page", "go_to_page", "go_to_page", "go_to_page", "point_to", "point_to"]);
  assert.equal(ops[0].title, "Cells");
  assert.deepEqual(ops.filter((o) => o.op === "go_to_page").map((o) => o.page), ["p1", "latest", "p2"]);
  assert.equal(ops[5].return, true); assert.equal(ops[6].return, false);
  assert.equal(errors.length, 2);
});

test("validator: HTML and script text stays inert text, unknown fields are dropped", () => {
  const { ops, errors } = core.validatePlan({ ops: [{ op: "write", content: "<img src=x onerror=alert(1)>", onclick: "evil()", style: "x", id: "a" }] });
  assert.equal(errors.length, 0);
  assert.equal(ops[0].content, "<img src=x onerror=alert(1)>"); // kept as a string; the renderer only ever draws it as strokes
  assert.deepEqual(Object.keys(ops[0]).sort(), ["color", "content", "id", "kind", "op", "size"]);
});

test("validator: bad operations are dropped one by one, good ones survive", () => {
  const { ops, errors } = core.validatePlan({ ops: [
    { op: "write", content: "kept" },
    { op: "explode" },
    { op: "plot", graph: "nope", fn: "x" },
    { op: "write", content: "" },
    { op: "shape", shape: "polygon", points: [[1, 1], [2, 2]] },
    { op: "write", content: "also kept" },
  ] });
  assert.deepEqual(ops.map((o) => o.content), ["kept", "also kept"]);
  assert.equal(errors.length, 4);
});

test("validator: unsafe function strings never reach the renderer", () => {
  const plan = { ops: [{ op: "graph", id: "g" }, { op: "plot", graph: "g", fn: "alert(1)" }, { op: "plot", graph: "g", fn: "x^2" }] };
  const { ops, errors } = core.validatePlan(plan);
  assert.deepEqual(ops.map((o) => o.op), ["graph", "plot"]);
  assert.equal(ops[1].fn, "x^2");
  assert.equal(errors.length, 1);
});

test("validator: sizes are clamped to the page and ids are checked", () => {
  const { ops } = core.validatePlan({ ops: [{ op: "graph", id: "g", w: 99999, h: 5 }, { op: "write", content: "bad id", id: "has space" }, { op: "pause", ms: 1e9 }] });
  assert.equal(ops[0].w, core.BOARD.width - 72); assert.equal(ops[0].h, 150);
  assert.equal(ops.length, 2);
  assert.equal(ops[1].ms, core.LIMITS.pauseMs);
});

test("validator: targets must exist; correct needs a write or shape and cannot nest", () => {
  const ctx = { ids: ["a"] };
  assert.equal(core.validatePlan({ ops: [{ op: "highlight", target: "zzz" }] }, ctx).ops.length, 0);
  assert.equal(core.validatePlan({ ops: [{ op: "highlight", target: "a" }] }, ctx).ops.length, 1);
  assert.equal(core.validatePlan({ ops: [{ op: "erase", target: "all" }] }, ctx).ops.length, 1);
  assert.equal(core.validatePlan({ ops: [{ op: "correct", target: "a", with: { op: "highlight", target: "a" } }] }, ctx).ops.length, 0);
  assert.equal(core.validatePlan({ ops: [{ op: "correct", target: "a", with: { op: "correct", target: "a", with: { op: "write", content: "x" } } }] }, ctx).ops.length, 0);
  assert.equal(core.validatePlan({ ops: [{ op: "correct", target: "a", with: { op: "write", content: "fixed" } }] }, ctx).ops.length, 1);
});

test("validator: size limits and malformed plans", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ op: "write", content: "n" + i }));
  const { ops, errors } = core.validatePlan({ ops: many });
  assert.equal(ops.length, core.LIMITS.opsPerPlan);
  assert.ok(errors[0].includes("Too many"));
  assert.equal(core.validatePlan(null).ops.length, 0);
  assert.equal(core.validatePlan({ ops: "nope" }).ops.length, 0);
  assert.equal(core.validatePlan({ ops: [{ op: "write", content: "x".repeat(500) }] }).ops[0].content.length, core.LIMITS.textLength);
});

test("validator: generated ids never collide with existing ones", () => {
  const { ops } = core.validatePlan({ ops: [{ op: "write", content: "a" }, { op: "write", content: "b" }] }, { ids: ["a1"] });
  assert.deepEqual(ops.map((o) => o.id), ["a2", "a3"]);
});

/* ---------- finding the cue in the teacher's words ---------- */

test("cues: located by whole words, ignoring case and punctuation", () => {
  const text = "A parabola is the curve you get from y equals x squared minus four. Let's draw it, then check the vertex.";
  assert.equal(core.locateCue(text, "y equals x squared").start, 37);
  assert.ok(core.locateCue(text, "LET'S DRAW IT"));
  assert.ok(core.locateCue(text, "the vertex"));
  assert.equal(core.locateCue(text, "the circle"), null);
  assert.equal(core.locateCue("another", "other"), null, "not inside a longer word");
  assert.equal(core.locateCue("the other the", "the").start, 0);
  assert.equal(core.locateCue(text, ""), null);
});

test("cues: a paraphrased ending still matches on its first words", () => {
  assert.ok(core.locateCue("We write the formula for area now", "the formula for the area of a triangle"), "first 3 words");
  assert.equal(core.locateCue("Hello there", "hello world"), null, "only one word in common: no match");
});

/* ---------- the speech clock: late, missing and out-of-order timing ---------- */

const TEXT = "First we look at the triangle. Then we mark the right angle. Finally we write the formula for the area.";

test("clock: without alignment, steps are released in the order and at the pace of the speech (estimate)", () => {
  const clock = new core.SpeechClock(); clock.setText(TEXT, 0); clock.start(1000);
  const at = (cue, t) => clock.evaluate(cue, t);
  const triangleDue = 1000 + clock.estimateMs("First we look at ") - clock.leadMs;
  assert.equal(at("the triangle", 1000).ready, false, "four words in: not due at the very start");
  assert.equal(at("the triangle", triangleDue + 5).ready, true);
  assert.equal(at("First we look", 1000).ready, true, "the very first words are due as the voice starts");
  assert.equal(at("mark the right angle", 1000).ready, false);
  assert.equal(at("the formula for the area", 1000).ready, false);
  const angleDue = 1000 + clock.estimateMs("First we look at the triangle. Then we ") - clock.leadMs;
  assert.equal(at("mark the right angle", angleDue - 50).ready, false);
  assert.equal(at("mark the right angle", angleDue + 5).ready, true);
  assert.equal(at("the formula for the area", angleDue + 5).ready, false, "the last idea is not drawn while the second is being said");
  assert.equal(at("the formula for the area", 1000 + 12000).ready, true);
});

test("clock: a step is never drawn before the teacher introduces it (no future concepts)", () => {
  const clock = new core.SpeechClock(); clock.setText(TEXT, 0); clock.start(0);
  for (let t = 0; t < 2000; t += 100) assert.equal(clock.evaluate("the formula for the area", t).ready, false, "at " + t);
});

test("clock: with alignment, a step is released when its words are played, not on the estimate", () => {
  const clock = new core.SpeechClock(); clock.setText(TEXT, 0); clock.start(0);
  clock.aligned("First we look at the triangle. ", null, 100);
  assert.equal(clock.evaluate("the triangle", 100).reason, "aligned");
  assert.equal(clock.evaluate("mark the right angle", 200).ready, false, "not spoken yet, and the estimate is held back by the grace period");
  clock.aligned("Then we mark the right angle. ", null, 3000);
  assert.deepEqual([clock.evaluate("mark the right angle", 3000).ready, clock.evaluate("mark the right angle", 3000).reason], [true, "aligned"]);
});

test("clock: per-character times release a step at the moment its first word starts inside a chunk", () => {
  const clock = new core.SpeechClock({ leadMs: 0 }); clock.setText("one two three four", 0); clock.start(0);
  const chunk = "one two three four", starts = Array.from(chunk).map((_, i) => i * 100); // 100 ms per character
  clock.aligned(chunk, starts, 1000);
  assert.equal(clock.evaluate("three four", 1000).ready, false);
  assert.equal(clock.evaluate("three four", 1000 + 8 * 100 - 1).ready, false);
  assert.equal(clock.evaluate("three four", 1000 + 8 * 100).ready, true, "'three' starts at character 8");
});

test("clock: LATE alignment (it starts after the estimate said the step was due) still releases the step", () => {
  const clock = new core.SpeechClock(); clock.setText(TEXT, 0); clock.start(0);
  assert.equal(clock.evaluate("mark the right angle", 20000).ready, true, "estimate alone releases it");
  const late = new core.SpeechClock(); late.setText(TEXT, 0); late.start(0);
  late.aligned("First we look at the triangle. ", null, 4000); // the voice is far behind the estimate
  assert.equal(late.evaluate("mark the right angle", 4500).ready, false, "grace period: trust the alignment, which says it is not yet said");
  assert.equal(late.evaluate("mark the right angle", 4000 + late.graceMs + 20000).ready, true, "but never wait for ever if the alignment goes quiet");
});

test("clock: MISSING alignment text (it never matches the cue) falls back to the estimate plus a grace period", () => {
  const clock = new core.SpeechClock(); clock.setText(TEXT, 0); clock.start(0);
  clock.aligned("Completely different spoken words. ", null, 100); // e.g. numbers spoken differently from the text
  const due = clock.estimateMs("First we look at the triangle. Then we ") - clock.leadMs;
  assert.equal(clock.evaluate("mark the right angle", due + 10).ready, false, "grace period applies when alignment is present but unmatched");
  assert.equal(clock.evaluate("mark the right angle", due + clock.graceMs + 10).ready, true);
});

test("clock: OUT-OF-ORDER cues: each step waits for its own words; one early step never holds back another", () => {
  const clock = new core.SpeechClock(); clock.setText(TEXT, 0); clock.start(0);
  const t = clock.estimateMs("First we look at the triangle. Then we ") + 50;
  const order = ["the formula for the area", "mark the right angle", "the triangle"].map((cue) => [cue, clock.evaluate(cue, t).ready]);
  assert.deepEqual(order, [["the formula for the area", false], ["mark the right angle", true], ["the triangle", true]]);
});

test("clock: no cue, a cue that is not in the text, or the end of the speech all release at once", () => {
  const clock = new core.SpeechClock(); clock.setText(TEXT, 0); clock.start(0);
  assert.equal(clock.evaluate("", 0).reason, "no-cue");
  assert.equal(clock.evaluate("something never said", 0).reason, "cue-not-found");
  assert.equal(clock.evaluate("the formula for the area", 0).ready, false);
  clock.end(500);
  assert.equal(clock.evaluate("the formula for the area", 600).reason, "speech-ended");
});

test("clock: text that arrives after the voice, or a voice that never reports starting, does not stall a step", () => {
  const lateText = new core.SpeechClock(); lateText.start(0);
  assert.equal(lateText.evaluate("the triangle", 10).reason, "cue-not-found", "no text yet: nothing to wait for");
  lateText.setText(TEXT, 2000);
  assert.equal(lateText.evaluate("mark the right angle", 2100).ready, false);
  assert.equal(lateText.evaluate("mark the right angle", 9000).ready, true);
  const noStart = new core.SpeechClock(); noStart.setText(TEXT, 0); // speaking-mode event never arrived
  assert.equal(noStart.evaluate("First we look", 0).ready, false, "waits a moment for the voice to start");
  assert.equal(noStart.evaluate("First we look", 900).ready, true, "then falls back to the moment the text arrived");
  assert.equal(noStart.evaluate("mark the right angle", 900).ready, false, "later phrases still wait their turn");
  assert.equal(noStart.evaluate("mark the right angle", 9000).ready, true);
});

test("clock: a new turn forgets the previous one", () => {
  const clock = new core.SpeechClock(); clock.setText(TEXT, 0); clock.start(0); clock.aligned("old words", null, 5); clock.end(10);
  clock.reset();
  assert.equal(clock.endedAt, null); assert.equal(clock.hasAlignment, false); assert.equal(clock.text, "");
});

/* ---------- the notebook as the planner sees it ---------- */

test("notebook summary: pages with titles, ids and a few words, and how full the live page is; no coordinates", () => {
  const text = core.summariseNotebook({ live: "p2", pages: [
    { id: "p1", title: "Parabolas", free: 0.3, items: [{ id: "eq", type: "math", text: "y = x^2 - 4" }, { id: "g", type: "graph", text: "x vs y" }] },
    { id: "p2", title: "Cells", free: 0.62, items: [] },
  ] });
  assert.ok(text.includes('p1 "Parabolas": eq math "y = x^2 - 4"; g graph "x vs y"'));
  assert.ok(text.includes('p2 "Cells" (live, about 62% free): empty'));
  assert.ok(!/@|\d+,\d+/.test(text.replace(/y = x\^2 - 4/, "")), "no positions");
  assert.ok(core.summariseNotebook({ pages: [] }).includes("empty notebook"));
});

test("notebook summary stays small even for a long lesson", () => {
  const pages = Array.from({ length: 12 }, (_, n) => ({ id: "p" + (n + 1), title: "Topic " + n, free: 0.2, items: Array.from({ length: 12 }, (_, i) => ({ id: `e${n}_${i}`, type: "text", text: "some words here" })) }));
  const text = core.summariseNotebook({ live: "p12", pages });
  assert.ok(text.length < 2800, "summary chars: " + text.length);
});

/* ---------- planner request/response (no network: fetch is faked) ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A fake Anthropic streaming response. `parts` are text pieces sent as text_delta events, `gapMs` apart. */
function fakeStream(parts, { gapMs = 0, onDone } = {}) {
  const encoder = new TextEncoder();
  const event = (obj) => encoder.encode("event: " + obj.type + "\ndata: " + JSON.stringify(obj) + "\n\n");
  let i = -1;
  const body = new ReadableStream({
    async pull(controller) {
      if (i === -1) { controller.enqueue(event({ type: "message_start", message: { usage: { input_tokens: 5 } } })); i = 0; return; }
      if (i >= parts.length) { controller.enqueue(event({ type: "message_delta", usage: { output_tokens: 9 } })); controller.enqueue(event({ type: "message_stop" })); controller.close(); if (onDone) onDone(); return; }
      if (gapMs) await sleep(gapMs);
      controller.enqueue(event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: parts[i++] } }));
    },
  });
  return { ok: true, status: 200, body };
}
const NOTEBOOK = { live: "p1", pages: [{ id: "p1", title: "", free: 1, items: [] }] };

test("planner: asks for a streamed answer with only the recent turns, the notebook summary and the teacher's own request", async () => {
  let sent;
  const fetchImpl = async (url, init) => { sent = { url, init, body: JSON.parse(init.body) }; return fakeStream([]); };
  const turns = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "teacher" : "student", text: "line " + i }));
  const notebook = { live: "p1", pages: [{ id: "p1", title: "Intro", free: 0.8, items: [{ id: "t1", type: "text", text: "old" }] }] };
  await core.planBoardStream({ apiKey: "k", turns, notebook, hint: "show the triangle", fetchImpl, model: "claude-haiku-5-5" });
  assert.equal(sent.url, "https://api.anthropic.com/v1/messages");
  assert.equal(sent.init.headers["x-api-key"], "k");
  assert.equal(sent.body.stream, true);
  assert.equal(sent.body.model, "claude-haiku-5-5", "the planner model is selectable");
  assert.equal(sent.body.tools, undefined, "plain streamed text, so steps arrive line by line");
  const prompt = sent.body.messages[0].content;
  assert.ok(prompt.includes("line 9") && prompt.includes("line 4") && !prompt.includes("line 3"), "only the last 6 turns are sent");
  assert.ok(prompt.includes('p1 "Intro" (live, about 80% free): t1 text "old"'));
  assert.ok(prompt.includes("show the triangle"));
  assert.ok(sent.body.max_tokens <= 1500, "bounded output");
});

test("planner: a continuation is told what is already on the board and only plans what comes after", async () => {
  let sent;
  await core.planBoardStream({ apiKey: "k", turns: [{ role: "teacher", text: "One. Two." }], notebook: NOTEBOOK, handled: "One.", fetchImpl: async (u, init) => { sent = JSON.parse(init.body); return fakeStream([]); } });
  assert.ok(sent.messages[0].content.includes('already on the board: "One."') && sent.messages[0].content.includes("Only plan what comes after"));
});

test("planner: steps are delivered while the stream is still open, so drawing can start early", async () => {
  const lines = [
    { op: "write", kind: "text", content: "Photosynthesis", size: "title", id: "t", cue: "x" },
    { op: "shape", shape: "circle", x: 200, y: 300, r: 40, id: "sun" },
    { op: "write", kind: "math", content: "CO_2 + H_2O", id: "in" },
  ].map((o) => JSON.stringify(o) + "\n");
  let streamDone = false; const arrivals = [];
  const fetchImpl = async () => fakeStream(lines, { gapMs: 40, onDone: () => { streamDone = true; } });
  const result = await core.planBoardStream({ apiKey: "k", turns: [], notebook: NOTEBOOK, fetchImpl, onOps: (ops) => arrivals.push({ n: ops.length, done: streamDone, first: ops[0].op }) });
  assert.equal(arrivals.length, 3, "one delivery per step: " + JSON.stringify(arrivals));
  assert.equal(arrivals[0].done, false, "the first step arrived before the stream finished");
  assert.equal(result.ops.length, 3);
  assert.deepEqual(result.errors, []);
  assert.equal(result.usage.output_tokens, 9);
});

test("planner: a step split across network chunks is assembled; fences and chatter are ignored; bad steps are reported", async () => {
  const text = '```json\n{"op":"write","kind":"text","content":"Hel' + 'lo","id":"a"}\nSure, here you go!\n{"op":"explode"}\n{"op":"write","kind":"text","content":"last, no newline","id":"b"}';
  const pieces = []; for (let i = 0; i < text.length; i += 7) pieces.push(text.slice(i, i + 7));
  const delivered = [];
  const result = await core.planBoardStream({ apiKey: "k", turns: [], notebook: NOTEBOOK, fetchImpl: async () => fakeStream(pieces), onOps: (ops) => delivered.push(...ops) });
  assert.deepEqual(result.ops.map((o) => o.content), ["Hello", "last, no newline"]);
  assert.deepEqual(delivered.map((o) => o.content), ["Hello", "last, no newline"]);
  assert.equal(result.errors.length, 2, JSON.stringify(result.errors));
});

test("planner: steps are validated against the notebook, including earlier steps and groups in the same answer", async () => {
  const lines = [
    '{"op":"graph","id":"g","xmin":-3,"xmax":3,"ymin":-1,"ymax":9}', '{"op":"plot","graph":"g","fn":"x^2"}', '{"op":"plot","graph":"nope","fn":"x"}',
    '{"op":"highlight","target":"old"}', '{"op":"plot","graph":"g","fn":"alert(1)"}',
    '{"op":"group","id":"d","w":300,"h":200}', '{"op":"shape","group":"d","shape":"circle","x":50,"y":50,"r":20}', '{"op":"go_to_page","page":"p1"}', '{"op":"go_to_page","page":"p7"}',
  ].map((l) => l + "\n");
  const notebook = { live: "p1", pages: [{ id: "p1", title: "", free: 1, items: [{ id: "old", type: "text", text: "x" }] }] };
  const result = await core.planBoardStream({ apiKey: "k", turns: [], notebook, fetchImpl: async () => fakeStream(lines) });
  assert.deepEqual(result.ops.map((o) => o.op), ["graph", "plot", "highlight", "group", "shape", "go_to_page"]);
  assert.equal(result.errors.length, 3);
});

test("planner: more steps than allowed are cut off", async () => {
  const lines = Array.from({ length: 30 }, (_, i) => JSON.stringify({ op: "write", content: "n" + i }) + "\n");
  const result = await core.planBoardStream({ apiKey: "k", turns: [], notebook: NOTEBOOK, fetchImpl: async () => fakeStream(lines) });
  assert.equal(result.ops.length, core.LIMITS.opsPerPlan);
  assert.ok(result.errors.some((e) => e.includes("Too many")));
});

test("planner: an empty answer means nothing to draw", async () => {
  const result = await core.planBoardStream({ apiKey: "k", turns: [], notebook: NOTEBOOK, fetchImpl: async () => fakeStream(["   \n"]) });
  assert.deepEqual(result.ops, []);
  assert.deepEqual(result.errors, []);
});

test("planner: HTTP errors throw with the status so the page can fall back (and say why)", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, body: null, json: async () => ({}) });
  await assert.rejects(core.planBoardStream({ apiKey: "bad", turns: [], notebook: NOTEBOOK, fetchImpl }), (error) => error.status === 401);
});

test("planner: an error event in the middle of the stream throws", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({ start(c) { c.enqueue(encoder.encode('data: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n')); c.close(); } });
  await assert.rejects(core.planBoardStream({ apiKey: "k", turns: [], notebook: NOTEBOOK, fetchImpl: async () => ({ ok: true, body }) }), (error) => error.status === 529);
});

test("planner: aborting stops the stream (no more tokens are paid for)", async () => {
  const controller = new AbortController();
  const fetchImpl = async (url, init) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({ async pull(c) { await sleep(20); if (init.signal.aborted) { c.error(new DOMException("aborted", "AbortError")); return; } c.enqueue(encoder.encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\n')); } });
    return { ok: true, body };
  };
  const promise = core.planBoardStream({ apiKey: "k", turns: [], notebook: NOTEBOOK, fetchImpl, signal: controller.signal });
  setTimeout(() => controller.abort(), 60);
  await assert.rejects(promise, (error) => error.name === "AbortError");
});

test("planner: if streaming is unavailable the whole answer is still understood", async () => {
  const data = { content: [{ type: "text", text: '{"op":"write","content":"Hi"}\n{"op":"write","content":"There"}' }], usage: { output_tokens: 3 } };
  const result = await core.planBoardStream({ apiKey: "k", turns: [], notebook: NOTEBOOK, fetchImpl: async () => ({ ok: true, body: null, json: async () => data }) });
  assert.deepEqual(result.ops.map((o) => o.content), ["Hi", "There"]);
});

test("planner prompt: small cue-tied steps, no positions, pages, and every action documented", () => {
  const prompt = core.PLANNER_SYSTEM;
  for (const word of ["pen", "JSON", "cue", "SMALL", "never draw anything the teacher has not said yet".replace("never draw", "never draw"), "new_page", "go_to_page", "point_to", '"op":"group"', "calc", "near", "You never choose positions"]) assert.ok(prompt.includes(word), "mentions " + word);
  for (const op of ["write", "graph", "plot", "point", "shape", "highlight", "erase", "correct", "pause"]) assert.ok(prompt.includes('"op":"' + op + '"'), "documents " + op);
  assert.ok(prompt.length < 6000, "prompt stays small: " + prompt.length);
});

/* ---------- speech pacing helpers ---------- */

test("speech: cue matching ignores case and punctuation and needs whole words", () => {
  assert.ok(core.cueSpoken("Let's draw the Vertex, right here", "the vertex"));
  assert.ok(!core.cueSpoken("the vertices are", "the vertex"));
  assert.ok(core.cueSpoken("anything", ""));
  assert.ok(!core.cueSpoken("not yet", "plus and minus two"));
});

test("speech: duration estimate and axis ticks", () => {
  assert.equal(core.estimateSpeechMs(""), 0);
  assert.equal(core.estimateSpeechMs("one two three four five six"), Math.round((6 / 2.6) * 1000));
  assert.deepEqual(core.niceTicks(-4, 4, 8), [-4, -3, -2, -1, 0, 1, 2, 3, 4]);
  assert.deepEqual(core.niceTicks(0, 100, 5), [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(core.niceTicks(1, 1, 5), []);
});

/* ---------- a turn planned in two parts: the second part waits for the first, then flows ---------- */

test("ordered delivery: steps of a continuation are held until the first part is done, then released in order", async () => {
  let release; const first = new Promise((r) => { release = r; });
  const delivered = [];
  const ordered = core.createOrderedDelivery(first, (ops) => delivered.push(...ops.map((o) => o.id)), () => false);
  ordered.push([{ id: "b1" }]); ordered.push([{ id: "b2" }]);
  await sleep(10);
  assert.deepEqual(delivered, [], "nothing is drawn while the first part is still running");
  assert.equal(ordered.pending(), 2);
  release(); await ordered.whenReleased();
  assert.deepEqual(delivered, ["b1", "b2"], "held steps come out in order");
});

test("ordered delivery: after the first part is done, each step is delivered the moment it arrives (not when the stream ends)", async () => {
  const delivered = [];
  const ordered = core.createOrderedDelivery(Promise.resolve(), (ops) => delivered.push(ops[0].id), () => false);
  await ordered.whenReleased();
  ordered.push([{ id: "c1" }]); assert.deepEqual(delivered, ["c1"], "delivered synchronously on arrival");
  ordered.push([{ id: "c2" }]); assert.deepEqual(delivered, ["c1", "c2"]);
});

test("ordered delivery: a step that arrives while the first part runs is delivered as soon as the first part ends, even if the stream is still open", async () => {
  let release; const first = new Promise((r) => { release = r; }); const delivered = [];
  const ordered = core.createOrderedDelivery(first, (ops) => delivered.push(ops[0].id), () => false);
  ordered.push([{ id: "d1" }]);          // arrives early: held
  release(); await sleep(5);              // the first part finishes while the continuation's stream is still going
  assert.deepEqual(delivered, ["d1"], "released at once when the first part ends");
  ordered.push([{ id: "d2" }]);          // and later steps flow straight through
  assert.deepEqual(delivered, ["d1", "d2"]);
});

test("ordered delivery: once the student has interrupted, nothing is delivered (held or new)", async () => {
  let release, stale = false; const first = new Promise((r) => { release = r; }); const delivered = [];
  const ordered = core.createOrderedDelivery(first, (ops) => delivered.push(ops[0].id), () => stale);
  ordered.push([{ id: "e1" }]); stale = true; release(); await ordered.whenReleased(); ordered.push([{ id: "e2" }]);
  assert.deepEqual(delivered, []);
});
