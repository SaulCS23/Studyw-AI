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
  const OPS = ["write", "graph", "plot", "point", "shape", "group", "diagram", "highlight", "erase", "correct", "new_page", "go_to_page", "point_to", "moment", "clear", "pause"];
  const MOMENTS = ["speak_only", "write", "draw", "point", "wait"];
  const DIAGRAM_LAYOUTS = ["row", "column", "grid", "cycle"];
  const NODE_SHAPES = ["box", "rounded", "ellipse", "circle", "none"];
  const LINK_STYLES = ["arrow", "line", "dashed"];
  const SIDES = ["right", "below", "left", "above"];
  const PAGE_KEYWORDS = ["latest", "previous", "next", "first"];
  const LIMITS = { diagramParts: 16, diagramNodes: 8, labelLength: 28, opsPerPlan: 14, textLength: 90, latexLength: 160, pointsPerShape: 40, idLength: 24, cueLength: 60, pauseMs: 1500, expressionLength: 80 };
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
    state.owners = new Map(Object.entries((context && context.owners) || {})); // which diagram (or graph) an item belongs to
    state.notes = [];
    let autoId = 0, accepted = 0;
    state.freshId = () => { let id; do { id = "a" + (++autoId); } while (state.known.has(id)); return id; };
    return {
      validate(raw) {
        if (accepted >= LIMITS.opsPerPlan) return { op: null, error: "Too many ops, kept the first " + LIMITS.opsPerPlan };
        try { const op = validateOperation(raw, state, true); if (op) accepted++; return { op, error: null, notes: state.notes.splice(0) }; }
        catch (error) { state.notes.length = 0; return { op: null, error: error.message, notes: [] }; }
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
      const { op, error, notes } = validator.validate(raw);
      if (op) ops.push(op); else if (error) errors.push("op " + index + ": " + error);
      for (const note of notes || []) errors.push("op " + index + ": " + note);
    });
    return { ops, errors };
  }

  function validateOperation(raw, state, allowCorrect) {
    if (!raw || typeof raw !== "object") throw new Error("not an object");
    let name = raw.op;
    if (name === "clear") name = "new_page"; // changing topic never destroys earlier pages: it starts a new one
    if (!OPS.includes(name)) throw new Error("unknown op " + JSON.stringify(name));
    const out = { op: name };
    const cue = clean(raw.cue, LIMITS.cueLength), ref = clean(raw.ref, LIMITS.cueLength);
    if (cue) out.cue = cue;
    if (ref) out.ref = ref; // the words where the teacher REFERS to this ("look at the point"): it must be drawn by then
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
      case "diagram": {
        if (!Array.isArray(raw.parts)) throw new Error("diagram needs parts");
        const diagramId = raw.id === undefined ? state.freshId() : raw.id;
        if (!isId(diagramId)) throw new Error("bad id");
        out.title = clean(raw.title, 40);
        out.layout = pick(raw.layout, DIAGRAM_LAYOUTS, null) || undefined;
        if (finite(raw.cols)) out.cols = clampNumber(Math.round(raw.cols), 1, 4, 3);
        const notes = state.notes, taken = new Set();
        // An id is free for this diagram if nothing else uses it (or what uses it belongs to this very diagram, which is being replaced).
        // A node must never take over the id of another element: drawing it would delete that element.
        const free = (id) => id !== diagramId && !taken.has(id) && (!known.has(id) || state.owners.get(id) === diagramId);
        const unique = (id) => { if (free(id)) return id; let n = 2, candidate; do { candidate = id.slice(0, LIMITS.idLength - 3) + "_" + n++; } while (!free(candidate)); return candidate; };
        const items = raw.parts.slice(0, LIMITS.diagramParts).filter((p) => p && typeof p === "object");
        const declared = new Set();
        for (const p of items) { // first the nodes, so links and containers can refer to nodes declared later in the list
          if (p.node === undefined) continue;
          if (!isId(p.node) || declared.has(p.node)) { notes.push("diagram node: bad or repeated id " + JSON.stringify(p.node)); continue; }
          if (declared.size >= LIMITS.diagramNodes) { notes.push("diagram has too many nodes; kept the first " + LIMITS.diagramNodes); break; }
          declared.add(p.node);
        }
        let parts = []; const kept = new Set();
        for (const p of items) {
          const part = {}, pc = clean(p.cue, LIMITS.cueLength), pr = clean(p.ref, LIMITS.cueLength);
          if (pc) part.cue = pc; if (pr) part.ref = pr;
          if (p.node !== undefined) {
            if (!declared.has(p.node) || kept.has(p.node)) continue;
            const label = clean(p.label, LIMITS.labelLength);
            if (!label) { notes.push("diagram node " + p.node + " has no label"); declared.delete(p.node); continue; }
            Object.assign(part, { type: "node", id: p.node, label, shape: pick(p.shape, NODE_SHAPES, "rounded"), color: pick(p.color, COLORS, "ink") });
            if (p.in !== undefined) { if (isId(p.in) && p.in !== p.node && declared.has(p.in)) part.in = p.in; else notes.push("diagram node " + p.node + ": container " + JSON.stringify(p.in) + " is not a node of this diagram"); }
            kept.add(p.node); parts.push(part);
          } else if (p.from !== undefined || p.to !== undefined) {
            if (!declared.has(p.from) || !declared.has(p.to) || p.from === p.to) { notes.push("diagram link " + JSON.stringify([p.from, p.to]) + " joins things that are not nodes of this diagram"); continue; }
            Object.assign(part, { type: "link", from: p.from, to: p.to, label: clean(p.label, 24), style: pick(p.style, LINK_STYLES, "arrow"), color: pick(p.color, COLORS, "ink") });
            parts.push(part);
          }
        }
        // a link whose node was dropped (no label) goes too, and a container that was dropped leaves its children at the top level
        parts = parts.filter((part) => part.type !== "link" || (kept.has(part.from) && kept.has(part.to)));
        for (const part of parts) if (part.in && !kept.has(part.in)) delete part.in;
        // containers must not form a loop (A in B, B in A): break it
        const containerOf = new Map(parts.filter((q) => q.type === "node").map((q) => [q.id, q.in]));
        for (const part of parts) {
          if (part.type !== "node") continue;
          const seen = new Set([part.id]); let up = part.in;
          while (up) { if (seen.has(up)) { notes.push("diagram node " + part.id + ": containers cannot contain each other; " + part.id + " is drawn at the top level"); delete part.in; containerOf.set(part.id, undefined); break; } seen.add(up); up = containerOf.get(up); }
        }
        if (!parts.some((q) => q.type === "node")) throw new Error("diagram has no nodes");
        // everything inside a container is drawn after it, however deep (the container, then what is inside it, then the next node)
        const nodeList = parts.filter((q) => q.type === "node"), byId = new Map(nodeList.map((q) => [q.id, q])), emitted = new Set(), ordered = [];
        const emit = (q) => { if (emitted.has(q.id)) return; emitted.add(q.id); if (q.in && byId.has(q.in)) emit(byId.get(q.in)); ordered.push(q); };
        nodeList.forEach(emit);
        let take = 0; parts = parts.map((q) => (q.type === "node" ? ordered[take++] : q));
        // give every node and connector an id nothing else on the board uses, and follow the renames in the links
        const rename = new Map();
        for (const part of parts) if (part.type === "node") { const id = unique(part.id); if (id !== part.id) notes.push("diagram node id " + part.id + " is already used by something else on the board; renamed to " + id); taken.add(id); rename.set(part.id, id); }
        let linkNumber = 0;
        for (const part of parts) {
          if (part.type === "node") { part.id = rename.get(part.id); if (part.in) part.in = rename.get(part.in); }
          else { part.from = rename.get(part.from); part.to = rename.get(part.to); const id = unique(diagramId + "-l" + ++linkNumber); taken.add(id); part.id = id; }
        }
        out.id = diagramId; known.add(diagramId);
        for (const part of parts) known.add(part.id); // so a later step can highlight or point to a node or a connector
        out.parts = parts;
        placement();
        break;
      }
      case "moment": out.kind = pick(raw.kind, MOMENTS, null); if (!out.kind) throw new Error("unknown moment"); out.note = clean(raw.note, 60); break;
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
    "You are the whiteboard hand of a live voice tutor, for any subject. You never speak: a teacher's VOICE does, and its words are given below. Decide, like a good human teacher, WHETHER to draw, WHAT, and WHEN.",
    "Teaching moments (one turn may mix them):",
    '- speak only: explaining, a story, a hint, encouragement, a definition that needs no picture. Draw nothing: output just {"op":"moment","kind":"speak_only"}. Do not draw only because you can.',
    "- write: the teacher states an equation, a key term or a result: write it as it is said.",
    "- draw: the teacher explains a graph or a diagram: build it piece by piece, each piece when it is mentioned.",
    '- point: the teacher refers to something already on the board: {"op":"point_to","target":"id"} (or highlight) at that moment.',
    '- wait: the teacher asks the student a question or invites an attempt. Draw only what the question needs, NEVER its answer, and end with {"op":"moment","kind":"wait"}. Nothing is drawn after it.',
    'Every step may have "cue": 2-5 words copied EXACTLY from the teacher\'s turn, where that step\'s idea begins. It is drawn when the teacher reaches its cue and never before, so the teacher can say an idea aloud first and the writing starts when they introduce it. Order steps as the teacher says things.',
    'References: if the teacher\'s words refer to something visible ("look at...", "this point", "the curve I drew", "as you can see"), that thing must already be on the board by then: put "ref" (those exact words) on the step that creates it, and the pen will start early enough to finish first. Never let the teacher refer to something your steps do not draw.',
    "A pen draws everything stroke by stroke: key words and short phrases, never sentences; at most 6 steps for this turn (a diagram may use up to 14 parts). Output ONLY JSON objects, one per line (JSON Lines), in drawing order. No prose, no code fences.",
    "You never choose positions or sizes: the board places everything in free space, aligns equations, pads text inside shapes and starts a new page by itself when needed.",
    "Steps (fields in braces are optional; every step may also have cue and ref):",
    '{"op":"write","kind":"text"|"math","content":"...","size":"title"|"body"|"small","color":C,"id":"name",near:"id",side:"right"|"below",calc:"name"}   calc: give every line of one calculation the same name: the lines stay together and their = signs line up.',
    '{"op":"graph","id":"g","w":420,"h":300,"xmin","xmax","ymin","ymax","xlabel","ylabel","grid":true}  then  {"op":"plot","graph":"g","fn":"x^2-3*x+1","color":C,"label":"short"}  {"op":"point","graph":"g","px","py","label","color":C}. Create each plot or point when the teacher mentions it. Labels are placed beside what they name.',
    '{"op":"diagram","id":"d1","title":"Water cycle","layout":"row"|"column"|"grid"|"cycle","parts":[{"node":"sun","label":"Sun","shape":"circle","cue":"..."},{"node":"sea","label":"Ocean","shape":"rounded","cue":"..."},{"from":"sun","to":"sea","label":"heats","style":"arrow"|"line"|"dashed","cue":"..."}]}. Nodes are things, links connect them. shape: box, rounded, ellipse, circle (short labels only) or none. A node can hold others: {"node":"cell","label":"Cell"} and then {"node":"nuc","label":"Nucleus","in":"cell"}. Parts are drawn in the order listed, each when its cue is reached. Keep diagrams SMALL and clean: a title, at most 5 nodes, labels under 4 words, one idea (the writing is large and is never shrunk, so a page holds no more). No coordinates. For plain notes use write, not boxes.',
    '{"op":"highlight","target":"id","color":C}  {"op":"point_to","target":"id"}  {"op":"erase","target":"id"}  {"op":"correct","target":"id","with":{a write step}}  {"op":"pause","ms":500}  {"op":"moment","kind":"speak_only"|"write"|"draw"|"point"|"wait","note":"why"}',
    '{"op":"new_page","title":"short"}  {"op":"go_to_page","page":"p1"|"previous"|"latest"}',
    "C is one of ink, blue, red, green, amber, violet (ink by default).",
    "Notebook: pages p1, p2, ... Start a new page (new_page) when the teacher begins a new topic or section, or when the summary says the live page is nearly full. Never erase a page to change topic. To refer back: go_to_page, then point_to the element, then go_to_page latest. Point and highlight only at things listed in the summary, including diagram nodes. Add to the notebook; never redraw what is there.",
    "Math (kind=math) is LaTeX, supported: + - = < > ( ) [ ] / digits, letters, ^ and _ for powers and indices, \\frac{a}{b}, \\sqrt{x}, \\sqrt[3]{x}, \\sum_{i=1}^{n}, \\int_a^b, \\lim_{x \\to 0}, \\sin \\cos \\tan \\log \\ln, \\pm \\times \\cdot \\div \\leq \\geq \\neq \\approx \\infty \\to \\rightarrow \\Rightarrow \\circ \\partial \\nabla, Greek (\\alpha \\beta \\pi \\theta \\Delta ...), \\vec{v} \\bar{x} \\hat{x}, \\text{words}, \\left( \\right). No matrices, \\begin{...}, tables or colors inside LaTeX: write separate lines instead. Chemistry as math, e.g. H_2O.",
    "Text may be in the language the teacher speaks, using Latin letters with accents. Graphs: plot with explicit * and ^ (2*x+1, sin(x), x^2).",
    "Teach like a patient human at a board: the voice says what is about to be written, the pen writes it while the voice goes on with that same idea, and the next idea waits for the next step. Write ONE idea per step and give each its own cue (the words that introduce it); never put several solution steps under one cue, and never draw a step whose words the teacher has not reached. A pen is slower than a voice: about 3 to 6 seconds for an equation. If the teacher narrates more steps than can be written, write the key expressions, not everything, and leave later steps to the next turn. If the teacher is only introducing an example verbally, draw nothing yet (speak_only). Keep writing short: key terms and the equation, not the sentence around it.",
    "Give the first step quickly: the pen starts as soon as your first line arrives.",
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
  /**
   * What the pencil has actually been doing, in words for the planner: closed-loop pacing, so a pen that keeps falling
   * behind the voice gets fewer, shorter steps, and one that keeps up is not slowed down for no reason.
   * pen = { steps, behind, worstWordsAhead, penRatio } (see Whiteboard.pacing()).
   */
  function pacingNote(pen) {
    if (!pen || !pen.steps) return "";
    const ratio = pen.penRatio ? " The pencil has been taking " + pen.penRatio.toFixed(1) + "x its estimated time." : "";
    if (pen.behind >= 2 || pen.worstWordsAhead >= 12) return "Pacing: in this lesson the voice has often run ahead of the pencil (" + pen.behind + " of " + pen.steps + " steps, up to " + pen.worstWordsAhead + " words ahead)." + ratio + " Write fewer and shorter steps, one idea each, and give each a cue on the words that INTRODUCE it, not the words that finish it.";
    return "Pacing: the pencil has kept up with the voice so far (" + pen.steps + " steps)." + ratio + " Keep one idea per step.";
  }

  function buildPlannerMessage(turns, notebook, hint, handled, partial, pen) {
    const recent = (turns || []).slice(-6).map((t) => (t.role === "teacher" ? "Teacher: " : "Student: ") + String(t.text).slice(0, 500));
    const lastTeacher = [...(turns || [])].reverse().find((t) => t.role === "teacher"), said = lastTeacher ? String(lastTeacher.text) : "";
    const references = findReferences(said);
    const notes = [];
    if (references.length) notes.push("Visual references in the teacher's words (each needs a step with \"ref\" that makes it exist in time): " + references.map((r) => '"' + r + '"').join(", ") + ".");
    // (an early plan sees only the first sentence: a rhetorical opener is not the end of the turn, so no question note then)
    if (!partial && endsWithQuestion(said)) notes.push("The teacher's turn ends with a question to the student: draw only what the question needs, never the answer, and end with a wait moment.");
    const pacing = pacingNote(pen); if (pacing) notes.push(pacing);
    const request = hint ? "\n\nThe teacher also asked for this to be shown on the board (draw it step by step, shorter if it is long): " + clip(hint, 600) : "";
    const continued = handled ? "\n\nThe start of the teacher's latest turn is already on the board: \"" + clip(handled, 300) + "\". Only plan what comes after it." : "";
    return "Notebook:\n" + summariseNotebook(notebook) + "\n\nConversation (oldest first):\n" + recent.join("\n") + (notes.length ? "\n\n" + notes.join("\n") : "") + continued + request;
  }

  /**
   * Ask Claude what to draw and receive the steps as they are written. Each complete line is validated and handed to
   * onOps straight away, so the first stroke can start while Claude is still writing the rest.
   * Resolves to { ops, errors, usage } when the stream ends. Throws on network or auth problems (error.status is set
   * for HTTP errors) so the caller can fall back to the classic board; an aborted request throws an AbortError.
   */
  async function planBoardStream({ apiKey, turns, notebook, context, hint, handled, partial, pen, fetchImpl, signal, model, onOps }) {
    const doFetch = fetchImpl || fetch;
    const response = await doFetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal,
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({
        model: model || PLANNER_MODEL, max_tokens: 1200, stream: true, system: PLANNER_SYSTEM,
        messages: [{ role: "user", content: buildPlannerMessage(turns, notebook, hint, handled, partial, pen) }],
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
      const { op, error, notes } = validator.validate(parsed);
      if (error) errors.push(error);
      for (const note of notes || []) errors.push(note);
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
    reset() { this.text = ""; this.messageAt = null; this.startedAt = null; this.endedAt = null; this.chunks = []; this.chars = []; this.times = []; this.updates = 0; this.cache = new Map(); }
    setText(text, now) { this.text = String(text || ""); this.cache.clear(); if (this.messageAt == null && this.text) this.messageAt = now; }
    start(now) { if (this.startedAt == null) this.startedAt = now; this.endedAt = null; }
    end(now) { this.endedAt = now; }
    /**
     * A chunk of aligned speech began playing at `now`. startsMs = each character's start offset in the chunk, if known.
     * eventId orders chunks: a chunk that arrives late (lower id than one already received) is put back in its place,
     * so the spoken text is never scrambled.
     */
    aligned(text, startsMs, now, eventId) {
      const chars = Array.from(String(text || ""));
      const usable = Array.isArray(startsMs) && startsMs.length === chars.length && startsMs.every((v, i) => Number.isFinite(v) && (i === 0 || v >= startsMs[i - 1]));
      this.chunks.push({ eventId: Number.isFinite(eventId) ? eventId : null, chars, times: chars.map((_, i) => now + (usable ? startsMs[i] : 0)) });
      const ordered = this.chunks.every((c) => c.eventId !== null) ? [...this.chunks].sort((x, y) => x.eventId - y.eventId) : this.chunks;
      this.chars = ordered.flatMap((c) => c.chars); this.times = ordered.flatMap((c) => c.times);
      this.updates++;
      if (this.startedAt == null) this.startedAt = now;
    }
    get hasAlignment() { return this.updates > 0; }
    estimateMs(prefix) { return Math.round((String(prefix).trim().split(/\s+/).filter(Boolean).length / this.wordsPerSecond) * 1000); }

    /**
     * { ready, reason, waitMs } for a step at time `now`.
     * `cue` is where the idea is introduced: the step starts then. `ref` (optional) is where the teacher REFERS to what
     * the step draws: the step must be finished by then, so it may start earlier, `refLeadMs` (how long it takes)
     * before that phrase. The earlier of the two moments releases the step.
     */
    evaluate(cue, now, options) {
      const o = options || {}, ref = o.ref;
      if (!cue && !ref) return { ready: true, reason: "no-cue" };
      if (this.endedAt != null) return { ready: true, reason: "speech-ended" };
      const results = [];
      if (cue) results.push(this.phrase(cue, now, Math.max(0, o.cueLeadMs || 0))); // a long piece of writing starts a little early
      if (ref) { const r = this.phrase(ref, now, Math.max(0, o.refLeadMs || 0)); if (r.ready !== null) r.reason = "ref:" + r.reason; results.push(r); }
      const ready = results.find((r) => r.ready === true);
      if (ready) return ready;
      const waiting = results.filter((r) => r.ready === false);
      if (waiting.length) return { ready: false, reason: waiting[0].reason, waitMs: Math.min(...waiting.map((r) => r.waitMs)) };
      return { ready: true, reason: "cue-not-found" };
    }

    /** One phrase: ready true/false, or ready null if it cannot be found anywhere (so it says nothing). */
    phrase(cue, now, extraLeadMs) {
      const lead = this.leadMs + extraLeadMs;
      if (this.updates > 0) { // exact: the words are in the speech that is playing
        const spoken = this.chars.join(""), found = locateCue(spoken, cueWords(cue).slice(0, 2).join(" "));
        if (found) {
          const at = this.times[Array.from(spoken.slice(0, found.start)).length] - lead;
          return now >= at ? { ready: true, reason: "aligned" } : { ready: false, reason: "aligned-soon", waitMs: at - now };
        }
      }
      const where = this.where(cue);
      if (!where) return { ready: null, reason: "cue-not-found" };
      const base = this.startedAt != null ? this.startedAt : this.messageAt != null ? this.messageAt + 800 : null;
      if (base == null) return { ready: false, reason: "waiting-for-speech", waitMs: 200 };
      const due = base + this.estimateMs(this.text.slice(0, where.start)) - lead + (this.updates > 0 ? this.graceMs : 0);
      return now >= due ? { ready: true, reason: this.updates > 0 ? "estimate-after-grace" : "estimate" } : { ready: false, reason: "estimate-wait", waitMs: due - now };
    }
    where(cue) { if (!this.cache.has(cue)) this.cache.set(cue, locateCue(this.text, cue)); return this.cache.get(cue); }

    /**
     * How many words has the teacher spoken since she started this phrase, at time `now`? From the audio alignment when
     * there is any, otherwise estimated from the time elapsed. null if the phrase's time is unknown. Used to measure
     * "the teacher explained N words before the pencil had written it".
     */
    wordsSince(phrase, now) {
      const at = this.timeOf(phrase);
      if (at == null || now <= at) return at == null ? null : 0;
      if (this.updates > 0 && this.times.length) {
        let words = 0, inWord = false;
        for (let i = 0; i < this.chars.length; i++) {
          if (this.times[i] < at || this.times[i] > now) { inWord = false; continue; }
          const letter = /[\p{L}\p{N}]/u.test(this.chars[i]);
          if (letter && !inWord) words++;
          inWord = letter;
        }
        return words;
      }
      return Math.round(((now - at) / 1000) * this.wordsPerSecond);
    }

    /** When (on the same clock as `now`) does the teacher start saying this phrase? null if unknown. Used to measure lateness. */
    timeOf(phrase) {
      if (!phrase) return null;
      if (this.updates > 0) {
        const spoken = this.chars.join(""), found = locateCue(spoken, cueWords(phrase).slice(0, 2).join(" "));
        if (found) return this.times[Array.from(spoken.slice(0, found.start)).length];
      }
      const where = this.where(phrase), base = this.startedAt != null ? this.startedAt : this.messageAt != null ? this.messageAt + 800 : null;
      return where && base != null ? base + this.estimateMs(this.text.slice(0, where.start)) : null;
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

  /**
   * Phrases in the teacher's words that refer to something VISIBLE ("look at the vertex", "this point", "as you can
   * see", "the curve I just drew"). Whatever they refer to has to be on the board by the time they are spoken, so the
   * planner is told about them. Returns up to 4 short phrases.
   */
  function findReferences(text) {
    const patterns = [
      /\b(?:look at|take a look at|have a look at|see|notice|observe|check)\s+(?:the|this|that|these|those|my|our)\s+(?:[\p{L}\p{N}'-]+\s*){1,4}/giu,
      /\bas you can see\b/giu,
      /\b(?:this|that|these|those|right here|here is|here's)\s+(?:point|line|curve|arrow|equation|term|graph|diagram|box|circle|step|part|angle|axis|shape|label|number|value|triangle|parabola)s?\b/giu,
      /\b(?:i|we)\s+(?:just\s+)?(?:drew|wrote|marked|circled|added|put)\b[^.?!]{0,30}/giu,
    ];
    const found = [];
    for (const pattern of patterns) for (const match of String(text || "").matchAll(pattern)) {
      const words = match[0].trim().split(/\s+/).slice(0, 6).join(" ").replace(/[,.;:!?]+$/, "");
      if (words && !found.some((f) => f.toLowerCase() === words.toLowerCase())) found.push(words);
    }
    return found.slice(0, 4);
  }
  /** Does the teacher's turn end with a question to the student? Then the board must not give away the answer. */
  function endsWithQuestion(text) {
    const sentences = String(text || "").trim().split(/(?<=[.!?])\s+/);
    return /\?\s*["')]*$/.test(sentences[sentences.length - 1] || "");
  }

  /* ---------- Conversation latency: one timeline per turn (pure: time is passed in) ---------- */

  /**
   * Records when each step of a conversational turn happened (monotonic ms, e.g. performance.now()) and turns them into
   * the numbers a person needs to see where the time goes. Only events the SDK really reports are marked; anything it
   * does not report stays unavailable and is shown as unavailable, never estimated.
   *
   * Marks: studentStart / studentStop (from voice activity scores), typed (a typed message was sent), transcript (the
   * final transcription arrived), agentText (first teacher text), audioChunk (first teacher audio data received,
   * WebSocket only), audible (first teacher audio actually playing), plannerRequest, plannerFirstOp, penStart.
   */
  class TurnTimer {
    constructor(options) {
      const o = options || {};
      this.vadThreshold = o.vadThreshold == null ? 0.5 : o.vadThreshold;
      this.vadHoldMs = o.vadHoldMs == null ? 400 : o.vadHoldMs; // silence this long means the student stopped
      this.turns = []; this.current = null; this.speaking = false; this.speakingSince = null; this.latched = false; this.lastHighAt = null; this.pingMs = null;
    }
    begin(kind, now) {
      this.current = { kind, startedAt: now, marks: {}, detail: {}, plannerCalls: 0, plannerSkipped: 0, hints: [], longTasks: [], notes: [] };
      this.turns.push(this.current); if (this.turns.length > 30) this.turns.shift();
      return this.current;
    }
    // A turn is finished once the teacher is audible: the next sign of the student (or a new message) starts a new one.
    finished(turn) { return !turn || turn.marks.audible !== undefined; }
    teacherStarted(turn) { return !!turn && ["agentText", "audioChunk", "audible"].some((k) => turn.marks[k] !== undefined); }
    /** One voice-activity score. Marks studentStart on the first high score and studentStop after enough silence. */
    vad(score, now) {
      this.settle(now);
      if (score >= this.vadThreshold) {
        if (this.latched) return; // a score that never fell (echo): ignored until it does
        this.lastHighAt = now;
        if (!this.speaking) {
          this.speaking = true; this.speakingSince = now;
          if (!this.current || this.teacherStarted(this.current) || this.current.marks.transcript !== undefined) this.begin("voice", now);
          if (this.current.marks.studentStart === undefined) this.current.marks.studentStart = now;
          delete this.current.marks.studentStop; // speaking again within the same turn: the stop moves
        }
      } else { this.latched = false; this.settle(now); }
    }
    /** Called on every score and mark: has the student been silent long enough to have stopped? */
    settle(now) {
      if (this.speaking && this.speakingSince !== null && now - this.speakingSince > 60000) { this.speaking = false; this.latched = true; if (this.current && this.current.marks.studentStop === undefined) this.current.marks.studentStop = this.lastHighAt; } // a score that never falls (echo) is not a 60 s utterance
      if (this.speaking && this.lastHighAt !== null && now - this.lastHighAt >= this.vadHoldMs) {
        this.speaking = false;
        if (this.current && this.current.marks.studentStop === undefined) this.current.marks.studentStop = this.lastHighAt;
      }
    }
    /** First occurrence of a named moment in the current turn. */
    mark(name, now, detail) {
      this.settle(now);
      if (name === "typed") { this.begin("typed", now); this.current.marks.studentStop = now; this.current.marks.typed = now; return; }
      // A transcript opens a new student turn unless the current turn is a student turn still waiting for its transcript.
      if (!this.current) this.begin(name === "transcript" ? "voice" : "agent", now);
      else if (name === "transcript" && (this.current.marks.transcript !== undefined || this.teacherStarted(this.current))) this.begin("voice", now);
      const turn = this.current;
      if (turn.marks[name] === undefined) { turn.marks[name] = now; if (detail) turn.detail[name] = detail; }
    }
    /** The teacher became audible. A playback event (exact) replaces an earlier guess from the speaking mode, once. */
    audible(now, source) {
      const turn = this.current;
      if (turn && turn.marks.audible !== undefined) {
        if (source === "audio playback event" && turn.detail.audible === "speaking mode" && now - turn.marks.audible < 3000) { turn.marks.audible = now; turn.detail.audible = source; }
        return; // only the first audible moment of a turn counts
      }
      this.mark("audible", now, source);
    }
    count(name) { if (this.current) this.current[name] = (this.current[name] || 0) + 1; }
    hint(kind, now) { if (this.current) this.current.hints.push({ kind, at: now }); }
    longTask(startMs, durationMs) { if (this.current && startMs >= this.current.startedAt) this.current.longTasks.push(durationMs); }
    ping(ms) { if (Number.isFinite(ms)) this.pingMs = ms; }

    /** The rows to show for a turn: { key, label, ms | null, note }. ms is null when it cannot be measured. */
    report(turn) {
      const t = turn || this.current; if (!t) return null;
      const m = t.marks, span = (from, to) => (m[from] !== undefined && m[to] !== undefined && m[to] >= m[from] ? Math.round(m[to] - m[from]) : null); // events that arrive out of order are unavailable, not negative
      const rows = [
        { key: "stopToAudible", label: "You stopped speaking to the first audible response", ms: span("studentStop", "audible"), note: m.studentStop === undefined ? "needs voice-activity events from the SDK (not received)" : m.audible === undefined ? "the teacher has not been heard yet" : (t.detail.audible || "") },
        { key: "stopToTranscript", label: "You stopped speaking to the final transcript", ms: span("studentStop", "transcript"), note: "includes end-of-turn detection and speech-to-text; the SDK does not report them separately" },
        { key: "transcriptToText", label: "Final transcript to first teacher text", ms: span("transcript", "agentText"), note: t.detail.agentText ? "from " + t.detail.agentText : "needs agent_chat_response_part or the final message" },
        { key: "transcriptToAudioChunk", label: "Final transcript to first teacher audio received", ms: span("transcript", "audioChunk"), note: m.audioChunk === undefined ? "audio data events are WebSocket only" : "" },
        { key: "chunkToAudible", label: "First audio received to audible", ms: span("audioChunk", "audible"), note: "browser buffering and playback" },
        { key: "textToPlannerRequest", label: "First teacher text to whiteboard planner request", ms: span("agentText", "plannerRequest"), note: "" },
        { key: "plannerLatency", label: "Whiteboard planner request to first drawing step", ms: span("plannerRequest", "plannerFirstOp"), note: "Anthropic, separate from the voice connection" },
        { key: "audibleToPen", label: "First audible to pencil writing", ms: span("audible", "penStart"), note: "includes waiting for the step's cue in the teacher's words, on purpose" },
      ];
      return { kind: t.kind, rows, verdict: this.verdict(t), plannerCalls: t.plannerCalls, plannerSkipped: t.plannerSkipped, hints: t.hints.length, longestTaskMs: t.longTasks.length ? Math.round(Math.max(...t.longTasks)) : 0, pingMs: this.pingMs, unavailable: ["when ElevenLabs begins processing the turn", "end-of-turn detection on its own (the turn-taking timeout), apart from transcription"] };
    }
    /** Which measured part of stop-to-audible was the largest? Only from measured numbers; never a guess. */
    verdict(t) {
      const m = t.marks, parts = [];
      const add = (label, from, to) => { if (m[from] !== undefined && m[to] !== undefined && m[to] >= m[from]) parts.push({ label, ms: Math.round(m[to] - m[from]) }); };
      add("microphone, voice activity and end-of-turn detection, then speech-to-text (ElevenLabs turn-taking settings and transcription)", "studentStop", "transcript");
      if (m.audioChunk !== undefined) {
        add("the agent's LLM and voice generation (ElevenLabs agent)", "transcript", "audioChunk");
        add("browser audio buffering and playback", "audioChunk", "audible");
      } else add("the agent's LLM, voice generation and playback together (audio events are not available on this connection)", "transcript", "audible");
      if (!parts.length) return { text: "not enough measured events yet", parts };
      parts.sort((a, b) => b.ms - a.ms);
      const total = parts.reduce((sum, p) => sum + p.ms, 0), top = parts[0];
      const competing = t.hints.filter((h) => m.transcript !== undefined && m.audible !== undefined && h.at >= m.transcript - 500 && h.at <= m.audible);
      return { text: "largest part: " + top.label + " (" + top.ms + " ms, " + Math.round((100 * top.ms) / Math.max(1, total)) + "% of the measured time)" + (competing.length ? "; " + competing.length + " session context update(s) were sent in this window" : ""), parts, competingHints: competing.length };
    }
    /** The middle of stop-to-audible over the last turns that measured it (ms), or null. */
    median(key) {
      const values = this.turns.map((t) => (this.report(t).rows.find((r) => r.key === key) || {}).ms).filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
      return values.length ? values[Math.floor(values.length / 2)] : null;
    }
  }

  /**
   * Text for the agent's own LLM, sent as a CONTEXTUAL UPDATE during the session (it never changes the agent's saved
   * configuration and never interrupts speech). It can only shape what the agent says NEXT: the voice that is already
   * playing cannot be slowed or paused from here.
   */
  const TEACHING_STYLE_NOTE = "Whiteboard teaching style for this session: you teach with a whiteboard that is written by hand while you speak, and handwriting is slower than speech. Introduce an example out loud first. Then say what you are about to write and keep talking about that one thing while it is written. Explain ONE step at a time, in one or two short sentences, then wait or ask a short question before the next step. Do not refer to an equation, point or graph as visible until you have said you are writing it. Name things (the minus four, the vertex) instead of saying this or here. After a question, stop and let the student answer. Stay conversational and natural; do not slow your voice down.";
  function boardStatusNote(notebook, pen) {
    const live = notebook && notebook.pages && notebook.pages.find((p) => p.id === notebook.live);
    const items = live ? live.items.filter((i) => i.text).slice(-6).map((i) => '"' + clip(i.text, 40) + '"') : [];
    const lag = pen && pen.steps && (pen.behind >= 2 || pen.worstWordsAhead >= 12) ? " The pencil has been writing slower than you speak, so say less per step and give it time." : "";
    return "Board status: " + (items.length ? "written so far: " + items.join(", ") + "." : "nothing written yet.") + lag;
  }

  /* ---------- Long-session health: which layer has gone quiet? (pure: time is passed in) ---------- */

  /**
   * Watches the signals the SDK gives about a running conversation and says, in plain words and by layer, what looks
   * wrong: the connection, the microphone, voice-activity updates, transcription, the agent's answer, audio playback, the
   * page itself. It only reports what it measured and never claims the microphone works. It keeps a ring of numeric
   * samples (no speech, no text) so a long lesson can be inspected afterwards.
   */
  class SessionHealth {
    constructor(options) {
      const o = options || {};
      this.vadSilenceMs = o.vadSilenceMs || 6000;         // no voice-activity update for this long, after they had been arriving
      this.transcriptStallMs = o.transcriptStallMs || 8000; // spoke, stopped, and no transcript for this long
      this.answerStallMs = o.answerStallMs || 15000;      // transcript received, and no teacher text or audio for this long
      this.audioStallMs = o.audioStallMs || 10000;        // teacher text received, and still no audio for this long
      this.zeroMicMs = o.zeroMicMs || 45000;              // input level exactly zero for this long
      this.hiddenMs = o.hiddenMs || 3000;
      this.jankMs = o.jankMs || 500;
      this.maxSamples = o.maxSamples || 240;
      this.startedAt = null; this.connected = false; this.everConnected = false; this.closedReason = null; this.closedAt = null;
      this.mode = "idle"; this.lastVadAt = null; this.vadSeen = false; this.voicedSince = null; this.lastVoicedAt = null; this.heardAt = null; this.heardMs = 0;
      this.transcriptAt = null; this.textAt = null; this.audibleAt = null; this.studentTurns = 0; this.hidden = false; this.hiddenAt = null;
      this.micLast = null; this.micZeroSince = null; this.micSeen = false; this.deviceChanges = []; this.lagMs = 0; this.lagAt = null;
      this.vadWhileTeacher = 0; this.teacherVadChecks = 0; this.samples = [];
    }
    open(now) { // a new session: nothing from the old one may raise an alarm in it
      this.startedAt = this.startedAt == null ? now : this.startedAt; this.connected = true; this.everConnected = true; this.closedReason = null; this.closedAt = null;
      this.lastVadAt = null; this.vadSeen = false; this.voicedSince = null; this.lastVoicedAt = null; this.heardAt = null; this.heardMs = 0; this.transcriptAt = null; this.textAt = null; this.audibleAt = null;
      this.micLast = null; this.micZeroSince = null; this.micSeen = false; this.vadWhileTeacher = 0; this.teacherVadChecks = 0; this.lagAt = null; this.mode = "listening";
    }
    close(now, reason) { this.connected = false; this.closedAt = now; this.closedReason = reason || "closed"; this.mode = "idle"; }
    setMode(mode, now) { this.mode = mode; }
    vad(score, now) {
      this.lastVadAt = now; this.vadSeen = true;
      if (this.mode === "speaking") { this.teacherVadChecks++; if (score >= 0.5) this.vadWhileTeacher++; if (this.teacherVadChecks >= 400) { this.teacherVadChecks = Math.round(this.teacherVadChecks / 2); this.vadWhileTeacher = Math.round(this.vadWhileTeacher / 2); } } // recent behaviour counts, not the whole lesson
      if (score >= 0.5) { if (this.voicedSince === null) this.voicedSince = now; this.lastVoicedAt = now; }
      else if (this.voicedSince !== null && this.lastVoicedAt !== null && now - this.lastVoicedAt >= 400) { // the student stopped
        if (this.lastVoicedAt - this.voicedSince >= 700 && this.mode !== "speaking") { this.heardAt = this.lastVoicedAt; this.heardMs = this.lastVoicedAt - this.voicedSince; this.studentTurns++; }
        this.voicedSince = null;
      }
    }
    transcript(now) { this.transcriptAt = now; this.heardAt = null; this.textAt = null; this.audibleAt = null; }
    agentText(now) { if (this.textAt === null || this.textAt < (this.transcriptAt || 0)) this.textAt = now; }
    audible(now) { this.audibleAt = now; }
    visibility(hidden, now) { this.hidden = hidden; this.hiddenAt = hidden ? now : null; }
    deviceChange(now) { this.deviceChanges.push(now); if (this.deviceChanges.length > 20) this.deviceChanges.shift(); }
    mic(volume, now) { // the SDK's input level, if it has one; exactly zero for a long time means no signal at all
      if (!Number.isFinite(volume)) return; this.micSeen = true; this.micLast = volume;
      if (volume === 0) { if (this.micZeroSince === null) this.micZeroSince = now; } else this.micZeroSince = null;
    }
    jank(lagMs, now) { this.lagMs = lagMs; this.lagAt = now; }

    /** What looks wrong right now: [{ id, level, layer, message }], most important first. */
    diagnose(now) {
      const out = [], sec = (ms) => Math.round(ms / 1000);
      if (!this.connected) {
        if (this.everConnected) out.push({ id: "connection", level: "error", layer: "connection", message: "The connection to ElevenLabs closed" + (this.closedAt != null ? " " + sec(now - this.closedAt) + " s ago" : "") + " (" + this.closedReason + "). The board and your notes are kept; reconnect to continue." });
        return out;
      }
      if (this.hidden && this.hiddenAt !== null && now - this.hiddenAt >= this.hiddenMs) out.push({ id: "hidden", level: "warn", layer: "browser", message: "This tab has been in the background for " + sec(now - this.hiddenAt) + " s. Browsers throttle timers and can suspend audio in background tabs, which delays or drops what the teacher hears." });
      if (this.vadSeen && this.lastVadAt !== null && now - this.lastVadAt >= this.vadSilenceMs && !this.hidden) out.push({ id: "vad", level: "warn", layer: "microphone / voice activity", message: "No voice-activity updates from ElevenLabs for " + sec(now - this.lastVadAt) + " s, although they were arriving earlier. The microphone may be muted or disconnected, the browser may have suspended audio, or the connection has stalled. If you are speaking now, the teacher is not hearing you." });
      if (this.micSeen && this.micZeroSince !== null && now - this.micZeroSince >= this.zeroMicMs) out.push({ id: "mic-zero", level: "warn", layer: "microphone", message: "The microphone input level has been exactly zero for " + sec(now - this.micZeroSince) + " s: no signal at all (muted, unplugged, taken by another app, or a noise-gated microphone that reports nothing in silence)." });
      if (this.heardAt !== null && this.transcriptAt !== null && this.transcriptAt >= this.heardAt) { /* answered */ }
      else if (this.heardAt !== null && now - this.heardAt >= this.transcriptStallMs) out.push({ id: "transcript", level: "warn", layer: "transcription / end-of-turn", message: "ElevenLabs saw you speak for " + (this.heardMs / 1000).toFixed(1) + " s, but no transcript has arrived " + sec(now - this.heardAt) + " s after you stopped (ignore this if it was only noise). End-of-turn detection or speech-to-text is slow or stalled on the agent side." });
      if (this.transcriptAt !== null && this.textAt === null && this.audibleAt === null && now - this.transcriptAt >= this.answerStallMs) out.push({ id: "answer", level: "warn", layer: "agent (LLM / voice generation)", message: "Your words were transcribed " + sec(now - this.transcriptAt) + " s ago and the teacher has not answered. The agent is slow or stalled (not the whiteboard: it only starts after the teacher's text)." });
      if (this.textAt !== null && this.audibleAt === null && this.mode !== "speaking" && now - this.textAt >= this.audioStallMs) out.push({ id: "playback", level: "warn", layer: "audio playback", message: "The teacher's text arrived " + sec(now - this.textAt) + " s ago but no audio has played." });
      if (this.lagAt !== null && this.lagMs >= this.jankMs && now - this.lagAt < 30000) out.push({ id: "jank", level: "warn", layer: "this page", message: "This page's main thread was blocked for " + Math.round(this.lagMs) + " ms recently. That delays the voice connection's audio handling (client-side)." });
      if (this.teacherVadChecks >= 20 && this.vadWhileTeacher / this.teacherVadChecks >= 0.3) out.push({ id: "echo", level: "info", layer: "microphone", message: "Voice activity was detected during " + Math.round((100 * this.vadWhileTeacher) / this.teacherVadChecks) + "% of the time the teacher was talking: the microphone may be hearing the teacher's voice from the speakers (headphones avoid this, and avoid false interruptions)." });
      if (this.deviceChanges.length && now - this.deviceChanges[this.deviceChanges.length - 1] < 60000) out.push({ id: "device", level: "info", layer: "microphone", message: "An audio device was added or removed " + sec(now - this.deviceChanges[this.deviceChanges.length - 1]) + " s ago; the browser may have switched microphones." });
      const rank = { error: 0, warn: 1, info: 2 };
      return out.sort((a, b) => rank[a.level] - rank[b.level]);
    }
    /** One numeric snapshot for the ring (no speech or text), e.g. every 15 s. `extra` carries page numbers. */
    sample(now, extra) {
      const snap = { t: Math.round((now - (this.startedAt == null ? now : this.startedAt)) / 1000), connected: this.connected, mode: this.mode, turns: this.studentTurns,
        vadAgeMs: this.lastVadAt == null ? null : Math.round(now - this.lastVadAt), mic: this.micLast, lagMs: Math.round(this.lagMs), findings: this.diagnose(now).map((f) => f.id), ...(extra || {}) };
      this.samples.push(snap); if (this.samples.length > this.maxSamples) this.samples.shift();
      return snap;
    }
  }

  /**
   * Is a teacher turn worth a planner call? Short acknowledgements ("Great!", "Okay, go on.") have nothing to draw, so
   * asking Claude about them only adds a request, tokens and a wasted "nothing to draw" round trip.
   */
  function worthPlanning(text) {
    const said = String(text || "").trim(), words = said.split(/\s+/).filter(Boolean);
    if (!words.length) return false;
    if (/[\d=+^]/.test(said)) return true;       // a number or an equation may be worth showing
    if (words.length > 4) return true;
    const acknowledgement = /^(great|good|nice|okay|ok|right|sure|yes|yeah|yep|exactly|correct|perfect|excellent|well done|alright|all right|got it|go on|i see|thanks|thank you|hello|hi|hmm|mm|of course|no problem|welcome)\b/i;
    return !acknowledgement.test(said); // short but not an acknowledgement ("Let's draw it.") is planned
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
    locateCue, findReferences, endsWithQuestion, pacingNote, boardStatusNote, TEACHING_STYLE_NOTE, TurnTimer, SessionHealth, worthPlanning, SpeechClock, createOrderedDelivery, MOMENTS, SIDES, PAGE_KEYWORDS,
    estimateSpeechMs, normalizeSpeech, cueSpoken, niceTicks,
  };
});
