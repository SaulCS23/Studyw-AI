// Run with: node --test ai-teacher/test/
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

test("fixtures: every simulated lesson validates with no errors, across turns", () => {
  for (const lesson of fixtures.all) {
    const ids = new Set(), graphs = new Set();
    for (const turn of lesson.turns) {
      const { ops, errors } = core.validatePlan({ ops: turn.ops }, { ids: [...ids], graphs: [...graphs] });
      assert.deepEqual(errors, [], lesson.subject + ": " + errors.join("; "));
      assert.equal(ops.length, turn.ops.length, lesson.subject + " lost ops");
      for (const op of ops) { if (op.id) ids.add(op.id); if (op.op === "graph") graphs.add(op.id); if (op.op === "clear") { ids.clear(); graphs.clear(); } }
    }
  }
});

test("validator: HTML and script text stays inert text, unknown fields are dropped", () => {
  const { ops, errors } = core.validatePlan({ ops: [{ op: "write", content: "<img src=x onerror=alert(1)>", onclick: "evil()", style: "x", id: "a" }] });
  assert.equal(errors.length, 0);
  assert.equal(ops[0].content, "<img src=x onerror=alert(1)>"); // kept as a string; the renderer only ever uses textContent
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

test("validator: numbers are clamped to the board and ids are checked", () => {
  const { ops } = core.validatePlan({ ops: [{ op: "write", content: "far", x: 99999, y: -50, w: 1e9, id: "far" }, { op: "write", content: "bad id", id: "has space" }, { op: "pause", ms: 1e9 }] });
  assert.equal(ops[0].x, core.BOARD.width - 20);
  assert.equal(ops[0].y, 0);
  assert.equal(ops[0].w, core.BOARD.width);
  assert.equal(ops.length, 2);
  assert.equal(ops[1].ms, core.LIMITS.pauseMs);
});

test("validator: targets must exist; correct needs a write or shape and cannot nest", () => {
  const ctx = { ids: ["a"] };
  assert.equal(core.validatePlan({ ops: [{ op: "highlight", target: "zzz" }] }, ctx).ops.length, 0);
  assert.equal(core.validatePlan({ ops: [{ op: "highlight", target: "a" }] }, ctx).ops.length, 1);
  assert.equal(core.validatePlan({ ops: [{ op: "erase", target: "all" }] }, ctx).ops.length, 1);
  assert.equal(core.validatePlan({ ops: [{ op: "correct", target: "a", with: { op: "clear" } }] }, ctx).ops.length, 0);
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

test("planner: asks for a streamed answer with only the recent turns, the board summary and the teacher's own request", async () => {
  let sent;
  const fetchImpl = async (url, init) => { sent = { url, init, body: JSON.parse(init.body) }; return fakeStream([]); };
  const turns = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "teacher" : "student", text: "line " + i }));
  await core.planBoardStream({ apiKey: "k", turns, boardItems: [{ id: "t1", type: "text", x: 1, y: 2, w: 3, h: 4, text: "old" }], nextSlot: { x: 40, y: 100 }, hint: "show the triangle", fetchImpl });
  assert.equal(sent.url, "https://api.anthropic.com/v1/messages");
  assert.equal(sent.init.headers["x-api-key"], "k");
  assert.equal(sent.body.stream, true);
  assert.equal(sent.body.model, core.PLANNER_MODEL);
  assert.equal(sent.body.tools, undefined, "plain streamed text, so steps arrive line by line");
  const prompt = sent.body.messages[0].content;
  assert.ok(prompt.includes("line 9") && prompt.includes("line 4") && !prompt.includes("line 3"), "only the last 6 turns are sent");
  assert.ok(prompt.includes("t1 text") && prompt.includes("x=40 y=100"));
  assert.ok(prompt.includes("show the triangle"));
  assert.ok(sent.body.max_tokens <= 1500, "bounded output");
});

test("planner: steps are delivered while the stream is still open, so drawing can start early", async () => {
  const lines = [
    { op: "write", kind: "text", content: "Photosynthesis", size: "title", id: "t" },
    { op: "shape", shape: "circle", x: 200, y: 300, r: 40, id: "sun" },
    { op: "write", kind: "math", content: "CO_2 + H_2O", id: "in" },
  ].map((o) => JSON.stringify(o) + "\n");
  let streamDone = false; const arrivals = [];
  const fetchImpl = async () => fakeStream(lines, { gapMs: 40, onDone: () => { streamDone = true; } });
  const result = await core.planBoardStream({ apiKey: "k", turns: [], boardItems: [], fetchImpl, onOps: (ops) => arrivals.push({ n: ops.length, done: streamDone, first: ops[0].op }) });
  assert.equal(arrivals.length, 3, "one delivery per step: " + JSON.stringify(arrivals));
  assert.equal(arrivals[0].done, false, "the first step arrived before the stream finished");
  assert.equal(arrivals[0].first, "write");
  assert.equal(result.ops.length, 3);
  assert.deepEqual(result.errors, []);
  assert.equal(result.usage.output_tokens, 9);
});

test("planner: a step split across network chunks is assembled; fences and chatter are ignored; bad steps are reported", async () => {
  const text = '```json\n{"op":"write","kind":"text","content":"Hel' + 'lo","id":"a"}\nSure, here you go!\n{"op":"explode"}\n{"op":"write","kind":"text","content":"last, no newline","id":"b"}';
  const pieces = []; for (let i = 0; i < text.length; i += 7) pieces.push(text.slice(i, i + 7));
  const delivered = [];
  const result = await core.planBoardStream({ apiKey: "k", turns: [], boardItems: [], fetchImpl: async () => fakeStream(pieces), onOps: (ops) => delivered.push(...ops) });
  assert.deepEqual(result.ops.map((o) => o.content), ["Hello", "last, no newline"]);
  assert.deepEqual(delivered.map((o) => o.content), ["Hello", "last, no newline"]);
  assert.equal(result.errors.length, 2, JSON.stringify(result.errors));
});

test("planner: steps are validated against what is already on the board, including earlier steps in the same answer", async () => {
  const lines = ['{"op":"graph","id":"g","xmin":-3,"xmax":3,"ymin":-1,"ymax":9}', '{"op":"plot","graph":"g","fn":"x^2"}', '{"op":"plot","graph":"nope","fn":"x"}', '{"op":"highlight","target":"old"}', '{"op":"plot","graph":"g","fn":"alert(1)"}'].map((l) => l + "\n");
  const result = await core.planBoardStream({ apiKey: "k", turns: [], boardItems: [{ id: "old", type: "text" }], fetchImpl: async () => fakeStream(lines) });
  assert.deepEqual(result.ops.map((o) => o.op), ["graph", "plot", "highlight"]);
  assert.equal(result.errors.length, 2);
});

test("planner: more steps than allowed are cut off", async () => {
  const lines = Array.from({ length: 30 }, (_, i) => JSON.stringify({ op: "write", content: "n" + i }) + "\n");
  const result = await core.planBoardStream({ apiKey: "k", turns: [], boardItems: [], fetchImpl: async () => fakeStream(lines) });
  assert.equal(result.ops.length, core.LIMITS.opsPerPlan);
  assert.ok(result.errors.some((e) => e.includes("Too many")));
});

test("planner: an empty answer means nothing to draw", async () => {
  const result = await core.planBoardStream({ apiKey: "k", turns: [], boardItems: [], fetchImpl: async () => fakeStream(["   \n"]) });
  assert.deepEqual(result.ops, []);
  assert.deepEqual(result.errors, []);
});

test("planner: HTTP errors throw with the status so the page can fall back (and say why)", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, body: null, json: async () => ({}) });
  await assert.rejects(core.planBoardStream({ apiKey: "bad", turns: [], boardItems: [], fetchImpl }), (error) => error.status === 401);
});

test("planner: an error event in the middle of the stream throws", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({ start(c) { c.enqueue(encoder.encode('data: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n')); c.close(); } });
  await assert.rejects(core.planBoardStream({ apiKey: "k", turns: [], boardItems: [], fetchImpl: async () => ({ ok: true, body }) }), (error) => error.status === 529);
});

test("planner: aborting stops the stream (no more tokens are paid for)", async () => {
  const controller = new AbortController();
  const fetchImpl = async (url, init) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({ async pull(c) { await sleep(20); if (init.signal.aborted) { c.error(new DOMException("aborted", "AbortError")); return; } c.enqueue(encoder.encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\n')); } });
    return { ok: true, body };
  };
  const promise = core.planBoardStream({ apiKey: "k", turns: [], boardItems: [], fetchImpl, signal: controller.signal });
  setTimeout(() => controller.abort(), 60);
  await assert.rejects(promise, (error) => error.name === "AbortError");
});

test("planner: if streaming is unavailable the whole answer is still understood", async () => {
  const data = { content: [{ type: "text", text: '{"op":"write","content":"Hi"}\n{"op":"write","content":"There"}' }], usage: { output_tokens: 3 } };
  const result = await core.planBoardStream({ apiKey: "k", turns: [], boardItems: [], fetchImpl: async () => ({ ok: true, body: null, json: async () => data }) });
  assert.deepEqual(result.ops.map((o) => o.content), ["Hi", "There"]);
});

test("planner prompt tells Claude it is writing by hand and documents every step it may use", () => {
  for (const word of ["pen", "JSON", ...core.OPS.map((op) => '"op":"' + op + '"')]) assert.ok(core.PLANNER_SYSTEM.includes(word.replace(/^"op":"pause"$/, "pause")), "mentions " + word);
  assert.ok(core.PLANNER_SYSTEM.length < 4000, "prompt stays small: " + core.PLANNER_SYSTEM.length);
});

/* ---------- speech pacing ---------- */

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
