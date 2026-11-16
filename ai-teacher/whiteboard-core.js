/* Whiteboard core: everything that needs no DOM, so it can be unit-tested in Node.
 *
 *  - compileExpression: a small safe maths parser (never eval) used to plot curves.
 *  - validatePlan: strict schema check for the drawing instructions Claude returns.
 *  - planBoardStream: the separate Claude call that turns the live conversation into drawing steps, streamed one per line.
 *  - speech helpers: pace the drawing against the teacher's voice.
 *
 * Classic script (not an ES module) so ai-teacher/index.html still works when opened straight from disk.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WhiteboardCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const BOARD = { width: 1000, height: 600 };
  const COLORS = ["ink", "blue", "red", "green", "amber", "violet"];
  const SIZES = ["title", "body", "small"];
  const SHAPES = ["line", "arrow", "rect", "circle", "ellipse", "polyline", "polygon", "curve"];
  const OPS = ["write", "graph", "plot", "point", "shape", "highlight", "erase", "correct", "clear", "pause"];
  const LIMITS = { opsPerPlan: 12, textLength: 90, latexLength: 160, pointsPerShape: 40, idLength: 24, cueLength: 60, pauseMs: 1500, expressionLength: 80 };
  const PLANNER_MODEL = "claude-sonnet-5-5";

  /* ---------- Safe expression parser ---------- */

  const FUNCTIONS = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
    ln: Math.log, log: Math.log10, exp: Math.exp, floor: Math.floor, ceil: Math.ceil, sign: Math.sign,
  };
  const CONSTANTS = { pi: Math.PI, e: Math.E };

  function tokenize(source) {
    const tokens = [];
    const pattern = /\s*(?:(\d+\.?\d*|\.\d+)|([a-z]+)|(.))/gy;
    let match;
    while (pattern.lastIndex < source.length && (match = pattern.exec(source))) {
      if (match[1] !== undefined) tokens.push({ type: "num", value: parseFloat(match[1]) });
      else if (match[2] !== undefined) tokens.push({ type: "id", value: match[2] });
      else if ("+-*/^(),".includes(match[3])) tokens.push({ type: "op", value: match[3] });
      else throw new Error("Unexpected character: " + match[3]);
    }
    return tokens;
  }

  /** Compile "x^2 - 3x + 1" into a function of x. Throws if the text is not a plain maths expression. */
  function compileExpression(source) {
    let text = String(source == null ? "" : source).trim();
    text = text.replace(/^(?:y|f\s*\(\s*x\s*\))\s*=\s*/i, "").replace(/\*\*/g, "^").replace(/−/g, "-")
      .replace(/[×·]/g, "*").replace(/π/g, "pi").toLowerCase();
    if (!text || text.length > LIMITS.expressionLength) throw new Error("Expression is empty or too long");
    const tokens = tokenize(text);
    let position = 0;
    const peek = () => tokens[position];
    const takeOp = (symbol) => { const t = tokens[position]; if (t && t.type === "op" && t.value === symbol) { position++; return true; } return false; };

    function parseSum() {
      let left = parseProduct();
      for (;;) {
        if (takeOp("+")) { const a = left, b = parseProduct(); left = (x) => a(x) + b(x); }
        else if (takeOp("-")) { const a = left, b = parseProduct(); left = (x) => a(x) - b(x); }
        else return left;
      }
    }
    function parseProduct() {
      let left = parseUnary();
      for (;;) {
        const next = peek();
        if (takeOp("*")) { const a = left, b = parseUnary(); left = (x) => a(x) * b(x); }
        else if (takeOp("/")) { const a = left, b = parseUnary(); left = (x) => a(x) / b(x); }
        // Implicit multiplication: 2x, 3(x+1), x sin(x). A number straight after a name is not allowed ("x2").
        else if (next && (next.type === "id" || (next.type === "op" && next.value === "("))) { const a = left, b = parseUnary(); left = (x) => a(x) * b(x); }
        else return left;
      }
    }
    function parseUnary() {
      if (takeOp("-")) { const a = parseUnary(); return (x) => -a(x); }
      if (takeOp("+")) return parseUnary();
      return parsePower();
    }
    function parsePower() {
      const base = parseAtom();
      if (takeOp("^")) { const exponent = parseUnary(); return (x) => Math.pow(base(x), exponent(x)); }
      return base;
    }
    function parseAtom() {
      const token = tokens[position++];
      if (!token) throw new Error("Unexpected end of expression");
      if (token.type === "num") { const v = token.value; return () => v; }
      if (token.type === "id") {
        if (token.value === "x") return (x) => x;
        if (Object.prototype.hasOwnProperty.call(CONSTANTS, token.value)) { const v = CONSTANTS[token.value]; return () => v; }
        if (Object.prototype.hasOwnProperty.call(FUNCTIONS, token.value)) {
          if (!takeOp("(")) throw new Error("Function needs brackets: " + token.value);
          const argument = parseSum();
          if (!takeOp(")")) throw new Error("Missing )");
          const fn = FUNCTIONS[token.value];
          return (x) => fn(argument(x));
        }
        throw new Error("Unknown name: " + token.value);
      }
      if (token.type === "op" && token.value === "(") {
        const inner = parseSum();
        if (!takeOp(")")) throw new Error("Missing )");
        return inner;
      }
      throw new Error("Unexpected " + token.value);
    }

    const compiled = parseSum();
    if (position < tokens.length) throw new Error("Unexpected " + tokens[position].value);
    return compiled;
  }

  /* ---------- Strict validation of Claude's drawing instructions ---------- */

  const clean = (value, max) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const clampNumber = (value, min, max, fallback) => (finite(value) ? Math.min(max, Math.max(min, value)) : fallback);
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  const isId = (value) => typeof value === "string" && /^[a-z][a-z0-9_-]*$/i.test(value) && value.length <= LIMITS.idLength;

  /**
   * A validator that remembers what is on the board (and what earlier steps in the same plan created), so steps can
   * be checked one at a time as they stream in. Bad steps are rejected with a reason; good ones come back cleaned:
   * only known fields, safe values, ids that exist.
   * context.ids = ids already on the board, context.graphs = ids of graphs.
   */
  function createValidator(context) {
    const known = new Set((context && context.ids) || []);
    const graphs = new Set((context && context.graphs) || []);
    let autoId = 0, accepted = 0;
    const freshId = () => { let id; do { id = "a" + (++autoId); } while (known.has(id)); return id; };
    return {
      validate(raw) {
        if (accepted >= LIMITS.opsPerPlan) return { op: null, error: "Too many ops, kept the first " + LIMITS.opsPerPlan };
        try { const op = validateOperation(raw, known, graphs, freshId, true); if (op) accepted++; return { op, error: null }; }
        catch (error) { return { op: null, error: error.message }; }
      },
    };
  }

  /** Check a whole list of raw operations at once (see createValidator for what is checked). */
  function validatePlan(rawPlan, context) {
    const rawOps = Array.isArray(rawPlan) ? rawPlan : rawPlan && Array.isArray(rawPlan.ops) ? rawPlan.ops : null;
    if (!rawOps) return { ops: [], errors: ["Plan has no ops array"] };
    const validator = createValidator(context), ops = [], errors = [];
    if (rawOps.length > LIMITS.opsPerPlan) errors.push("Too many ops, kept the first " + LIMITS.opsPerPlan);
    rawOps.slice(0, LIMITS.opsPerPlan).forEach((raw, index) => {
      const { op, error } = validator.validate(raw);
      if (op) ops.push(op); else if (error) errors.push("op " + index + ": " + error);
    });
    return { ops, errors };
  }

  function validateOperation(raw, known, graphs, freshId, allowCorrect) {
    if (!raw || typeof raw !== "object") throw new Error("not an object");
    const name = raw.op;
    if (!OPS.includes(name)) throw new Error("unknown op " + JSON.stringify(name));
    const out = { op: name };
    const cue = clean(raw.cue, LIMITS.cueLength);
    if (cue) out.cue = cue;
    const color = pick(raw.color, COLORS, "ink");

    // Ids: creating ops may reuse an id, which replaces that element.
    const creates = () => {
      const id = raw.id === undefined ? freshId() : raw.id;
      if (!isId(id)) throw new Error("bad id");
      out.id = id; known.add(id);
    };
    const mustExist = (field) => {
      const target = raw[field];
      if (!isId(target) || !known.has(target)) throw new Error(field + " does not exist on the board");
      return target;
    };

    switch (name) {
      case "write": {
        out.kind = pick(raw.kind, ["text", "math"], "text");
        out.content = clean(raw.content, out.kind === "math" ? LIMITS.latexLength : LIMITS.textLength);
        if (!out.content) throw new Error("write needs content");
        out.size = pick(raw.size, SIZES, "body");
        out.color = color;
        if (finite(raw.x) && finite(raw.y)) { out.x = clampNumber(raw.x, 0, BOARD.width - 20, 0); out.y = clampNumber(raw.y, 0, BOARD.height - 20, 0); }
        if (finite(raw.w)) out.w = clampNumber(raw.w, 80, BOARD.width, 460);
        creates(); break;
      }
      case "graph": {
        out.x = clampNumber(raw.x, 0, BOARD.width - 200, 40);
        out.y = clampNumber(raw.y, 0, BOARD.height - 150, 40);
        out.w = clampNumber(raw.w, 200, BOARD.width - out.x, 420);
        out.h = clampNumber(raw.h, 150, BOARD.height - out.y, 300);
        out.xmin = clampNumber(raw.xmin, -1e6, 1e6, -5); out.xmax = clampNumber(raw.xmax, -1e6, 1e6, 5);
        out.ymin = clampNumber(raw.ymin, -1e6, 1e6, -5); out.ymax = clampNumber(raw.ymax, -1e6, 1e6, 5);
        if (out.xmax <= out.xmin || out.ymax <= out.ymin) throw new Error("graph ranges are empty");
        out.xlabel = clean(raw.xlabel, 24); out.ylabel = clean(raw.ylabel, 24);
        out.grid = raw.grid === true;
        creates(); graphs.add(out.id); break;
      }
      case "plot": {
        out.graph = mustExist("graph");
        if (!graphs.has(out.graph)) throw new Error("graph is not a graph");
        out.fn = clean(raw.fn, LIMITS.expressionLength);
        compileExpression(out.fn); // throws if it is not safe maths
        out.color = color;
        if (finite(raw.from)) out.from = raw.from;
        if (finite(raw.to)) out.to = raw.to;
        out.label = clean(raw.label, 24);
        creates(); break;
      }
      case "point": {
        out.graph = mustExist("graph");
        if (!graphs.has(out.graph)) throw new Error("graph is not a graph");
        if (!finite(raw.px) || !finite(raw.py)) throw new Error("point needs px and py");
        out.px = raw.px; out.py = raw.py; out.label = clean(raw.label, 24); out.color = color;
        creates(); break;
      }
      case "shape": {
        out.shape = pick(raw.shape, SHAPES, null);
        if (!out.shape) throw new Error("unknown shape");
        out.color = color; out.dashed = raw.dashed === true; out.fill = raw.fill === true;
        if (["line", "arrow", "polyline", "polygon", "curve"].includes(out.shape)) {
          if (!Array.isArray(raw.points)) throw new Error("shape needs points");
          out.points = raw.points.slice(0, LIMITS.pointsPerShape).map((p) => {
            if (!Array.isArray(p) || !finite(p[0]) || !finite(p[1])) throw new Error("bad point");
            return [clampNumber(p[0], 0, BOARD.width, 0), clampNumber(p[1], 0, BOARD.height, 0)];
          });
          const minimum = out.shape === "polygon" ? 3 : 2;
          if (out.points.length < minimum) throw new Error("not enough points");
        } else if (out.shape === "rect") {
          out.x = clampNumber(raw.x, 0, BOARD.width, NaN); out.y = clampNumber(raw.y, 0, BOARD.height, NaN);
          out.w = clampNumber(raw.w, 4, BOARD.width, NaN); out.h = clampNumber(raw.h, 4, BOARD.height, NaN);
          if ([out.x, out.y, out.w, out.h].some(Number.isNaN)) throw new Error("rect needs x,y,w,h");
        } else if (out.shape === "circle") {
          out.x = clampNumber(raw.x, 0, BOARD.width, NaN); out.y = clampNumber(raw.y, 0, BOARD.height, NaN);
          out.r = clampNumber(raw.r, 2, 400, NaN);
          if ([out.x, out.y, out.r].some(Number.isNaN)) throw new Error("circle needs x,y,r");
        } else {
          out.x = clampNumber(raw.x, 0, BOARD.width, NaN); out.y = clampNumber(raw.y, 0, BOARD.height, NaN);
          out.rx = clampNumber(raw.rx, 2, 500, NaN); out.ry = clampNumber(raw.ry, 2, 400, NaN);
          if ([out.x, out.y, out.rx, out.ry].some(Number.isNaN)) throw new Error("ellipse needs x,y,rx,ry");
        }
        creates(); break;
      }
      case "highlight": out.target = mustExist("target"); out.color = pick(raw.color, COLORS, "amber"); break;
      case "erase":
        if (raw.target === "all") out.target = "all"; else out.target = mustExist("target");
        break;
      case "correct": {
        if (!allowCorrect) throw new Error("correct cannot be nested");
        out.target = mustExist("target");
        out.with = validateOperation(raw.with, known, graphs, freshId, false);
        if (!["write", "shape"].includes(out.with.op)) throw new Error("correct can only be replaced by write or shape");
        break;
      }
      case "clear": break;
      case "pause": out.ms = clampNumber(raw.ms, 0, LIMITS.pauseMs, 400); break;
    }
    return out;
  }

  /* ---------- The planner: a separate Claude call that streams one drawing step per line ---------- */

  const PLANNER_SYSTEM = [
    "You are the whiteboard hand of a live voice tutor, for any subject. The teacher is speaking; decide what to write or draw to support the teacher's LATEST turn.",
    "Everything you output is drawn by a pen, stroke by stroke, while the teacher talks. So write like a teacher at a board: key words and short phrases (under 6 words), formulas, labels, quick sketches. Never whole sentences. One idea per turn, at most 8 steps.",
    "Output ONLY JSON objects, one per line (JSON Lines), in the order they should be drawn. No prose, no code fences.",
    "Board: 1000x600 units, origin top-left. Text flows into free space automatically when you leave out x and y; do that for most writing. Give x,y only for diagrams, and keep clear of the elements listed under 'On board'.",
    "Steps (fields in braces are optional):",
    '{"op":"write","kind":"text"|"math","content":"...","size":"title"|"body"|"small","color":C,"id":"name","cue":"2-5 words from the teacher\u0027s turn",x,y,w}',
    '{"op":"graph","id":"g","x","y","w","h","xmin","xmax","ymin","ymax","xlabel","ylabel","grid":true}   then   {"op":"plot","graph":"g","fn":"x^2-3*x+1","color":C,"label":"short"}   {"op":"point","graph":"g","px","py","label","color":C}',
    '{"op":"shape","shape":"line"|"arrow"|"polyline"|"polygon"|"curve","points":[[x,y],...],"color":C,"dashed":true,"id":"name"}   {"op":"shape","shape":"rect","x","y","w","h"}   {"op":"shape","shape":"circle","x","y","r"}   {"op":"shape","shape":"ellipse","x","y","rx","ry"}   (add "fill":true to tint closed shapes)',
    '{"op":"highlight","target":"id","color":C}   {"op":"erase","target":"id"|"all"}   {"op":"correct","target":"id","with":{a write or shape step}}   {"op":"clear"}   {"op":"pause","ms":500}',
    "C is one of ink, blue, red, green, amber, violet (ink by default). Add to the board; never redraw what is already there. Use clear only when the subject changes. Fix a mistake with correct. Highlight only things that exist.",
    "Math (kind=math) is LaTeX, supported: + - = < > ( ) [ ] / digits, letters, ^ and _ for powers and indices, \\frac{a}{b}, \\sqrt{x}, \\sqrt[3]{x}, \\sum_{i=1}^{n}, \\int_a^b, \\lim_{x \\to 0}, \\sin \\cos \\tan \\log \\ln, \\pm \\times \\cdot \\div \\leq \\geq \\neq \\approx \\infty \\to \\rightarrow \\Rightarrow \\circ \\partial \\nabla, Greek (\\alpha \\beta \\pi \\theta \\Delta ...), \\vec{v} \\bar{x} \\hat{x}, \\text{words}, \\left( \\right). Do not use matrices, \\begin{...}, tables or colors inside LaTeX; write separate lines instead.",
    "Text may be in the language the teacher speaks, using Latin letters with accents. Chemistry: write formulas as math, e.g. H_2O, CO_2.",
    "Graphs: plot functions with explicit * and ^ (e.g. 2*x+1, sin(x), x^2). Diagrams: build from shapes plus short text labels placed next to them.",
    "Give the first step quickly: the board starts drawing as soon as your first line arrives. If the turn is small talk or nothing visual would help, output nothing at all.",
  ].join("\n");

  function summariseBoard(items) {
    if (!items || !items.length) return "(empty)";
    return items.slice(-30).map((item) => {
      const box = item.x === undefined ? "" : " @" + [item.x, item.y, item.w, item.h].map(Math.round).join(",");
      return item.id + " " + item.type + box + (item.text ? " \"" + item.text.slice(0, 40) + "\"" : "");
    }).join("\n");
  }

  /** The user message for the planner. Only the last few turns are sent, to keep tokens and latency low. */
  function buildPlannerMessage(turns, boardItems, nextSlot, hint) {
    const recent = (turns || []).slice(-6).map((t) => (t.role === "teacher" ? "Teacher: " : "Student: ") + String(t.text).slice(0, 500));
    const slot = nextSlot ? "\nNext free text slot: x=" + Math.round(nextSlot.x) + " y=" + Math.round(nextSlot.y) : "";
    const request = hint ? "\n\nThe teacher also asked for this to be shown on the board (draw it step by step, shorter if it is long): " + String(hint).slice(0, 600) : "";
    return "On board:\n" + summariseBoard(boardItems) + slot + "\n\nConversation (oldest first):\n" + recent.join("\n") + request;
  }

  /**
   * Ask Claude what to draw and receive the steps as they are written. Each complete line is validated and handed to
   * onOps straight away, so the first stroke can start while Claude is still writing the rest.
   * Resolves to { ops, errors, usage } when the stream ends. Throws on network or auth problems (error.status is set
   * for HTTP errors) so the caller can fall back to the classic board; an aborted request throws an AbortError.
   */
  async function planBoardStream({ apiKey, turns, boardItems, nextSlot, graphIds, hint, fetchImpl, signal, model, onOps }) {
    const doFetch = fetchImpl || fetch;
    const response = await doFetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal,
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({
        model: model || PLANNER_MODEL, max_tokens: 1200, stream: true, system: PLANNER_SYSTEM,
        messages: [{ role: "user", content: buildPlannerMessage(turns, boardItems, nextSlot, hint) }],
      }),
    });
    if (!response.ok) { const error = new Error("Planner request failed: " + response.status); error.status = response.status; throw error; }

    const validator = createValidator({ ids: (boardItems || []).map((item) => item.id), graphs: graphIds || [] });
    const ops = [], errors = []; let usage = null, lineBuffer = "";

    function handleLine(rawLine) {
      const line = rawLine.trim();
      if (!line || line.startsWith("```")) return null;
      if (line[0] !== "{") { errors.push("ignored non-JSON line: " + line.slice(0, 60)); return null; }
      let parsed;
      try { parsed = JSON.parse(line); } catch (error) { errors.push("bad JSON line: " + line.slice(0, 60)); return null; }
      const { op, error } = validator.validate(parsed);
      if (error) errors.push(error);
      return op;
    }
    function consumeText(chunk, flush) {
      lineBuffer += chunk;
      const lines = lineBuffer.split("\n");
      lineBuffer = flush ? "" : lines.pop();
      const batch = [];
      for (const line of lines) { const op = handleLine(line); if (op) batch.push(op); }
      if (batch.length) { ops.push(...batch); if (onOps) onOps(batch); }
    }

    if (response.body && response.body.getReader) {
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let pending = "";
      const handleEvent = (payload) => {
        let event;
        try { event = JSON.parse(payload); } catch (error) { return; }
        if (event.type === "content_block_delta" && event.delta && event.delta.type === "text_delta") consumeText(event.delta.text, false);
        else if (event.type === "message_start" && event.message) usage = event.message.usage || usage;
        else if (event.type === "message_delta" && event.usage) usage = { ...(usage || {}), ...event.usage };
        else if (event.type === "error") { const error = new Error("Planner stream error: " + ((event.error && event.error.message) || "unknown")); error.status = (event.error && event.error.type) === "overloaded_error" ? 529 : 500; throw error; }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline).replace(/\r$/, ""); pending = pending.slice(newline + 1);
          if (line.startsWith("data:")) { const payload = line.slice(5).trim(); if (payload && payload !== "[DONE]") handleEvent(payload); }
        }
      }
    } else { // no streaming available: take the whole answer at once
      const data = await response.json();
      usage = data.usage || null;
      consumeText((data.content || []).filter((b) => b.type === "text").map((b) => b.text).join(""), false);
    }
    consumeText("", true); // the last line has no newline after it: process what is left
    return { ops, errors, usage };
  }

  /* ---------- Pacing against the voice ---------- */

  const SPEECH_WORDS_PER_SECOND = 2.6; // about 155 words a minute, a relaxed teaching pace

  function estimateSpeechMs(text) {
    const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
    return Math.round((words / SPEECH_WORDS_PER_SECOND) * 1000);
  }

  function normalizeSpeech(text) {
    return String(text || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  }

  /** True once the cue phrase has been spoken (matched on normalised words). */
  function cueSpoken(spokenText, cue) {
    const needle = normalizeSpeech(cue);
    return !needle || (" " + normalizeSpeech(spokenText) + " ").includes(" " + needle + " ");
  }

  /** Round tick values for an axis, about `target` of them. */
  function niceTicks(min, max, target) {
    const span = max - min;
    if (!(span > 0)) return [];
    const rough = span / (target || 6);
    const power = Math.pow(10, Math.floor(Math.log10(rough)));
    const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= rough) || rough;
    const ticks = [];
    for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : +v.toPrecision(10));
    return ticks;
  }

  return {
    BOARD, COLORS, SIZES, SHAPES, OPS, LIMITS, PLANNER_MODEL, PLANNER_SYSTEM,
    compileExpression, createValidator, validatePlan, buildPlannerMessage, planBoardStream,
    estimateSpeechMs, normalizeSpeech, cueSpoken, niceTicks,
  };
});
