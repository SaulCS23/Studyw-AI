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
  const OPS = ["write", "graph", "plot", "point", "shape", "group", "highlight", "erase", "correct", "new_page", "go_to_page", "point_to", "clear", "pause"];
  const SIDES = ["right", "below", "left", "above"];
  const PAGE_KEYWORDS = ["latest", "previous", "next", "first"];
  const LIMITS = { opsPerPlan: 14, textLength: 90, latexLength: 160, pointsPerShape: 40, idLength: 24, cueLength: 60, pauseMs: 1500, expressionLength: 80 };
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
   * A validator that remembers what is in the notebook (and what earlier steps in the same plan created), so steps can
   * be checked one at a time as they stream in. Bad steps are rejected with a reason; good ones come back cleaned:
   * only known fields, safe values, ids that exist. Claude does not choose positions: x and y are only kept for
   * things drawn inside a diagram group (local coordinates); the layout engine places everything else.
   * context: { ids: all element ids, graphs: graph ids, groups: { id: {w,h} }, pages: page ids }
   */
  function createValidator(context) {
    const state = {
      known: new Set((context && context.ids) || []),
      graphs: new Set((context && context.graphs) || []),
      groups: new Map(Object.entries((context && context.groups) || {})),
      pages: new Set((context && context.pages) || []),
    };
    let autoId = 0, accepted = 0;
    state.freshId = () => { let id; do { id = "a" + (++autoId); } while (state.known.has(id)); return id; };
    return {
      validate(raw) {
        if (accepted >= LIMITS.opsPerPlan) return { op: null, error: "Too many ops, kept the first " + LIMITS.opsPerPlan };
        try { const op = validateOperation(raw, state, true); if (op) accepted++; return { op, error: null }; }
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

  function validateOperation(raw, state, allowCorrect) {
    if (!raw || typeof raw !== "object") throw new Error("not an object");
    let name = raw.op;
    if (name === "clear") name = "new_page"; // changing topic never destroys earlier pages: it starts a new one
    if (!OPS.includes(name)) throw new Error("unknown op " + JSON.stringify(name));
    const out = { op: name };
    const cue = clean(raw.cue, LIMITS.cueLength);
    if (cue) out.cue = cue;
    const color = pick(raw.color, COLORS, "ink");
    const { known, graphs, groups, pages } = state;

    // Ids: creating ops may reuse an id, which replaces that element.
    const creates = () => {
      const id = raw.id === undefined ? state.freshId() : raw.id;
      if (!isId(id)) throw new Error("bad id");
      out.id = id; known.add(id);
    };
    const mustExist = (field) => {
      const target = raw[field];
      if (!isId(target) || !known.has(target)) throw new Error(field + " does not exist in the notebook");
      return target;
    };
    // Layout hints: where this goes relative to other things, never absolute coordinates.
    const placement = () => {
      if (raw.near !== undefined && isId(raw.near) && known.has(raw.near)) { out.near = raw.near; out.side = pick(raw.side, SIDES, "right"); }
      if (isId(raw.calc)) out.calc = raw.calc;
    };
    // Inside a diagram group, coordinates are local to the group's frame.
    const inGroup = () => {
      if (raw.group === undefined) return null;
      if (!isId(raw.group) || !groups.has(raw.group)) throw new Error("group does not exist");
      out.group = raw.group; return groups.get(raw.group);
    };

    switch (name) {
      case "write": {
        out.kind = pick(raw.kind, ["text", "math"], "text");
        out.content = clean(raw.content, out.kind === "math" ? LIMITS.latexLength : LIMITS.textLength);
        if (!out.content) throw new Error("write needs content");
        out.size = pick(raw.size, SIZES, "body");
        out.color = color;
        const frame = inGroup();
        if (frame) { if (finite(raw.x)) out.x = clampNumber(raw.x, 0, frame.w, 0); if (finite(raw.y)) out.y = clampNumber(raw.y, 0, frame.h, 0); }
        else placement();
        creates(); break;
      }
      case "graph": {
        out.w = clampNumber(raw.w, 200, BOARD.width - 72, 420);
        out.h = clampNumber(raw.h, 150, BOARD.height - 72, 300);
        out.xmin = clampNumber(raw.xmin, -1e6, 1e6, -5); out.xmax = clampNumber(raw.xmax, -1e6, 1e6, 5);
        out.ymin = clampNumber(raw.ymin, -1e6, 1e6, -5); out.ymax = clampNumber(raw.ymax, -1e6, 1e6, 5);
        if (out.xmax <= out.xmin || out.ymax <= out.ymin) throw new Error("graph ranges are empty");
        out.xlabel = clean(raw.xlabel, 24); out.ylabel = clean(raw.ylabel, 24);
        out.grid = raw.grid === true;
        placement();
        creates(); graphs.add(out.id); break;
      }
      case "group": {
        out.w = clampNumber(raw.w, 100, BOARD.width - 72, NaN); out.h = clampNumber(raw.h, 60, BOARD.height - 72, NaN);
        if (Number.isNaN(out.w) || Number.isNaN(out.h)) throw new Error("group needs w and h");
        placement();
        creates(); groups.set(out.id, { w: out.w, h: out.h }); break;
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
        const frame = inGroup();
        const maxX = frame ? frame.w : BOARD.width, maxY = frame ? frame.h : BOARD.height;
        if (!frame) placement();
        if (["line", "arrow", "polyline", "polygon", "curve"].includes(out.shape)) {
          if (!Array.isArray(raw.points)) throw new Error("shape needs points");
          out.points = raw.points.slice(0, LIMITS.pointsPerShape).map((p) => {
            if (!Array.isArray(p) || !finite(p[0]) || !finite(p[1])) throw new Error("bad point");
            return [clampNumber(p[0], 0, maxX, 0), clampNumber(p[1], 0, maxY, 0)];
          });
          const minimum = out.shape === "polygon" ? 3 : 2;
          if (out.points.length < minimum) throw new Error("not enough points");
        } else if (out.shape === "rect") {
          out.x = clampNumber(raw.x, 0, maxX, NaN); out.y = clampNumber(raw.y, 0, maxY, NaN);
          out.w = clampNumber(raw.w, 4, maxX, NaN); out.h = clampNumber(raw.h, 4, maxY, NaN);
          if ([out.x, out.y, out.w, out.h].some(Number.isNaN)) throw new Error("rect needs x,y,w,h");
        } else if (out.shape === "circle") {
          out.x = clampNumber(raw.x, 0, maxX, NaN); out.y = clampNumber(raw.y, 0, maxY, NaN);
          out.r = clampNumber(raw.r, 2, 400, NaN);
          if ([out.x, out.y, out.r].some(Number.isNaN)) throw new Error("circle needs x,y,r");
        } else {
          out.x = clampNumber(raw.x, 0, maxX, NaN); out.y = clampNumber(raw.y, 0, maxY, NaN);
          out.rx = clampNumber(raw.rx, 2, 500, NaN); out.ry = clampNumber(raw.ry, 2, 400, NaN);
          if ([out.x, out.y, out.rx, out.ry].some(Number.isNaN)) throw new Error("ellipse needs x,y,rx,ry");
        }
        creates(); break;
      }
      case "highlight": out.target = mustExist("target"); out.color = pick(raw.color, COLORS, "amber"); break;
      case "point_to": out.target = mustExist("target"); out.return = raw.return !== false; break;
      case "erase":
        if (raw.target === "all") out.target = "all"; else out.target = mustExist("target");
        break;
      case "correct": {
        if (!allowCorrect) throw new Error("correct cannot be nested");
        out.target = mustExist("target");
        out.with = validateOperation(raw.with, state, false);
        if (!["write", "shape"].includes(out.with.op)) throw new Error("correct can only be replaced by write or shape");
        break;
      }
      case "new_page": out.title = clean(raw.title, 40); break;
      case "go_to_page": {
        const page = typeof raw.page === "number" ? "p" + raw.page : raw.page;
        if (!(PAGE_KEYWORDS.includes(page) || (isId(page) && pages.has(page)))) throw new Error("page does not exist");
        out.page = page; break;
      }
      case "pause": out.ms = clampNumber(raw.ms, 0, LIMITS.pauseMs, 400); break;
    }
    return out;
  }

  /* ---------- The planner: a separate Claude call that streams one drawing step per line ---------- */

  const PLANNER_SYSTEM = [
    "You are the whiteboard hand of a live voice tutor, for any subject. The teacher is speaking: write and draw WHAT THE TEACHER IS SAYING, AT THE MOMENT THEY SAY IT.",
    "A pen draws everything stroke by stroke, so work in SMALL steps: one phrase, one formula, one label or one arrow at a time. Key words, never sentences. At most 6 steps for this turn (a diagram may use up to 12).",
    'Tie every step to the words that introduce it: "cue" = 2-5 words copied EXACTLY from the teacher\'s latest turn, at the point where that step\'s idea begins. A step is drawn when the teacher reaches its cue, so list steps in the order the teacher says things and never draw anything the teacher has not said yet.',
    "Output ONLY JSON objects, one per line (JSON Lines), in drawing order. No prose, no code fences.",
    "You never choose positions: the board places everything in free space and starts a new page by itself when needed. Give x and y only inside a diagram group (local coordinates).",
    "Steps (all fields in braces are optional; every step may have cue):",
    '{"op":"write","kind":"text"|"math","content":"...","size":"title"|"body"|"small","color":C,"id":"name","cue":"...",near:"id",side:"right"|"below",calc:"name"}   near+side puts it beside an element; calc: give every line of one calculation the same name so the lines stay together.',
    '{"op":"graph","id":"g","w":420,"h":300,"xmin","xmax","ymin","ymax","xlabel","ylabel","grid":true}   then   {"op":"plot","graph":"g","fn":"x^2-3*x+1","color":C,"label":"short"}   {"op":"point","graph":"g","px","py","label","color":C}',
    '{"op":"group","id":"cell","w":420,"h":300,near,side}  reserves a frame for a diagram. Then draw its parts one by one with "group":"cell" and local coordinates inside 0..w, 0..h: {"op":"shape","group":"cell","shape":"line"|"arrow"|"polyline"|"polygon"|"curve","points":[[x,y],...],"color":C,"dashed":true,"id":"name"}  {"op":"shape","group":"cell","shape":"rect","x","y","w","h"}  {"op":"shape","group":"cell","shape":"circle","x","y","r"}  {"op":"shape","group":"cell","shape":"ellipse","x","y","rx","ry"}  {"op":"write","group":"cell","kind":"text","content":"label","size":"small","x","y"}  (fill:true tints closed shapes). Draw each part when the teacher mentions it. A lone arrow or shape needs no group.',
    '{"op":"highlight","target":"id","color":C}   {"op":"point_to","target":"id"}  (the teacher points at an existing element, on any page)   {"op":"erase","target":"id"}   {"op":"correct","target":"id","with":{a write or shape step}}   {"op":"pause","ms":500}',
    '{"op":"new_page","title":"short"}  {"op":"go_to_page","page":"p1"|"previous"|"latest"}',
    "C is one of ink, blue, red, green, amber, violet (ink by default).",
    "Notebook: it has pages (p1, p2, ...). Start a new page (new_page) when the teacher begins a new topic or section, or when the summary says the live page is nearly full. Never erase a page to change topic. To refer back to something on an earlier page: go_to_page, then point_to the element, then go_to_page latest to return. Highlight and point only at things that exist in the summary. Add to the notebook; never redraw what is already there.",
    "Math (kind=math) is LaTeX, supported: + - = < > ( ) [ ] / digits, letters, ^ and _ for powers and indices, \\frac{a}{b}, \\sqrt{x}, \\sqrt[3]{x}, \\sum_{i=1}^{n}, \\int_a^b, \\lim_{x \\to 0}, \\sin \\cos \\tan \\log \\ln, \\pm \\times \\cdot \\div \\leq \\geq \\neq \\approx \\infty \\to \\rightarrow \\Rightarrow \\circ \\partial \\nabla, Greek (\\alpha \\beta \\pi \\theta \\Delta ...), \\vec{v} \\bar{x} \\hat{x}, \\text{words}, \\left( \\right). No matrices, \\begin{...}, tables or colors inside LaTeX: write separate lines instead. Chemistry as math, e.g. H_2O.",
    "Text may be in the language the teacher speaks, using Latin letters with accents. Graphs: plot with explicit * and ^ (2*x+1, sin(x), x^2).",
    "Give the first step quickly: the pen starts as soon as your first line arrives. If the turn is small talk or nothing visual would help, output nothing at all.",
  ].join("\n");

  const clip = (text, n) => String(text || "").replace(/\s+/g, " ").slice(0, n);
  /**
   * What is in the notebook, for the planner: every page with its title and elements (ids and a few words), and how
   * full the live page is. Positions are left out on purpose: Claude does not place things.
   * notebook = { live, pages: [{ id, title, free, items: [{ id, type, text }] }] }
   */
  function summariseNotebook(notebook) {
    if (!notebook || !notebook.pages || !notebook.pages.length) return "(empty notebook: the first thing you draw goes on page p1)";
    let budget = 45;
    const lines = notebook.pages.map((page) => {
      const items = page.items.slice(0, Math.max(3, Math.min(14, budget)));
      budget -= items.length;
      const tag = page.id === notebook.live ? " (live, about " + Math.round(page.free * 100) + "% free)" : "";
      return page.id + ' "' + clip(page.title, 30) + '"' + tag + (items.length ? ": " + items.map((i) => i.id + " " + i.type + (i.text ? ' "' + clip(i.text, 28) + '"' : "")).join("; ") : ": empty");
    });
    return lines.join("\n");
  }

  /** The user message for the planner. Only the last few turns are sent, to keep tokens and latency low. */
  function buildPlannerMessage(turns, notebook, hint, handled) {
    const recent = (turns || []).slice(-6).map((t) => (t.role === "teacher" ? "Teacher: " : "Student: ") + String(t.text).slice(0, 500));
    const request = hint ? "\n\nThe teacher also asked for this to be shown on the board (draw it step by step, shorter if it is long): " + clip(hint, 600) : "";
    const continued = handled ? "\n\nThe start of the teacher's latest turn is already on the board: \"" + clip(handled, 300) + "\". Only plan what comes after it." : "";
    return "Notebook:\n" + summariseNotebook(notebook) + "\n\nConversation (oldest first):\n" + recent.join("\n") + continued + request;
  }

  /**
   * Ask Claude what to draw and receive the steps as they are written. Each complete line is validated and handed to
   * onOps straight away, so the first stroke can start while Claude is still writing the rest.
   * Resolves to { ops, errors, usage } when the stream ends. Throws on network or auth problems (error.status is set
   * for HTTP errors) so the caller can fall back to the classic board; an aborted request throws an AbortError.
   */
  async function planBoardStream({ apiKey, turns, notebook, context, hint, handled, fetchImpl, signal, model, onOps }) {
    const doFetch = fetchImpl || fetch;
    const response = await doFetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal,
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({
        model: model || PLANNER_MODEL, max_tokens: 1200, stream: true, system: PLANNER_SYSTEM,
        messages: [{ role: "user", content: buildPlannerMessage(turns, notebook, hint, handled) }],
      }),
    });
    if (!response.ok) { const error = new Error("Planner request failed: " + response.status); error.status = response.status; throw error; }

    const validator = createValidator(context || deriveContext(notebook));
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

  /* ---------- Tying steps to the teacher's words ---------- */

  const LETTER_OR_DIGIT = "\\p{L}\\p{N}";
  const escapeRegExp = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cueWords = (cue) => String(cue || "").match(/[\p{L}\p{N}]+/gu) || [];

  /**
   * Where does the cue phrase start in the teacher's text? Whole words only, ignoring case and punctuation. If the
   * full phrase is not found (the planner may have paraphrased the end), its first three, then two words are tried.
   * Returns { start, end } (indexes into text) or null.
   */
  function locateCue(text, cue) {
    const words = cueWords(cue);
    if (!words.length || !text) return null;
    const lengths = [words.length, 3, 2].filter((n, i, all) => n <= words.length && n >= 1 && all.indexOf(n) === i);
    if (words.length === 1) lengths.push(1);
    for (const n of lengths) {
      if (n === 1 && words.length > 1) continue;
      const pattern = "(?<![" + LETTER_OR_DIGIT + "])" + words.slice(0, n).map(escapeRegExp).join("[^" + LETTER_OR_DIGIT + "]+") + "(?![" + LETTER_OR_DIGIT + "])";
      const match = new RegExp(pattern, "iu").exec(text);
      if (match) return { start: match.index, end: match.index + match[0].length };
    }
    return null;
  }

  /**
   * One teacher turn's speech clock: answers "has the teacher reached this step's cue yet?".
   *
   * Three sources of information, best first:
   *  1. ElevenLabs audio alignment (aligned()): the text actually being played, optionally with per-character
   *     times, so a step is released when its words are spoken (or at their exact time within a chunk).
   *  2. An estimate from the turn text: the cue's position in the text at a typical speaking pace, counted from when
   *     the voice started. Used when there is no alignment, and as a backstop (with a grace period) when there is.
   *  3. Never holding a step for ever: no cue, a cue not found in the text, or the speech having ended all release it.
   * Pure (time is passed in), so late, missing and out-of-order timing can be tested without a browser.
   */
  class SpeechClock {
    constructor(options) {
      const o = options || {};
      this.leadMs = o.leadMs == null ? 350 : o.leadMs;           // start writing a little before the words
      this.graceMs = o.graceMs == null ? 2000 : o.graceMs;       // extra wait for alignment before trusting the estimate
      this.wordsPerSecond = o.wordsPerSecond || SPEECH_WORDS_PER_SECOND;
      this.reset();
    }
    reset() { this.text = ""; this.messageAt = null; this.startedAt = null; this.endedAt = null; this.chars = []; this.times = []; this.updates = 0; this.cache = new Map(); }
    setText(text, now) { this.text = String(text || ""); this.cache.clear(); if (this.messageAt == null && this.text) this.messageAt = now; }
    start(now) { if (this.startedAt == null) this.startedAt = now; this.endedAt = null; }
    end(now) { this.endedAt = now; }
    /** A chunk of aligned speech began playing at `now`. startsMs = each character's start offset in the chunk, if known. */
    aligned(text, startsMs, now) {
      const chars = Array.from(String(text || ""));
      const usable = Array.isArray(startsMs) && startsMs.length === chars.length && startsMs.every((v, i) => Number.isFinite(v) && (i === 0 || v >= startsMs[i - 1]));
      chars.forEach((ch, i) => { this.chars.push(ch); this.times.push(now + (usable ? startsMs[i] : 0)); });
      this.updates++;
      if (this.startedAt == null) this.startedAt = now;
    }
    get hasAlignment() { return this.updates > 0; }
    estimateMs(prefix) { return Math.round((String(prefix).trim().split(/\s+/).filter(Boolean).length / this.wordsPerSecond) * 1000); }

    /** { ready, reason, waitMs } for a cue at time `now`. */
    evaluate(cue, now) {
      if (!cue) return { ready: true, reason: "no-cue" };
      if (this.endedAt != null) return { ready: true, reason: "speech-ended" };
      if (this.updates > 0) { // exact: the words are in the speech that is playing
        const spoken = this.chars.join(""), found = locateCue(spoken, cueWords(cue).slice(0, 2).join(" "));
        if (found) {
          const at = this.times[Array.from(spoken.slice(0, found.start)).length] - this.leadMs;
          return now >= at ? { ready: true, reason: "aligned" } : { ready: false, reason: "aligned-soon", waitMs: at - now };
        }
      }
      if (!this.cache.has(cue)) this.cache.set(cue, locateCue(this.text, cue));
      const where = this.cache.get(cue);
      if (!where) return { ready: true, reason: "cue-not-found" };
      const base = this.startedAt != null ? this.startedAt : this.messageAt != null ? this.messageAt + 800 : null;
      if (base == null) return { ready: false, reason: "waiting-for-speech", waitMs: 200 };
      const due = base + this.estimateMs(this.text.slice(0, where.start)) - this.leadMs + (this.updates > 0 ? this.graceMs : 0);
      return now >= due ? { ready: true, reason: this.updates > 0 ? "estimate-after-grace" : "estimate" } : { ready: false, reason: "estimate-wait", waitMs: due - now };
    }
  }

  /**
   * Hands out the steps of a continuation plan in speaking order: they are held back while the earlier plan of the same
   * turn is still running, then released at once, and every step after that is passed on the moment it arrives (not
   * when the stream ends). `isStale()` drops everything once the student has interrupted.
   */
  function createOrderedDelivery(previousDone, deliver, isStale) {
    let released = false; const held = [];
    const settled = Promise.resolve(previousDone).then(() => {
      released = true;
      const batch = held.splice(0);
      if (batch.length && !isStale()) deliver(batch);
    });
    return {
      push(ops) { if (isStale()) return; if (released) deliver(ops); else held.push(...ops); },
      pending() { return held.length; },
      whenReleased() { return settled; },
    };
  }

  /** What the validator needs to know, when the caller has only a notebook summary. */
  function deriveContext(notebook) {
    const context = { ids: [], graphs: [], groups: {}, pages: [] };
    for (const page of (notebook && notebook.pages) || []) {
      context.pages.push(page.id);
      for (const item of page.items || []) { context.ids.push(item.id); if (item.type === "graph") context.graphs.push(item.id); if (item.type === "group" && item.w) context.groups[item.id] = { w: item.w, h: item.h }; }
    }
    return context;
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
    compileExpression, createValidator, validatePlan, buildPlannerMessage, summariseNotebook, deriveContext, planBoardStream,
    locateCue, SpeechClock, createOrderedDelivery, SIDES, PAGE_KEYWORDS,
    estimateSpeechMs, normalizeSpeech, cueSpoken, niceTicks,
  };
});
