/* Whiteboard core: everything that needs no DOM, so it can be unit-tested in Node.
 *
 *  - compileExpression: a small safe maths parser (never eval) used to plot curves.
 *  - validatePlan: strict schema check for the drawing instructions Claude returns.
 *  - planBoard: the separate Claude call that turns the live conversation into instructions.
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
  const LIMITS = { opsPerPlan: 12, textLength: 140, latexLength: 200, pointsPerShape: 40, idLength: 24, cueLength: 60, pauseMs: 1500, expressionLength: 80 };
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
   * Check a list of raw operations. Bad operations are dropped one by one (with a reason), so one
   * mistake never blanks the whole board. Output contains only known fields with safe values.
   * context.ids = ids already on the board.
   */
  function validatePlan(rawPlan, context) {
    const errors = [];
    const known = new Set((context && context.ids) || []);
    const graphs = new Set((context && context.graphs) || []);
    const rawOps = Array.isArray(rawPlan) ? rawPlan : rawPlan && Array.isArray(rawPlan.ops) ? rawPlan.ops : null;
    if (!rawOps) return { ops: [], errors: ["Plan has no ops array"] };
    if (rawOps.length > LIMITS.opsPerPlan) errors.push("Too many ops, kept the first " + LIMITS.opsPerPlan);

    let autoId = 0;
    const freshId = () => { let id; do { id = "a" + (++autoId); } while (known.has(id)); return id; };
    const ops = [];

    for (const [index, raw] of rawOps.slice(0, LIMITS.opsPerPlan).entries()) {
      try {
        const op = validateOperation(raw, known, graphs, freshId, true);
        if (op) ops.push(op);
      } catch (error) {
        errors.push("op " + index + ": " + error.message);
      }
    }
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

  /* ---------- The planner: a separate Claude call that returns structured instructions ---------- */

  // One flat object keeps the tool definition small. The strict checking happens in validatePlan, not here.
  const TOOL_SCHEMA = {
    name: "update_whiteboard",
    description: "Write or draw on the shared whiteboard. Operations run in order.",
    input_schema: {
      type: "object",
      properties: {
        ops: {
          type: "array",
          maxItems: LIMITS.opsPerPlan,
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: OPS },
              id: { type: "string", description: "Name for new elements so later ops can refer to them" },
              cue: { type: "string", description: "2-5 words copied from the teacher's turn: appear when the teacher says this" },
              kind: { type: "string", enum: ["text", "math"], description: "write: plain text or LaTeX" },
              content: { type: "string", description: "write: the text, or LaTeX for kind=math" },
              size: { type: "string", enum: SIZES }, color: { type: "string", enum: COLORS },
              x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" },
              r: { type: "number" }, rx: { type: "number" }, ry: { type: "number" },
              xmin: { type: "number" }, xmax: { type: "number" }, ymin: { type: "number" }, ymax: { type: "number" },
              xlabel: { type: "string" }, ylabel: { type: "string" }, grid: { type: "boolean" },
              graph: { type: "string", description: "plot/point: id of the graph" },
              fn: { type: "string", description: "plot: expression in x, e.g. x^2-3*x+1 or sin(x)" },
              from: { type: "number" }, to: { type: "number" }, label: { type: "string" },
              px: { type: "number" }, py: { type: "number" },
              shape: { type: "string", enum: SHAPES },
              points: { type: "array", items: { type: "array", items: { type: "number" } }, description: "[[x,y],...] in board units" },
              dashed: { type: "boolean" }, fill: { type: "boolean" },
              target: { type: "string", description: "highlight/erase/correct: element id (erase also accepts all)" },
              with: { type: "object", description: "correct: the replacement write or shape op" },
              ms: { type: "number" },
            },
            required: ["op"],
          },
        },
      },
      required: ["ops"],
    },
  };

  const PLANNER_SYSTEM = [
    "You are the whiteboard hand of a live voice tutor, for any subject. The teacher is speaking; decide what to write or draw to support the teacher's LATEST turn. Call update_whiteboard once.",
    "Board: 1000x600 units, origin top-left. Text flows into free space automatically when you leave out x and y, so do that for most writing. Give x,y only for diagrams, and keep clear of the elements listed under 'On board'.",
    "Add to the board; never redraw what is already there. Use clear only when the subject changes. Fix a mistake with correct. Use highlight to point at something that exists.",
    "Order ops the way the teacher says things. Give each op a cue: 2-5 words copied from the teacher's turn where it should appear.",
    "Stay sparse: at most 8 ops, one idea per turn, labels under 6 words. Equations are LaTeX with kind=math. Graphs: a graph op, then plot ops with explicit * and ^ (x^2-3*x+1). Diagrams: shapes (line, arrow, rect, circle, ellipse, curve, polygon) plus short text labels next to them. Colors: ink by default, others for emphasis.",
    "If the turn is small talk or nothing visual would help, return an empty ops array.",
  ].join("\n");

  function summariseBoard(items) {
    if (!items || !items.length) return "(empty)";
    return items.slice(-30).map((item) => {
      const box = item.x === undefined ? "" : " @" + [item.x, item.y, item.w, item.h].map(Math.round).join(",");
      return item.id + " " + item.type + box + (item.text ? " \"" + item.text.slice(0, 40) + "\"" : "");
    }).join("\n");
  }

  /** The user message for the planner. Only the last few turns are sent, to keep tokens and latency low. */
  function buildPlannerMessage(turns, boardItems, nextSlot) {
    const recent = (turns || []).slice(-6).map((t) => (t.role === "teacher" ? "Teacher: " : "Student: ") + String(t.text).slice(0, 500));
    const slot = nextSlot ? "\nNext free text slot: x=" + Math.round(nextSlot.x) + " y=" + Math.round(nextSlot.y) : "";
    return "On board:\n" + summariseBoard(boardItems) + slot + "\n\nConversation (oldest first):\n" + recent.join("\n");
  }

  /**
   * Ask Claude what to draw. Resolves to { ops, errors } with ops already validated.
   * Throws on network or auth problems so the caller can fall back to the classic board.
   */
  async function planBoard({ apiKey, turns, boardItems, nextSlot, graphIds, fetchImpl, signal, model }) {
    const doFetch = fetchImpl || fetch;
    const response = await doFetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal,
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({
        model: model || PLANNER_MODEL, max_tokens: 1800, system: PLANNER_SYSTEM,
        tools: [TOOL_SCHEMA], tool_choice: { type: "tool", name: TOOL_SCHEMA.name },
        messages: [{ role: "user", content: buildPlannerMessage(turns, boardItems, nextSlot) }],
      }),
    });
    if (!response.ok) { const error = new Error("Planner request failed: " + response.status); error.status = response.status; throw error; }
    const data = await response.json();
    const block = (data.content || []).find((b) => b.type === "tool_use" && b.name === TOOL_SCHEMA.name);
    if (!block) return { ops: [], errors: ["Planner returned no tool call"], usage: data.usage };
    const ids = (boardItems || []).map((item) => item.id);
    const result = validatePlan(block.input, { ids, graphs: graphIds || [] });
    return { ...result, usage: data.usage };
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
    BOARD, COLORS, SIZES, SHAPES, OPS, LIMITS, PLANNER_MODEL, TOOL_SCHEMA, PLANNER_SYSTEM,
    compileExpression, validatePlan, buildPlannerMessage, planBoard,
    estimateSpeechMs, normalizeSpeech, cueSpoken, niceTicks,
  };
});
