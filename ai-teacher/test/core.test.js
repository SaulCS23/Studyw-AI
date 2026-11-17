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
      if (op.op === "diagram") for (const part of op.parts) context.ids.push(part.id);
      if (op.op === "new_page") context.pages.push("p" + (context.pages.length + 1));
    }
    allOps.push(...ops);
  }
  return allOps;
}

test("fixtures: every simulated lesson validates with no errors, across turns", () => {
  for (const lesson of [...fixtures.all, fixtures.sentences, fixtures.longLesson(12), fixtures.speakOnly, fixtures.writeWhileSaying, fixtures.question, fixtures.questionAfterDrawing, fixtures.longDiagrams(8)]) validateLesson(lesson);
});

test("fixtures: every cue really occurs in the teacher's words for its turn (so it can be matched)", () => {
  for (const lesson of [...fixtures.all, fixtures.revisit, fixtures.sentences, fixtures.longLesson(12), fixtures.speakOnly, fixtures.writeWhileSaying, fixtures.graphWithReference, fixtures.pointAndExplain, fixtures.question, fixtures.questionAfterDrawing, fixtures.longDiagrams(8)]) {
    for (const turn of lesson.turns) for (const op of turn.ops) {
      for (const phrase of [op.cue, op.ref, ...(op.parts || []).flatMap((part) => [part.cue, part.ref])]) {
        if (!phrase) continue;
        assert.ok(core.locateCue(turn.teacher, phrase), `${lesson.subject}: "${phrase}" is not in "${turn.teacher}"`);
      }
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

test("planner prompt: teaching moments, cues, references, diagrams as nodes and links, pages, and every action documented", () => {
  const prompt = core.PLANNER_SYSTEM;
  for (const word of ["pen", "JSON", "speak only", "wait", "NEVER its answer", "cue", "ref", "Never let the teacher refer to something your steps do not draw", "new_page", "go_to_page", "point_to", '"op":"diagram"', "calc", "near", "You never choose positions or sizes", "SMALL"]) assert.ok(prompt.includes(word), "mentions " + word);
  for (const op of ["write", "graph", "plot", "point", "diagram", "highlight", "erase", "correct", "pause", "moment"]) assert.ok(prompt.includes('"op":"' + op + '"'), "documents " + op);
  assert.ok(!prompt.includes('"op":"group"') && !prompt.includes("coordinates inside"), "raw coordinate groups are no longer taught");
  assert.ok(prompt.length < 6500, "prompt stays small: " + prompt.length);
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

/* ---------- teaching moments, diagrams and references ---------- */

test("moment: the five teaching moments are accepted, anything else is rejected", () => {
  const { ops, errors } = core.validatePlan({ ops: ["speak_only", "write", "draw", "point", "wait"].map((kind) => ({ op: "moment", kind, note: "x" })).concat([{ op: "moment", kind: "dance" }]) });
  assert.deepEqual(ops.map((o) => o.kind), ["speak_only", "write", "draw", "point", "wait"]);
  assert.equal(errors.length, 1);
});

test("ref: the words where the teacher refers to a step are kept next to its cue", () => {
  const { ops } = core.validatePlan({ ops: [{ op: "write", content: "x", cue: "the vertex", ref: "look at the vertex" }, { op: "write", content: "y", ref: "z".repeat(200) }] });
  assert.equal(ops[0].ref, "look at the vertex"); assert.equal(ops[0].cue, "the vertex");
  assert.ok(ops[1].ref.length <= core.LIMITS.cueLength);
});

test("diagram: nodes and links are validated, containers come before their children, and node ids can be pointed at", () => {
  const { ops, errors } = core.validatePlan({ ops: [{ op: "diagram", id: "d", title: "T", layout: "cycle", parts: [
    { node: "kid", label: "Nucleus", in: "box" }, { node: "box", label: "Cell", shape: "ellipse" }, { node: "out", label: "Wall", shape: "triangle" },
    { from: "box", to: "out", label: "protects", style: "arrow" }, { from: "box", to: "ghost" }, { from: "kid", to: "kid" },
    { node: "empty", label: "" }, { node: "kid", label: "duplicate" },
  ] }, { op: "highlight", target: "kid" }, { op: "point_to", target: "d-l1" }] });
  assert.equal(ops.length, 3, "the later highlight and point_to can name the diagram's nodes and links: " + errors.join(" | "));
  const d = ops[0];
  assert.equal(d.layout, "cycle");
  assert.deepEqual(d.parts.filter((p) => p.type === "node").map((p) => p.id), ["box", "kid", "out"], "container first, then what is inside it");
  assert.equal(d.parts.find((p) => p.id === "out").shape, "rounded", "an unknown shape becomes the default");
  assert.deepEqual(d.parts.filter((p) => p.type === "link").map((p) => p.id), ["d-l1"]);
  assert.ok(errors.some((e) => e.includes("not nodes of this diagram")) && errors.some((e) => e.includes("no label")) && errors.some((e) => e.includes("repeated")), errors.join(" | "));
});

test("diagram: a diagram without nodes, with too many nodes, or without parts is handled", () => {
  assert.equal(core.validatePlan({ ops: [{ op: "diagram", id: "d", parts: [{ from: "a", to: "b" }] }] }).ops.length, 0);
  assert.equal(core.validatePlan({ ops: [{ op: "diagram", id: "d" }] }).ops.length, 0);
  const many = Array.from({ length: 20 }, (_, i) => ({ node: "n" + i, label: "N" + i }));
  const { ops, errors } = core.validatePlan({ ops: [{ op: "diagram", id: "d", parts: many }] });
  assert.equal(ops[0].parts.filter((p) => p.type === "node").length, core.LIMITS.diagramNodes);
  assert.ok(errors.some((e) => e.includes("too many nodes")));
});

test("references: visual references and questions in the teacher's words are found", () => {
  assert.ok(core.findReferences("Let's draw it. Now look at the vertex, right here at the bottom.").some((r) => r.toLowerCase().startsWith("look at the vertex")));
  assert.ok(core.findReferences("Look at the point I just drew. It is the vertex.").some((r) => r.toLowerCase().includes("look at the point")));
  assert.ok(core.findReferences("As you can see, the curve rises.").includes("As you can see"));
  assert.ok(core.findReferences("Notice this point here.").length >= 1);
  assert.deepEqual(core.findReferences("Photosynthesis makes sugar from light. It is wonderful."), [], "ordinary explanation has no visual reference");
  assert.ok(core.findReferences("A. ".repeat(50) + "look at the first thing. look at the second thing. look at the third thing. look at the fourth thing. look at the fifth thing.").length <= 4, "at most four");
  assert.equal(core.endsWithQuestion("What happens when x is zero?"), true);
  assert.equal(core.endsWithQuestion("Here is a line. What is y when x is three?"), true);
  assert.equal(core.endsWithQuestion("Does it cross? Yes, at two."), false, "only the last sentence counts");
  assert.equal(core.endsWithQuestion("Great."), false);
});

test("planner message: references and questions are put in front of the planner", () => {
  const nb = { live: "p1", pages: [{ id: "p1", title: "", free: 1, items: [] }] };
  const ref = core.buildPlannerMessage([{ role: "teacher", text: "Look at the vertex right here." }], nb);
  assert.ok(ref.includes("Visual references") && ref.includes("Look at the vertex"), ref);
  const q = core.buildPlannerMessage([{ role: "teacher", text: "Here is a line. What is y when x is three?" }], nb);
  assert.ok(q.includes("ends with a question") && q.includes("never the answer") && q.includes("wait moment"));
  const plain = core.buildPlannerMessage([{ role: "teacher", text: "Plants make sugar." }], nb);
  assert.ok(!plain.includes("Visual references") && !plain.includes("ends with a question"));
});

test("clock + reference: a step the teacher will refer to is released EARLY, by however long it takes to draw", () => {
  const clock = new core.SpeechClock({ leadMs: 0 });
  const text = "Let's draw the parabola. Look at the vertex right here.";
  clock.setText(text, 0); clock.start(0);
  const refAt = clock.estimateMs("Let's draw the parabola. ");      // when "Look at the vertex" starts
  const drawMs = 1500;
  assert.equal(clock.evaluate(undefined, refAt - drawMs - 50, { ref: "Look at the vertex", refLeadMs: drawMs }).ready, false, "too early: it would be drawn long before it is mentioned");
  const released = clock.evaluate(undefined, refAt - drawMs + 10, { ref: "Look at the vertex", refLeadMs: drawMs });
  assert.deepEqual([released.ready, released.reason], [true, "ref:estimate"], "released exactly one drawing-time before the reference");
  assert.equal(clock.evaluate("right here", refAt - drawMs, {}).ready, false, "the cue alone would be later");
  // with a cue as well, the EARLIER of the two moments wins
  const both = clock.evaluate("right here", refAt - drawMs + 10, { ref: "Look at the vertex", refLeadMs: drawMs });
  assert.equal(both.ready, true);
});

test("clock + reference: if the reference phrase is not in the text, the cue alone decides", () => {
  const clock = new core.SpeechClock({ leadMs: 0 }); clock.setText("First we draw. Then we label it.", 0); clock.start(0);
  assert.equal(clock.evaluate("Then we label", 0, { ref: "something nobody said", refLeadMs: 1000 }).ready, false);
  assert.equal(clock.evaluate(undefined, 0, { ref: "something nobody said", refLeadMs: 1000 }).reason, "cue-not-found");
});

test("clock: timeOf says when a phrase is spoken (exact from alignment, estimated otherwise)", () => {
  const clock = new core.SpeechClock({ leadMs: 0 }); clock.setText("one two three four five six", 0); clock.start(1000);
  assert.equal(clock.timeOf("four five"), 1000 + clock.estimateMs("one two three "));
  assert.equal(clock.timeOf("nothing here"), null);
  const chars = Array.from("one two three four five six"); clock.aligned(chars.join(""), chars.map((_, i) => i * 50), 5000);
  assert.equal(clock.timeOf("four five"), 5000 + 14 * 50, "aligned: the exact moment the phrase starts");
});

test("clock: audio chunks that arrive OUT OF ORDER are put back in order by event id", () => {
  const clock = new core.SpeechClock({ leadMs: 0 }); clock.setText("First we look at the triangle. Then we mark the right angle.", 0); clock.start(0);
  clock.aligned("Then we mark the right angle.", null, 3000, 2);   // chunk 2 arrives first
  clock.aligned("First we look at the triangle. ", null, 3100, 1);  // chunk 1 arrives late
  assert.equal(clock.chars.join(""), "First we look at the triangle. Then we mark the right angle.", "the spoken text is in speaking order");
  assert.equal(clock.evaluate("mark the right angle", 3000).reason, "aligned");
  const noIds = new core.SpeechClock(); noIds.aligned("b ", null, 1); noIds.aligned("a ", null, 2);
  assert.equal(noIds.chars.join(""), "b a ", "without ids, arrival order is kept");
});

test("clock: a chunk that never arrives (a gap in the speech) falls back to the estimate for what was in it", () => {
  const clock = new core.SpeechClock({ leadMs: 0 }); clock.setText("First we look. Then the lost words. Finally we finish here.", 0); clock.start(0);
  clock.aligned("First we look. ", null, 100, 1); clock.aligned("Finally we finish here.", null, 4000, 3); // chunk 2 is missing
  assert.equal(clock.evaluate("the lost words", 3000).ready, false, "its words are not in the speech that arrived: wait for the estimate plus grace");
  assert.equal(clock.evaluate("the lost words", clock.estimateMs("First we look. Then ") + clock.graceMs + 5).ready, true, "and it is released then");
  assert.equal(clock.evaluate("Finally we finish", 4000).reason, "aligned");
});

/* ---------- review findings: ids, containers, links, early plans ---------- */

test("diagram ids: a node can never take over the id of another element or diagram (drawing it would delete that element)", () => {
  const first = core.validatePlan({ ops: [{ op: "diagram", id: "d1", parts: [{ node: "sun", label: "Sun" }, { node: "sea", label: "Sea" }, { from: "sun", to: "sea" }] }] });
  const second = core.validatePlan({ ops: [{ op: "write", content: "x", id: "note" }, { op: "diagram", id: "d2", parts: [{ node: "sun", label: "Sun again" }, { node: "note", label: "Note" }, { node: "d2", label: "Self" }, { from: "sun", to: "note" }] }] }, { ids: ["d1", "sun", "sea", "d1-l1"], owners: { sun: "d1", sea: "d1", "d1-l1": "d1" } });
  const d2 = second.ops.find((o) => o.op === "diagram"), ids = d2.parts.filter((p) => p.type === "node").map((p) => p.id);
  assert.ok(!ids.includes("sun") && !ids.includes("note") && !ids.includes("d2"), "renamed: " + ids);
  assert.equal(new Set([...ids, "d1", "sun", "sea", "note"]).size, ids.length + 4, "every id is new");
  const link = d2.parts.find((p) => p.type === "link");
  assert.deepEqual([link.from, link.to], [ids[0], ids[1]], "the link follows the renamed nodes");
  assert.ok(second.errors.some((e) => e.includes("already used by something else")));
  assert.equal(first.errors.length, 0);
});

test("diagram ids: replacing the SAME diagram keeps its own node ids", () => {
  const { ops, errors } = core.validatePlan({ ops: [{ op: "diagram", id: "d1", parts: [{ node: "sun", label: "Sun" }, { node: "sea", label: "Sea" }] }] }, { ids: ["d1", "sun", "sea"], owners: { sun: "d1", sea: "d1" } });
  assert.deepEqual(ops[0].parts.map((p) => p.id), ["sun", "sea"]);
  assert.deepEqual(errors, []);
});

test("diagram containers: a chain of three is ordered outermost first, and a loop of containers is broken instead of vanishing", () => {
  const chain = core.validatePlan({ ops: [{ op: "diagram", id: "d", parts: [{ node: "a", label: "A", in: "b" }, { node: "b", label: "B", in: "c" }, { node: "c", label: "C" }] }] }).ops[0];
  assert.deepEqual(chain.parts.map((p) => p.id), ["c", "b", "a"]);
  const loop = core.validatePlan({ ops: [{ op: "diagram", id: "d", parts: [{ node: "a", label: "A", in: "b" }, { node: "b", label: "B", in: "a" }] }] });
  assert.equal(loop.ops.length, 1);
  assert.equal(loop.ops[0].parts.filter((p) => !p.in).length >= 1, true, "at least one is top level, so both can be drawn");
  assert.ok(loop.errors.some((e) => e.includes("cannot contain each other")));
});

test("diagram links: a link whose node was dropped (no label) is dropped too and cannot be pointed at", () => {
  const { ops, errors } = core.validatePlan({ ops: [{ op: "diagram", id: "d", parts: [{ from: "a", to: "b" }, { node: "a", label: "A" }, { node: "b", label: "" }, { node: "c", label: "C" }] }, { op: "point_to", target: "d-l1" }] });
  assert.equal(ops.length, 1, errors.join(" | "));
  assert.deepEqual(ops[0].parts.map((p) => p.id), ["a", "c"]);
});

test("early plan: a question in the first sentence is not treated as the end of the turn", () => {
  const nb = { live: "p1", pages: [{ id: "p1", title: "", free: 1, items: [] }] };
  const turns = [{ role: "teacher", text: "Where will it land? It follows a curve." }];
  assert.ok(core.buildPlannerMessage([{ role: "teacher", text: "Where will it land?" }], nb).includes("ends with a question"), "a finished turn that ends with a question says so");
  assert.ok(!core.buildPlannerMessage([{ role: "teacher", text: "Where will it land?" }], nb, "", null, true).includes("ends with a question"), "but an early plan (partial turn) does not");
  assert.ok(!core.buildPlannerMessage(turns, nb).includes("ends with a question"), "the full turn does not end with a question");
});

/* ---------- pacing: pencil against voice, hints for planner and agent ---------- */

test("clock.wordsSince counts the words spoken since a phrase (from alignment, or estimated)", () => {
  const clock = new core.SpeechClock({ wordsPerSecond: 2 });
  clock.setText("Let's start with x cubed. Then sine of x.", 0); clock.start(0);
  assert.equal(clock.wordsSince("Let's start", 0), 0);
  assert.equal(clock.wordsSince("Let's start", 3000), 6, "estimated: 2 words a second for 3 s");
  const aligned = new core.SpeechClock(); const text = "one two three four", times = Array.from(text, (_, i) => i * 100);
  aligned.setText(text, 0); aligned.aligned(text, times, 1000, 1);
  assert.equal(aligned.wordsSince("two three", 1000 + 1400), 3, "two, three and four have all started by 1400 ms after the start");
  assert.equal(aligned.wordsSince("two three", 1000 + 500), 1, "only two has started 100 ms into the phrase");
  assert.equal(aligned.wordsSince("missing words", 5000), null);
});

test("clock: a long write step may start a little early (cueLeadMs), never before that", () => {
  const clock = new core.SpeechClock({ wordsPerSecond: 2, leadMs: 0 });
  clock.setText("Intro words here. Now the equation.", 0); clock.start(0);
  const at = clock.estimateMs("Intro words here. ");
  assert.equal(clock.evaluate("Now the equation", at - 600, {}).ready, false);
  assert.equal(clock.evaluate("Now the equation", at - 600, { cueLeadMs: 800 }).ready, true);
  assert.equal(clock.evaluate("Now the equation", at - 1000, { cueLeadMs: 800 }).ready, false);
});

test("pacingNote: tells the planner what the pencil really did, in both directions", () => {
  assert.equal(core.pacingNote(null), "");
  assert.equal(core.pacingNote({ steps: 0 }), "");
  const behind = core.pacingNote({ steps: 5, behind: 3, worstWordsAhead: 14, penRatio: 1.3 });
  assert.ok(behind.includes("run ahead of the pencil") && behind.includes("fewer and shorter") && behind.includes("1.3x"), behind);
  assert.ok(core.pacingNote({ steps: 4, behind: 0, worstWordsAhead: 0, penRatio: 1 }).includes("kept up"));
  const nb = { live: "p1", pages: [{ id: "p1", title: "", free: 1, items: [] }] };
  assert.ok(core.buildPlannerMessage([{ role: "teacher", text: "Hi there." }], nb, "", null, false, { steps: 5, behind: 3, worstWordsAhead: 14, penRatio: 1 }).includes("fewer and shorter"));
  assert.ok(!core.buildPlannerMessage([{ role: "teacher", text: "Hi there." }], nb).includes("Pacing:"), "no measurements, no pacing note");
});

test("planner prompt teaches one idea per step, the pen being slower than the voice, and verbal introductions", () => {
  for (const phrase of ["ONE idea per step", "A pen is slower than a voice", "introducing an example verbally", "never draw a step whose words the teacher has not reached"]) assert.ok(core.PLANNER_SYSTEM.includes(phrase), phrase);
});

test("agent notes: the board status lists what is written; the style note never claims to slow speech", () => {
  const nb = { live: "p1", pages: [{ id: "p1", title: "", free: 0.5, items: [{ id: "a", type: "write", text: "f(x) = x^3" }, { id: "b", type: "graph" }] }] };
  const status = core.boardStatusNote(nb, { steps: 3, behind: 2, worstWordsAhead: 3 });
  assert.ok(status.includes('"f(x) = x^3"') && status.includes("slower than you speak"), status);
  assert.ok(core.boardStatusNote({ live: "p1", pages: [{ id: "p1", items: [] }] }, null).includes("nothing written yet"));
  assert.ok(/one step at a time/i.test(core.TEACHING_STYLE_NOTE) && /do not slow your voice/i.test(core.TEACHING_STYLE_NOTE));
  assert.ok(!/pause (your|the) voice/i.test(core.TEACHING_STYLE_NOTE));
});

/* ---------- conversation latency timeline ---------- */

/** Play a student's utterance through the VAD (a score every 100 ms) and then the rest of a simulated turn. */
function simulateTurn(timer, t0, o) {
  const talkMs = o.talkMs || 2000;
  for (let t = 0; t <= talkMs; t += 100) timer.vad(0.9, t0 + t);
  for (let t = talkMs + 100; t <= talkMs + 600; t += 100) timer.vad(0.05, t0 + t);
  const stop = t0 + talkMs;
  if (o.transcriptMs != null) timer.mark("transcript", stop + o.transcriptMs);
  if (o.textMs != null) timer.mark("agentText", stop + o.textMs, "streamed text");
  if (o.chunkMs != null) timer.mark("audioChunk", stop + o.chunkMs);
  if (o.audibleMs != null) timer.mark("audible", stop + o.audibleMs, "alignment playback");
  return stop;
}

test("timeline: a normal turn is split into measured parts and the biggest is named", () => {
  const timer = new core.TurnTimer();
  simulateTurn(timer, 1000, { transcriptMs: 900, textMs: 1500, chunkMs: 1700, audibleMs: 1800 });
  const report = timer.report();
  const row = (key) => report.rows.find((r) => r.key === key);
  assert.equal(row("stopToAudible").ms, 1800);
  assert.equal(row("stopToTranscript").ms, 900);
  assert.equal(row("transcriptToText").ms, 600);
  assert.equal(row("transcriptToAudioChunk").ms, 800);
  assert.equal(row("chunkToAudible").ms, 100);
  assert.ok(report.verdict.text.includes("speech-to-text") && report.verdict.text.includes("900 ms"), report.verdict.text);
  assert.ok(report.unavailable.length === 2, "what the SDK does not expose is listed, not guessed");
});

test("timeline: slow transcription, a slow agent LLM and slow playback each point at the right part", () => {
  let timer = new core.TurnTimer(); simulateTurn(timer, 0, { transcriptMs: 3200, chunkMs: 3900, audibleMs: 4000 });
  assert.ok(timer.report().verdict.text.includes("speech-to-text"), "delayed transcription: " + timer.report().verdict.text);
  timer = new core.TurnTimer(); simulateTurn(timer, 0, { transcriptMs: 600, chunkMs: 4600, audibleMs: 4700 });
  assert.ok(timer.report().verdict.text.includes("LLM and voice generation"), "slow agent: " + timer.report().verdict.text);
  timer = new core.TurnTimer(); simulateTurn(timer, 0, { transcriptMs: 600, chunkMs: 1200, audibleMs: 3800 });
  assert.ok(timer.report().verdict.text.includes("playback"), "slow playback: " + timer.report().verdict.text);
});

test("timeline: an event the SDK does not give is unavailable, never guessed", () => {
  const timer = new core.TurnTimer();
  timer.mark("transcript", 1000); timer.mark("agentText", 1800); timer.mark("audible", 2400); // no voice-activity scores, no audio chunks (WebRTC)
  const report = timer.report(), row = (key) => report.rows.find((r) => r.key === key);
  assert.equal(row("stopToAudible").ms, null);
  assert.ok(row("stopToAudible").note.includes("voice-activity"));
  assert.equal(row("transcriptToAudioChunk").ms, null);
  assert.ok(report.verdict.text.includes("together"), "without chunk events the parts are reported together: " + report.verdict.text);
  assert.equal(row("transcriptToText").ms, 800);
});

test("timeline: typed messages count from the send; each audible reply closes a turn and the next speech opens a new one", () => {
  const timer = new core.TurnTimer();
  timer.mark("typed", 100); timer.mark("agentText", 900); timer.mark("audible", 1300);
  assert.equal(timer.report().rows[0].ms, 1200);
  simulateTurn(timer, 5000, { transcriptMs: 700, audibleMs: 1500 });
  simulateTurn(timer, 12000, { transcriptMs: 700, audibleMs: 1700 }); // a second spoken turn, even a barge-in over the teacher
  assert.equal(timer.turns.length, 3);
  assert.deepEqual(timer.turns.map((t) => t.kind), ["typed", "voice", "voice"]);
  assert.equal(timer.median("stopToAudible"), 1500);
});

test("timeline: planner and pencil rows, planner calls, and session updates sent in the waiting window are reported", () => {
  const timer = new core.TurnTimer();
  const stop = simulateTurn(timer, 0, { transcriptMs: 800, textMs: 1400, chunkMs: 1800, audibleMs: 1900 });
  timer.hint("board status", stop + 1200); // a context update sent while the teacher was being generated
  timer.mark("plannerRequest", stop + 1500); timer.count("plannerCalls"); timer.mark("plannerFirstOp", stop + 3300); timer.mark("penStart", stop + 4100);
  const report = timer.report(), row = (key) => report.rows.find((r) => r.key === key);
  assert.equal(row("textToPlannerRequest").ms, 100);
  assert.equal(row("plannerLatency").ms, 1800);
  assert.equal(row("audibleToPen").ms, 2200);
  assert.equal(report.plannerCalls, 1);
  assert.equal(report.verdict.competingHints, 1);
  assert.ok(report.verdict.text.includes("context update"));
});

test("timeline: the student speaking again within the hold time is one utterance, and a pause longer than it is not", () => {
  const timer = new core.TurnTimer({ vadHoldMs: 400 });
  for (let t = 0; t <= 1000; t += 100) timer.vad(0.9, t);
  for (let t = 1100; t <= 1300; t += 100) timer.vad(0.1, t); // a 300 ms breath: still speaking
  for (let t = 1400; t <= 2000; t += 100) timer.vad(0.9, t);
  for (let t = 2100; t <= 2700; t += 100) timer.vad(0.1, t);
  assert.equal(timer.current.marks.studentStart, 0);
  assert.equal(timer.current.marks.studentStop, 2000, "the stop is the last voiced moment");
});

test("timeline: the exact playback event replaces the speaking-mode guess once, and later sentences do not change it", () => {
  const timer = new core.TurnTimer();
  simulateTurn(timer, 0, { transcriptMs: 500 });
  timer.audible(2900, "speaking mode"); timer.audible(3050, "audio playback event"); timer.audible(9000, "audio playback event");
  assert.equal(timer.current.marks.audible, 3050);
  assert.equal(timer.current.detail.audible, "audio playback event");
});

test("worthPlanning: acknowledgements are not sent to the planner; content, maths and short requests to show something are", () => {
  for (const ack of ["Great!", "Okay, go on.", "Good job.", "Yes, exactly.", "Got it.", "", "Thank you!"]) assert.equal(core.worthPlanning(ack), false, ack);
  for (const real of ["Now we write x squared.", "Two plus two is four.", "Well done, that is right today.", "Let's draw it.", "Here's the triangle.", "Yes, that is 4", "Look at the vertex."]) assert.equal(core.worthPlanning(real), true, real);
});

test("timeline: events that arrive out of order are unavailable, never negative, and a score that never falls does not stay 'speaking' for ever", () => {
  const timer = new core.TurnTimer();
  simulateTurn(timer, 0, { transcriptMs: 500 });
  timer.mark("audible", 1000); // before the student's stop (2000): out of order
  assert.equal(timer.report().rows.find((r) => r.key === "stopToAudible").ms, null);
  const echo = new core.TurnTimer();
  for (let t = 0; t <= 70000; t += 100) echo.vad(0.9, t); // the teacher's own voice leaking into the microphone
  assert.equal(echo.speaking, false, "after 60 s it is treated as stuck");
});

