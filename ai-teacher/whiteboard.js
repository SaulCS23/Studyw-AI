/* Whiteboard renderer: a multi-page notebook the teacher writes and draws in by hand.
 *
 *  - Text, numbers and equations are HANDWRITTEN: each letter is a few pen strokes (whiteboard-hand.js) and
 *    each stroke draws itself while a pencil tip travels along it, lifts and moves to the next stroke.
 *  - Axes, curves, arrows and shapes draw themselves the same way; graph numbers and labels are written too.
 *  - Nothing overlaps: every element is measured BEFORE it is drawn and placed in free space by the layout engine
 *    (whiteboard-layout.js). If a page has no room, a new page is started first. Claude never chooses positions.
 *  - The notebook keeps every page. The teacher writes on the "live" page; the student can look at any page
 *    without taking control away from the teacher, and return to the live page with one click.
 *  - Steps are tied to the teacher's words: a step with a cue waits until the teacher reaches that phrase
 *    (exactly, when ElevenLabs sends audio alignment; estimated otherwise) before the pen starts.
 *  - cancelPending() is the "student interrupted" button: the pen finishes the stroke it is on, the rest of
 *    the queue is dropped, and what is already on the page stays.
 *  - Nothing from the AI is ever inserted as HTML.
 *
 * Needs whiteboard-core.js, whiteboard-hand.js, whiteboard-layout.js and whiteboard-diagram.js first.
 */
(function (root) {
  "use strict";
  const core = root.WhiteboardCore, hand = root.WhiteboardHand, Layout = root.WhiteboardLayout, Diagram = root.WhiteboardDiagram;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const { BOARD } = core;
  const MARGIN = Layout.DEFAULTS.margin;

  const INK = { ink: ["#24313a", "#eef3ea"], blue: ["#2459c4", "#8db8ff"], red: ["#c2412d", "#ff8d78"], green: ["#2c7a4b", "#7bd49f"], amber: ["#a8690a", "#f0c35a"], violet: ["#7440b8", "#c9a8f7"] };
  const FONT_SIZE = { title: 46, body: 34, small: 28 };
  const TEXT_WIDTH = { title: 920, body: 560, small: 560 }; // how wide a line of text may get before it wraps
  const CALC_RESERVE = 150;                                 // room kept below the first line of a calculation
  const STROKE = 4;
  // Pen speeds in board units per second: how fast a hand moves when writing, drawing a line, or tracing a curve.
  const SPEED = { write: 320, line: 520, curve: 420, axes: 650, labelBoost: 2.2 };

  const STYLE = `
.wb{--wb-paper:#fbfcfa;${Object.entries(INK).map(([n, c]) => `--wb-${n}:${c[0]};`).join("")}display:block;position:relative;background:var(--wb-paper)}
@media (prefers-color-scheme:dark){.wb{--wb-paper:#1e2b27;${Object.entries(INK).map(([n, c]) => `--wb-${n}:${c[1]};`).join("")}}}
.wb-svg{display:block;width:100%;height:100%}
.wb-text{display:inline-block;font-family:var(--hand,"Kalam","Comic Sans MS","Segoe Print",cursive);line-height:1.25;white-space:normal;overflow-wrap:anywhere}
.wb-text.wb-raw{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.8em}
@keyframes wb-page-in{from{opacity:0}to{opacity:1}}
`;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const linear = (t) => t;
  const colorVar = (name) => `var(--wb-${INK[name] ? name : "ink"})`;
  const num = (v) => +v.toFixed(2);

  function svgEl(tag, attributes, parent) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes || {})) element.setAttribute(key, value);
    if (parent) parent.appendChild(element);
    return element;
  }

  /* ---------- Path builders (board coordinates) ---------- */

  const linePath = (points, close) => "M" + points.map((p) => num(p[0]) + " " + num(p[1])).join(" L") + (close ? " Z" : "");
  const rectPath = (x, y, w, h) => `M${num(x)} ${num(y)} h${num(w)} v${num(h)} h${num(-w)} Z`;
  const ellipsePath = (cx, cy, rx, ry) => `M${num(cx - rx)} ${num(cy)} a${num(rx)} ${num(ry)} 0 1 1 ${num(2 * rx)} 0 a${num(rx)} ${num(ry)} 0 1 1 ${num(-2 * rx)} 0`;
  function smoothPath(points) {
    let d = `M${num(points[0][0])} ${num(points[0][1])}`;
    for (let i = 0; i < points.length - 1; i++) { // Catmull-Rom to cubic Bezier
      const p0 = points[i - 1] || points[i], p1 = points[i], p2 = points[i + 1], p3 = points[i + 2] || p2;
      d += ` C${num(p1[0] + (p2[0] - p0[0]) / 6)} ${num(p1[1] + (p2[1] - p0[1]) / 6)} ${num(p2[0] - (p3[0] - p1[0]) / 6)} ${num(p2[1] - (p3[1] - p1[1]) / 6)} ${num(p2[0])} ${num(p2[1])}`;
    }
    return d;
  }
  function arrowHead(from, tip, size) {
    const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
    const wing = (side) => [tip[0] - size * Math.cos(angle + side * 0.45), tip[1] - size * Math.sin(angle + side * 0.45)];
    const a = wing(1), b = wing(-1);
    return ` M${num(a[0])} ${num(a[1])} L${num(tip[0])} ${num(tip[1])} L${num(b[0])} ${num(b[1])}`;
  }
  const polylineLength = (points) => hand.strokeLength(points);
  const roundedRectPath = (x, y, w, h, r) => `M${num(x + r)} ${num(y)} H${num(x + w - r)} A${r} ${r} 0 0 1 ${num(x + w)} ${num(y + r)} V${num(y + h - r)} A${r} ${r} 0 0 1 ${num(x + w - r)} ${num(y + h)} H${num(x + r)} A${r} ${r} 0 0 1 ${num(x)} ${num(y + h - r)} V${num(y + r)} A${r} ${r} 0 0 1 ${num(x + r)} ${num(y)} Z`;
  /** The outline of a diagram node (local coordinates): a curve for ellipses and circles, a rounded or square box otherwise. */
  const nodePath = (n) => (n.shape === "ellipse" || n.shape === "circle" ? ellipsePath(n.x + n.w / 2, n.y + n.h / 2, n.w / 2, n.h / 2) : n.shape === "rounded" ? roundedRectPath(n.x, n.y, n.w, n.h, 12) : rectPath(n.x, n.y, n.w, n.h));
  const msFor = (length, speed) => Math.max(120, (length / speed) * 1000);

  /** The box a shape occupies in its own coordinates, with room for the stroke and an arrow's head. */
  function shapeBox(op) {
    let minX, minY, maxX, maxY;
    if (op.points) {
      const xs = op.points.map((p) => p[0]), ys = op.points.map((p) => p[1]);
      minX = Math.min(...xs); maxX = Math.max(...xs); minY = Math.min(...ys); maxY = Math.max(...ys);
    } else if (op.shape === "rect") { minX = op.x; minY = op.y; maxX = op.x + op.w; maxY = op.y + op.h; }
    else if (op.shape === "circle") { minX = op.x - op.r; minY = op.y - op.r; maxX = op.x + op.r; maxY = op.y + op.r; }
    else { minX = op.x - op.rx; minY = op.y - op.ry; maxX = op.x + op.rx; maxY = op.y + op.ry; }
    const pad = op.shape === "arrow" ? 14 : op.shape === "curve" ? 8 : 4;
    return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
  }

  class Whiteboard {
    /**
     * @param {HTMLElement} host element to draw into
     * @param {object} [options]
     * @param {number} [options.timeScale] > 1 plays faster (tests), < 1 slow motion
     * @param {boolean} [options.reducedMotion] force the reduced-motion setting (tests)
     * @param {() => number|null} [options.speechLeftMs] override: how long the teacher will keep talking
     * @param {(level:string, message:string) => void} [options.log] diagnostics sink
     * @param {(state:object) => void} [options.onNotebook] called whenever pages are added or the live/viewed page changes
     * @param {(info:object) => void} [options.onMoment] called when the planner marks a teaching moment (speak only, wait, ...)
     * @param {(info:object) => void} [options.onRef] called when a step that a spoken reference depended on is finished, with how late it was
     * @param {(info:object) => void} [options.onGate] called when a step with a cue is released, with the reason and wait
     * @param {boolean} [options.debugStrokeColors] colour every pen stroke differently, to see stroke order (tests)
     * @param {object} [options.clock] a core.SpeechClock (tests)
     * @param {() => number} [options.now] time source in ms (tests)
     */
    constructor(host, options = {}) {
      this.host = host;
      this.timeScale = options.timeScale || 1;
      this.speechLeftOverride = options.speechLeftMs || null;
      this.debugStrokeColors = !!options.debugStrokeColors;
      this.log = options.log || ((level, message) => (console[level] || console.log)("[Whiteboard] " + message));
      this.now = options.now || (() => performance.now());
      this.clock = options.clock || new core.SpeechClock();
      this.onNotebook = options.onNotebook || (() => {});
      this.onGate = options.onGate || null;
      this.onMoment = options.onMoment || null;
      this.onRef = options.onRef || null;
      // Read live, so changing the system setting mid-lesson takes effect on the next stroke.
      const motionQuery = root.matchMedia ? root.matchMedia("(prefers-reduced-motion: reduce)") : null;
      this.prefersReducedMotion = () => (options.reducedMotion != null ? options.reducedMotion : !!(motionQuery && motionQuery.matches));
      if (!document.getElementById("wb-style")) { const s = document.createElement("style"); s.id = "wb-style"; s.textContent = STYLE; document.head.appendChild(s); }
      host.classList.add("wb");
      this.svg = svgEl("svg", { class: "wb-svg", viewBox: `0 0 ${BOARD.width} ${BOARD.height}`, role: "img", "aria-label": "Whiteboard, empty" }, host);
      this.pagesLayer = svgEl("g", {}, this.svg);
      this.buildPencil();

      this.pages = [];
      this.items = new Map();       // every element in the notebook, by id (ids are unique across pages)
      this.followLive = true;       // the student's view follows the teacher unless the student navigates away
      this.queue = [];
      this.running = false;
      this.generation = 0;
      this.jobs = new Set();
      this.current = null;
      this.scheduled = false; this.raf = 0; this.timer = 0;
      this.idleWaiters = [];
      this.gates = [];
      this.waiting = false;          // the teacher asked the student something: nothing more is drawn until the student answers
      this.moments = [];             // teaching moments the planner has marked, for diagnostics and tests
      this.timeline = [];            // when each step was released, started and finished (ms on this.now()), for measuring sync
      this.syncStats = { released: {}, refs: 0, lateRefs: 0, worstLateMs: 0 };
      this.calcAnchors = new Map();  // calc name -> where the first line's "=" is, so later lines line up under it
      this.uid = 0;
      this.typesetCache = new Map();
      // Live counters, so tests and diagnostics can see that real strokes are being drawn.
      this.stats = { strokesTotal: 0, strokesDone: 0, penDown: false, pen: null, handwritten: 0, fallbackText: 0 };
      this.live = this.working = this.view = this.addPage("");
      this.showPage(this.view);
    }

    buildPencil() {
      // A pencil seen from above-right: its point is the origin, which is what rides along the line being drawn.
      this.pencil = svgEl("g", { style: "opacity:0;pointer-events:none", "data-wb-pencil": "" }, this.svg);
      svgEl("path", { d: "M0 0 L3.2 -8 L15 -40 L24 -36.5 L9 -5.5 Z", fill: "#e9edef", stroke: "#33414a", "stroke-width": 1.6, "stroke-linejoin": "round" }, this.pencil);
      svgEl("path", { d: "M0 0 L3.2 -8 L9 -5.5 Z", fill: "#f0b43a", stroke: "#33414a", "stroke-width": 1.2, "stroke-linejoin": "round" }, this.pencil);
      svgEl("path", { d: "M14.5 -39 L24 -36 L21.5 -30 L12 -33.5 Z", fill: "#c2412d", opacity: 0.9 }, this.pencil);
    }

    /* ----- Public API: drawing ----- */

    /** Add validated steps to the end of the queue. They are drawn one after another, never all at once. */
    enqueue(ops) {
      if (!ops || !ops.length) return;
      if (this.waiting) { // the teacher is waiting for the student's answer: do not draw on
        const drawing = ops.filter((op) => op.op !== "moment");
        if (drawing.length) this.log("info", `The teacher is waiting for the student: not drawing ${drawing.length} more step(s).`);
        return;
      }
      for (const op of ops) for (const step of this.expand(op)) this.queue.push({ op: step, generation: this.generation });
      this.drain();
    }
    /** A diagram is drawn as a frame (laid out as a whole), then its parts one by one, each with its own cue. */
    expand(op) {
      if (op.op !== "diagram") return [op];
      const steps = [{ op: "dframe", id: op.id, spec: op, cue: op.cue, ref: op.ref }];
      for (const part of op.parts) steps.push({ op: part.type === "node" ? "dnode" : "dlink", diagram: op.id, part, id: part.id, cue: part.cue, ref: part.ref });
      return steps;
    }

    /** The student interrupted: the pen finishes the stroke it is on, everything waiting is dropped, the drawing stays. */
    cancelPending() {
      this.generation++;
      this.queue.length = 0;
      this.waiting = false; // an interruption is the student answering
      this.clock.end(this.now()); // the teacher stopped talking: nothing waits for a cue any more
      if (this.current) this.current.cancelled = true; // the element in progress stops instead of carrying on animating
      this.finishJobs(true);
    }

    /** Remove everything and start a fresh one-page notebook. */
    reset() {
      this.cancelPending();
      for (const page of this.pages) page.g.remove();
      this.pages = []; this.items.clear(); this.calcAnchors.clear(); this.followLive = true;
      this.live = this.working = this.view = this.addPage("");
      this.showPage(this.view);
    }

    /** Resolves when nothing is drawing or waiting. */
    idle() {
      return this.running || this.queue.length ? new Promise((resolve) => this.idleWaiters.push(resolve)) : Promise.resolve();
    }

    /* ----- Public API: the teacher's speech (see core.SpeechClock) ----- */

    /** A new spoken turn: forget the previous one. `text` is what the teacher is saying, if already known. */
    beginTurn(text) { this.clock.reset(); this.waiting = false; if (text) this.clock.setText(text, this.now()); }
    /** The teacher's text for this turn (it may arrive after the voice starts, or grow as it streams in). */
    setTurnText(text) { this.clock.setText(text, this.now()); }
    speechStart() { this.clock.start(this.now()); }
    speechEnd() { this.clock.end(this.now()); }
    /** A chunk of the teacher's voice began playing (ElevenLabs audio alignment): its text, and each character's start offset in ms if known. */
    speechProgress(text, startsMs, eventId) { this.clock.aligned(String(text || ""), startsMs, this.now(), eventId); }
    /** How long the teacher will probably keep talking, in ms, or null when unknown. */
    speechLeftMs() {
      if (this.speechLeftOverride) return this.speechLeftOverride();
      const c = this.clock;
      if (c.endedAt != null || !c.text) return 0;
      const base = c.startedAt != null ? c.startedAt : c.messageAt;
      return base == null ? null : Math.max(0, c.estimateMs(c.text) - (this.now() - base));
    }

    /* ----- Public API: the notebook ----- */

    /** Where things stand: the pages, which one the teacher is on (live), and which one the student is looking at (view). */
    state() {
      return {
        pages: this.pages.map((p) => ({ id: p.id, number: p.number, title: p.title, count: p.ids.size, unseen: p.unseen })),
        live: this.live.id, view: this.view.id, followLive: this.followLive,
      };
    }
    /** The student looks at another page. The teacher keeps writing on the live page. ref = page number, id or keyword. */
    viewPage(ref) {
      const page = typeof ref === "number" ? this.pages[ref - 1] : this.pageFor(ref);
      if (!page) return false;
      this.followLive = page === this.live;
      this.showPage(page);
      return true;
    }
    viewNext() { return this.viewPage(Math.min(this.pages.length, this.view.number + 1)); }
    viewPrevious() { return this.viewPage(Math.max(1, this.view.number - 1)); }
    /** Back to wherever the teacher is, and follow the teacher again. */
    returnToLive() { this.followLive = true; this.showPage(this.live); }

    /** Everything in the notebook for the planner: pages, how full the live page is, and each element's id and a few words. */
    notebook() {
      return {
        live: this.live.id,
        pages: this.pages.map((page) => ({ id: page.id, number: page.number, title: page.title, free: page.layout.freeFraction(), items: this.itemsOf(page) })),
      };
    }
    /** What the validator needs to know: every id, which are graphs, the size of each diagram group, the page ids. */
    context() {
      const context = { ids: [], graphs: [], groups: {}, owners: {}, pages: this.pages.map((p) => p.id) };
      for (const item of this.items.values()) {
        context.ids.push(item.id);
        if (item.parent) context.owners[item.id] = item.parent.id;
        if (item.type === "graph") context.graphs.push(item.id);
        if (item.type === "group") context.groups[item.id] = { w: item.frame.w, h: item.frame.h };
      }
      return context;
    }
    /** A flat list of what is on the board, with positions (page coordinates). For tests and diagnostics. */
    summary() {
      const out = [];
      for (const page of this.pages) for (const id of page.ids) { const item = this.items.get(id); if (item && item.bbox) out.push({ id, type: item.type, page: page.id, ...item.bbox, text: item.text }); }
      return out;
    }
    graphIds() { return [...this.items.values()].filter((item) => item.type === "graph").map((item) => item.id); }
    itemsOf(page) {
      const items = [...page.ids].map((id) => this.items.get(id)).filter(Boolean);
      const top = items.filter((i) => !i.parent), children = items.filter((i) => i.parent);
      return [...top, ...children].map((i) => ({ id: i.id, type: i.type, text: i.text, w: i.frame ? i.frame.w : undefined, h: i.frame ? i.frame.h : undefined }));
    }

    /* ----- Pages ----- */

    addPage(title) {
      const number = this.pages.length + 1;
      const g = svgEl("g", { "data-wb-page": "p" + number, style: "opacity:0" }, this.pagesLayer);
      const page = { id: "p" + number, number, title: title || "", g, ids: new Set(), layout: new Layout.PageLayout(), unseen: false };
      this.pages.push(page);
      return page;
    }
    pageFor(ref) {
      const at = this.pages.indexOf(this.live);
      if (ref === "latest") return this.pages[this.pages.length - 1];
      if (ref === "first") return this.pages[0];
      if (ref === "previous") return this.pages[Math.max(0, at - 1)];
      if (ref === "next") return this.pages[Math.min(this.pages.length - 1, at + 1)];
      return this.pages.find((p) => p.id === ref) || null;
    }
    /** Show a page (the one the student is looking at). Other pages stay in the notebook, hidden. */
    showPage(page) {
      this.view = page;
      // A hidden page must be really hidden: cancel its fade-in too, or a quick flip leaves two pages showing at once.
      for (const p of this.pages) { p.g.style.opacity = p === page ? "1" : "0"; if (p !== page) p.g.style.animation = "none"; p.g.setAttribute("aria-hidden", p === page ? "false" : "true"); }
      page.unseen = false;
      if (!this.prefersReducedMotion()) { page.g.style.animation = "none"; void page.g.getBoundingClientRect(); page.g.style.animation = "wb-page-in .28s ease-out"; }
      if (this.view !== this.live) this.pencil.style.opacity = 0;
      this.emit();
    }
    /** The teacher moves to a page. A student who is following sees it; a student reading elsewhere is not moved. */
    setLive(page) {
      if (this.live === page) return;
      this.live = page;
      if (this.followLive) this.showPage(page);
      else { if (page !== this.view) page.unseen = true; this.pencil.style.opacity = 0; this.emit(); }
    }
    emit() { this.describe(); this.onNotebook(this.state()); }
    describe() {
      const said = [...this.view.ids].map((id) => this.items.get(id)).filter((i) => i && i.text && !i.parent).map((i) => i.text);
      this.svg.setAttribute("aria-label", `Whiteboard, page ${this.view.number} of ${this.pages.length}` + (said.length ? ": " + said.join("; ") : ", empty"));
    }

    /* ----- Queue ----- */

    async drain() {
      if (this.running) return;
      this.running = true;
      try {
        while (this.queue.length) {
          const entry = this.queue.shift();
          if (entry.generation !== this.generation) continue; // queued before an interruption
          await this.waitForCue(entry);
          if (entry.generation !== this.generation) continue;
          this.current = { cancelled: false };
          const startedAt = this.now();
          try { await this.run(entry.op, this.paceFor(entry)); } catch (error) { this.log("warn", "A drawing step failed: " + (error && error.message) + " " + JSON.stringify(entry.op).slice(0, 120)); }
          this.current = null;
          if (entry.generation === this.generation) this.recordStep(entry.op, startedAt, this.now());
        }
      } finally {
        this.running = false; this.current = null;
        this.pencil.style.opacity = 0;
        for (const resolve of this.idleWaiters.splice(0)) resolve();
      }
    }

    /**
     * Remember when a step ran, and, if the teacher's words REFER to what it drew ("look at the point"), measure how
     * late it was: the number that says whether the picture was ready when the teacher pointed at it.
     */
    recordStep(op, startedAt, finishedAt) {
      const record = { op: op.op, id: op.id, cue: op.cue, ref: op.ref, startedAt, finishedAt };
      this.timeline.push(record); if (this.timeline.length > 200) this.timeline.shift();
      if (!op.ref) return;
      const spokenAt = this.clock.timeOf(op.ref);
      if (spokenAt == null) return;
      const late = Math.round(finishedAt - spokenAt);
      this.syncStats.refs++;
      record.refLateMs = late;
      const info = { id: op.id, ref: op.ref, finishedAfterReferenceMs: late, late: late > 600 };
      if (info.late) { this.syncStats.lateRefs++; this.syncStats.worstLateMs = Math.max(this.syncStats.worstLateMs, late); this.log("warn", `The teacher said "${op.ref}" but "${op.id || op.op}" was only finished ${late} ms later. (Planning or drawing took longer than the voice allowed.)`); }
      if (this.onRef) this.onRef(info);
    }

    /**
     * How fast to draw this step, as a multiplier on its natural duration (< 1 is faster). While the teacher is
     * still talking, the drawing is paced to finish about when the speech does, but never faster than 1.5x a
     * real hand or slower than 1.4x, so it neither appears all at once nor drags on.
     */
    paceFor(entry) {
      const speechLeft = this.speechLeftMs();
      if (speechLeft == null) return 1;
      let queued = this.naturalMs(entry.op);
      for (const waiting of this.queue) if (waiting.generation === this.generation) queued += this.naturalMs(waiting.op);
      const scale = clamp((Math.max(0, speechLeft) + 2500) / Math.max(1, queued), 0.65, 1.4);
      return Number.isFinite(scale) ? scale : 1;
    }

    /**
     * Hold a step until the teacher reaches its cue (see core.SpeechClock): exactly, from ElevenLabs alignment, or
     * from an estimate of the speaking pace. Never for ever: a missing or unmatched cue, or the end of the speech,
     * releases it. Every release is reported through onGate with the reason, so timing can be checked.
     */
    async waitForCue(entry) {
      const { cue, ref } = entry.op;
      if (!cue && !ref) return;
      const started = this.now();
      // A step the teacher will REFER to must be finished by then: it is released early by however long it takes to draw.
      const refLeadMs = ref ? (this.naturalMs(entry.op) * this.paceFor(entry)) / this.timeScale + 300 : 0;
      for (;;) {
        if (entry.generation !== this.generation) return;
        const result = this.clock.evaluate(cue, this.now(), { ref, refLeadMs });
        if (result.ready) {
          const info = { op: entry.op.op, id: entry.op.id, cue: cue || ref, reason: result.reason, waitedMs: Math.round(this.now() - started) };
          this.syncStats.released[result.reason] = (this.syncStats.released[result.reason] || 0) + 1;
          this.gates.push(info); if (this.gates.length > 100) this.gates.shift();
          if (result.reason === "cue-not-found") this.log("warn", `The cue "${cue || ref}" was not found in the teacher's words, so this step is drawn without waiting.`);
          if (this.onGate) this.onGate(info);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, clamp(result.waitMs || 80, 30, 120)));
      }
    }

    /** Typeset (and remember) the strokes for a write step. */
    typeset(op) {
      const size = FONT_SIZE[op.size] || FONT_SIZE.body;
      const maxWidth = TEXT_WIDTH[op.size] || TEXT_WIDTH.body;
      const key = [op.kind, size, maxWidth, op.content].join("\u0001");
      if (!this.typesetCache.has(key)) {
        if (this.typesetCache.size > 200) this.typesetCache.clear();
        this.typesetCache.set(key, op.kind === "math" ? hand.typesetMath(op.content, { size }) : hand.typesetText(op.content, { size, maxWidth }));
      }
      return { ...this.typesetCache.get(key), size, maxWidth };
    }
    /** A conservative size for text the stroke font cannot draw (typed fallback): never smaller than the real thing. */
    estimateTextBox(op, typeset) {
      const perLine = typeset.maxWidth, total = op.content.length * typeset.size * 0.62, lines = Math.max(1, Math.ceil(total / perLine));
      return { w: Math.min(perLine, Math.ceil(total) + 8), h: Math.ceil(lines * typeset.size * 1.4) + 8 };
    }

    /** How long a step takes at normal hand speed, in ms. Used to pace the drawing against the speech. */
    naturalMs(op) {
      switch (op.op) {
        case "write": { const t = this.typeset(op); return t.unsupported.length && op.kind !== "math" ? 800 : hand.strokeTimeline(t.strokes, { drawSpeed: SPEED.write }).total; }
        case "graph": return msFor(op.w + op.h, SPEED.axes) + 900;
        case "plot": return msFor(this.plotWidth(op) * 1.4, SPEED.curve) + (op.label ? 600 : 0);
        case "point": return 500 + (op.label ? 500 : 0);
        case "shape": return msFor(this.shapeLength(op), op.shape === "curve" ? SPEED.curve : SPEED.line);
        case "group": return 100;
        case "dframe": return 300 + (op.spec && op.spec.title ? 700 : 0);
        case "dnode": return 900 + (op.part && op.part.label ? op.part.label.length * 45 : 0);
        case "dlink": return 650 + (op.part && op.part.label ? op.part.label.length * 35 : 0);
        case "moment": return 50;
        case "highlight": return 650;
        case "point_to": return 2200;
        case "erase": return 400;
        case "correct": return 900 + this.naturalMs(op.with);
        case "new_page": return 250;
        case "go_to_page": return 250;
        case "clear": return 250;
        case "pause": return op.ms;
        default: return 500;
      }
    }
    /** Width of the plotting area of the graph a plot step draws into (a plot has no width of its own). */
    plotWidth(op) {
      const graph = this.items.get(op.graph);
      return graph && graph.graph ? graph.graph.plotW : 400;
    }
    shapeLength(op) {
      switch (op.shape) {
        case "rect": return 2 * (op.w + op.h);
        case "circle": return 2 * Math.PI * op.r;
        case "ellipse": return 2 * Math.PI * Math.sqrt((op.rx * op.rx + op.ry * op.ry) / 2);
        case "polygon": return polylineLength([...op.points, op.points[0]]);
        default: return polylineLength(op.points) + (op.shape === "arrow" ? 40 : 0);
      }
    }

    async run(op, scale) {
      const d = (ms) => ((Number.isFinite(ms) ? ms : 0) * (Number.isFinite(scale) ? scale : 1)) / this.timeScale;
      switch (op.op) {
        case "write": return this.runWrite(op, d);
        case "graph": return this.runGraph(op, d);
        case "group": return this.runGroup(op, d);
        case "dframe": return this.runDFrame(op, d);
        case "dnode": return this.runDNode(op, d);
        case "dlink": return this.runDLink(op, d);
        case "moment": return this.runMoment(op);
        case "plot": return this.runPlot(op, d);
        case "point": return this.runPoint(op, d);
        case "shape": return this.runShape(op, d);
        case "highlight": return this.runHighlight(op, d);
        case "point_to": return this.runPointTo(op, d);
        case "erase": return this.runErase(op.target, d);
        case "correct": return this.runCorrect(op, d, scale);
        case "new_page": case "clear": return this.runNewPage(op, d);
        case "go_to_page": return this.runGoToPage(op, d);
        case "pause": return this.tween(d(op.ms), () => {});
      }
    }

    /* ----- Animation loop ----- */

    /**
     * Run step(progress 0..1) over ms. `cancel`, if given, is what to do when the student interrupts
     * (default: jump to the end), and may return after leaving the animation partly done.
     */
    tween(ms, step, ease = easeInOut, cancel = null) {
      if (!Number.isFinite(ms)) { this.log("warn", "A drawing step had an invalid duration (" + ms + "); finishing it at once instead of stalling."); ms = 0; }
      if (ms <= 0 || this.prefersReducedMotion() || document.hidden || (this.current && this.current.cancelled)) { step(1); return Promise.resolve(); }
      return new Promise((resolve) => {
        this.jobs.add({ ms, step, ease, resolve, start: null, cancel });
        this.schedule();
      });
    }
    /** Next frame: animation frame when the tab is visible, a timer as backup so a hidden tab never freezes the board. */
    schedule() {
      if (this.scheduled) return;
      this.scheduled = true;
      const run = () => {
        if (!this.scheduled) return;
        this.scheduled = false;
        cancelAnimationFrame(this.raf); clearTimeout(this.timer);
        this.frame(performance.now());
      };
      this.raf = requestAnimationFrame(run);
      this.timer = setTimeout(run, 80);
    }
    frame(now) {
      for (const job of [...this.jobs]) {
        if (job.start === null) job.start = now;
        const progress = Math.min(1, (now - job.start) / job.ms);
        job.step(job.ease(progress));
        if (progress >= 1) { this.jobs.delete(job); job.resolve(); }
      }
      if (this.jobs.size) this.schedule();
    }
    finishJobs(interrupted) {
      for (const job of [...this.jobs]) {
        if (interrupted && job.cancel) job.cancel(); else job.step(1);
        this.jobs.delete(job); job.resolve();
      }
    }
    movePencil(x, y, visible, down = true) {
      this.pencil.setAttribute("transform", `translate(${num(x)} ${num(y)})`);
      const watching = this.view === this.live; // the pen is only shown on the page the student is looking at
      this.pencil.style.opacity = visible && watching ? (down ? 1 : 0.55) : 0; // paler while the pen is lifted and travelling
      this.stats.penDown = !!(visible && down); this.stats.pen = { x, y };
    }

    /* ----- Items and space ----- */

    /**
     * Make an item. Items live on a page (and inside a parent: a graph's curves, a diagram group's parts).
     */
    createItem(id, type, page, parent) {
      const g = svgEl("g", { "data-wb-id": id, "data-wb-type": type }, parent ? parent.g : page.g);
      const item = { id, type, g, page, parent: parent || null, children: new Set(), bbox: null, text: "", marker: null, calc: null };
      this.items.set(id, item);
      page.ids.add(id);
      if (parent) parent.children.add(id);
      if (page !== this.view) { page.unseen = true; this.emit(); }
      return item;
    }
    removeItem(id) {
      const item = this.items.get(id);
      if (!item) return;
      for (const childId of [...item.children]) this.removeItem(childId);
      if (item.marker) item.marker.remove();
      item.g.remove();
      item.page.ids.delete(id);
      item.page.layout.release(id);
      for (const [name, anchor] of this.calcAnchors) if (anchor.itemId === id) this.calcAnchors.delete(name); // the line the equals signs were aligned to is gone
      if (item.parent) { item.parent.children.delete(id); if (item.parent.labels) item.parent.labels.release(id); } // a diagram label frees its place in the diagram
      this.items.delete(id);
    }

    /**
     * Set aside space for a block BEFORE drawing it. Finds free room on the live page; if there is none, starts a new
     * page first (nothing is drawn yet, and nothing is shrunk). Returns { page, x, y, w, h } in page coordinates.
     */
    reserve(id, w, h, request = {}) {
      w = Math.min(Math.ceil(w), BOARD.width - 2 * MARGIN); h = Math.min(Math.ceil(h), BOARD.height - 2 * MARGIN);
      let page = request.page || this.live;
      const near = request.near && this.items.get(request.near) && this.items.get(request.near).page === page ? request.near : undefined;
      const wanted = { id, w, h, flow: request.flow || "stack", near, side: request.side, calc: request.calc, prefer: request.prefer, reserveH: request.reserveH };
      let spot = page.layout.place(wanted);
      if (spot && request.alignTo != null) { // line this block up with an earlier one (the "=" signs of a calculation)
        const alt = { x: Math.ceil(request.alignTo), y: spot.y };
        if (alt.x !== spot.x && page.layout.isFree({ x: alt.x, y: alt.y, w, h }, request.calc, id)) spot = alt;
      }
      if (!spot) {
        const full = page;
        page = this.addPage(""); this.working = page; this.setLive(page);
        this.log("info", `Page ${full.number} had no room for "${id}" (${w}x${h}); started page ${page.number} first.`);
        spot = page.layout.place({ ...wanted, near: undefined, prefer: undefined }) || { x: MARGIN, y: MARGIN };
      }
      page.layout.occupy(id, { x: spot.x, y: spot.y, w, h }, request.calc);
      if (page === this.live) this.working = page; // a correction on an old page must not move where the teacher is writing
      return { page, x: spot.x, y: spot.y, w, h };
    }

    /* ----- Handwriting ----- */

    /**
     * Put pen strokes on the board, hidden, ready to be drawn. Each stroke is its own path whose dash offset
     * is animated, so it is drawn along its length rather than faded or wiped in.
     */
    buildHand(parent, strokes, color, width) {
      const group = svgEl("g", { fill: "none", stroke: color, "stroke-width": width, "stroke-linecap": "round", "stroke-linejoin": "round", "data-wb-hand": strokes.length }, parent);
      const paths = strokes.map((points, index) => {
        const length = hand.strokeLength(points);
        const path = svgEl("path", { d: linePath(points) }, group);
        if (this.debugStrokeColors) path.style.stroke = `hsl(${(index * 47) % 360} 75% 42%)`;
        path.style.visibility = "hidden";
        if (length > 0.6) { path.style.strokeDasharray = `${num(length)} ${num(length + 4)}`; path.style.strokeDashoffset = num(length); } // dots are just revealed
        return { path, length };
      });
      this.stats.strokesTotal += strokes.length;
      return { group, paths, timeline: hand.strokeTimeline(strokes, { drawSpeed: SPEED.write }) };
    }

    /**
     * Draw a built hand: strokes are completed in order, the one in progress is partly drawn, and the pencil
     * follows the pen (pale while lifted). offset = where the group sits on the board.
     * On interruption the pen finishes the stroke it is on and stops.
     */
    async playHand(built, ms, offset, boost = 1) {
      const { paths, timeline } = built, items = timeline.items;
      let cursor = 0, stopped = false;
      const complete = (i) => {
        const { path } = paths[i];
        path.style.visibility = "visible"; path.style.strokeDasharray = ""; path.style.strokeDashoffset = "";
        this.stats.strokesDone++;
      };
      const step = (p) => {
        const T = p * timeline.total;
        while (cursor < items.length && items[cursor].drawEnd <= T + 1e-6) complete(cursor++);
        if (cursor >= items.length) return;
        const item = items[cursor];
        if (T >= item.drawStart) {
          const f = clamp((T - item.drawStart) / (item.drawEnd - item.drawStart), 0, 1), { path, length } = paths[cursor];
          path.style.visibility = "visible";
          if (length > 0.6) path.style.strokeDashoffset = num(length * (1 - f));
        }
        const pen = hand.penAt(timeline, T);
        if (pen && !stopped) this.movePencil(offset.x + pen.x, offset.y + pen.y, true, pen.down);
      };
      const cancel = () => { // finish the stroke in progress, then stop
        stopped = true;
        if (cursor < items.length) { const T = items[cursor].drawEnd; step(Math.min(1, (T + 1e-3) / timeline.total)); }
        built.interrupted = cursor < items.length;
      };
      await this.tween(ms / boost, (p) => { step(p); if (p >= 1) while (cursor < items.length) complete(cursor++); }, linear, cancel);
    }

    /** Write a handful of short labels (graph numbers, axis names) as quick handwriting. */
    async writeLabels(parent, labels, color, offset, d, size) {
      const strokes = [], rects = [];
      for (const label of labels) {
        const typeset = hand.typesetText(label.text, { size: label.size || size, seed: label.text });
        const dx = label.anchor === "end" ? -typeset.width : label.anchor === "middle" ? -typeset.width / 2 : 0;
        const top = label.top ? label.y : label.y - typeset.baseline; // label.y is the baseline unless `top` says it is the top edge
        strokes.push(...typeset.strokes.map((stroke) => stroke.map(([x, y]) => [x + label.x + dx, y + top])));
        rects.push({ x: label.x + dx, y: top, w: typeset.width, h: typeset.height });
      }
      if (!strokes.length) return null;
      const built = this.buildHand(parent, strokes, color, clamp(size * 0.09, 1.8, 3));
      built.rects = rects;
      await this.playHand(built, d(built.timeline.total), offset, SPEED.labelBoost);
      return built;
    }

    async runWrite(op, d) {
      if (this.items.has(op.id)) this.removeItem(op.id); // reusing an id replaces the element (and frees its space)
      if (op.group) return this.runGroupWrite(op, d);
      const typeset = this.typeset(op);
      const drawable = typeset.strokes.length && (op.kind === "math" || !typeset.unsupported.length);
      if (typeset.unsupported.length) this.log("warn", `${op.kind === "math" ? "Maths" : "Text"} contains things the handwriting font cannot draw (${typeset.unsupported.join(" ")}): ${op.kind === "math" ? "drawing the rest" : "using the typed-text fallback"}.`);
      const box = drawable ? { w: typeset.width, h: typeset.height } : this.estimateTextBox(op, typeset);
      if (op.size === "title") box.w = BOARD.width - 2 * MARGIN; // a title owns its whole row: nothing is placed beside it
      const firstOfCalc = op.calc && ![...this.live.ids].some((id) => { const i = this.items.get(id); return i && i.calc === op.calc; });
      const aligns = op.calc && op.kind === "math" && typeset.relationX != null;
      const anchor = aligns ? this.calcAnchors.get(op.calc) : null;
      const targetPage = op.page || this.live; // a correction goes back to the page it is on, not to where the teacher is
      const spot = this.reserve(op.id, box.w, box.h, { flow: "stack", near: op.near, side: op.side, calc: op.calc, reserveH: firstOfCalc ? CALC_RESERVE : 0, prefer: op.prefer, page: op.page, alignTo: anchor && anchor.pageId === targetPage.id ? anchor.x - typeset.relationX : null });
      if (aligns && (!anchor || anchor.pageId !== spot.page.id)) this.calcAnchors.set(op.calc, { pageId: spot.page.id, x: spot.x + typeset.relationX, itemId: op.id });
      if (!drawable) return this.runWriteFallback(op, d, typeset, spot);

      const item = this.createItem(op.id, op.kind === "math" ? "math" : "text", spot.page);
      item.calc = op.calc || null;
      item.g.setAttribute("transform", `translate(${num(spot.x)} ${num(spot.y)})`);
      item.bbox = { x: spot.x, y: spot.y, w: spot.w, h: spot.h };
      item.text = op.content;
      this.emit();
      const built = this.buildHand(item.g, typeset.strokes, colorVar(op.color), clamp(typeset.size * 0.082, 2.4, 4.4));
      this.stats.handwritten++;
      await this.playHand(built, d(built.timeline.total), { x: spot.x, y: spot.y });
      if (built.interrupted) item.text += " (unfinished)";
    }

    /** Last resort for text the stroke font cannot draw (other alphabets): typed text, wiped in left to right. */
    async runWriteFallback(op, d, typeset, spot) {
      this.stats.fallbackText++;
      const item = this.createItem(op.id, "text", spot.page);
      const size = typeset.size;
      const fo = svgEl("foreignObject", { x: 0, y: 0, width: spot.w, height: spot.h }, item.g);
      const box = document.createElement("div");
      box.className = "wb-text" + (op.kind === "math" ? " wb-raw" : "");
      box.style.cssText = `font-size:${size}px;color:${colorVar(op.color)};max-width:${spot.w}px;${op.size === "title" ? "font-weight:700;" : ""}`;
      box.textContent = op.content;
      fo.appendChild(box);
      item.g.setAttribute("transform", `translate(${num(spot.x)} ${num(spot.y)})`);
      item.bbox = { x: spot.x, y: spot.y, w: spot.w, h: spot.h };
      item.text = op.content;
      this.emit();
      const wipe = (p) => { box.style.clipPath = p >= 1 ? "" : `inset(-8px ${num((1 - p) * 100)}% -8px -8px)`; };
      wipe(0);
      await this.tween(d(900 + op.content.length * 40), (p) => { wipe(p); this.movePencil(spot.x + p * spot.w, spot.y + spot.h * 0.7, p < 1); }, linear);
    }

    /** A diagram frame: reserves a region of a page. The diagram's parts are drawn inside it in local coordinates. */
    async runGroup(op, d) {
      if (this.items.has(op.id)) this.removeItem(op.id);
      const spot = this.reserve(op.id, op.w, op.h, { flow: "any", near: op.near, side: op.side, calc: op.calc });
      const item = this.createItem(op.id, "group", spot.page);
      item.g.setAttribute("transform", `translate(${num(spot.x)} ${num(spot.y)})`);
      item.frame = { x: spot.x, y: spot.y, w: spot.w, h: spot.h };
      item.bbox = { ...item.frame };
      item.labels = new Layout.PageLayout({ width: spot.w, height: spot.h, margin: 0, gap: 8 }); // keeps labels in a diagram apart
      this.emit();
      await this.tween(d(120), () => {});
    }

    /** A label inside a diagram. It goes where asked (local coordinates), moved aside only if it would land on another label. */
    async runGroupWrite(op, d) {
      const group = this.items.get(op.group);
      if (!group || group.type !== "group") return;
      const typeset = this.typeset(op);
      const drawable = typeset.strokes.length && (op.kind === "math" || !typeset.unsupported.length);
      if (!drawable) { this.log("warn", `Label "${op.content}" has characters the handwriting font cannot draw; skipped inside a diagram.`); return; }
      const w = Math.ceil(typeset.width), h = Math.ceil(typeset.height), f = group.frame;
      const fit = (x, y) => ({ x: clamp(x, 0, Math.max(0, f.w - w)), y: clamp(y, 0, Math.max(0, f.h - h)) });
      let spot = null;
      if (op.x !== undefined) {
        const wanted = fit(op.x, op.y === undefined ? 0 : op.y), free = (p) => group.labels.isFree({ x: p.x, y: p.y, w, h }, null, op.id);
        const tries = [[0, 0], [0, h + 6], [0, -(h + 6)], [w + 6, 0], [-(w + 6), 0], [0, 2 * (h + 6)], [0, -2 * (h + 6)]].map(([dx, dy]) => fit(wanted.x + dx, wanted.y + dy));
        spot = tries.find(free) || wanted;
      } else spot = group.labels.place({ id: op.id, w, h, flow: "stack" }) || fit(0, 0);
      group.labels.occupy(op.id, { x: spot.x, y: spot.y, w, h });
      const item = this.createItem(op.id, op.kind === "math" ? "math" : "text", group.page, group);
      item.g.setAttribute("transform", `translate(${num(spot.x)} ${num(spot.y)})`);
      item.bbox = { x: f.x + spot.x, y: f.y + spot.y, w, h };
      item.text = op.content;
      this.emit();
      const built = this.buildHand(item.g, typeset.strokes, colorVar(op.color), clamp(typeset.size * 0.082, 2.4, 4.4));
      this.stats.handwritten++;
      await this.playHand(built, d(built.timeline.total), { x: item.bbox.x, y: item.bbox.y });
      if (built.interrupted) item.text += " (unfinished)";
    }

    /* ----- Drawing strokes ----- */

    /**
     * Draw a path stroke by stroke: the dash offset shrinks while the pencil follows the end of the line.
     * offset = where the path's group sits on the board, so the pencil lands on the line.
     * A dash pattern restarts at every sub-path, so a path made of several pieces (an arrow's head, a curve
     * broken by an asymptote) is split up and its pieces are drawn one after another.
     */
    async drawPath(path, ms, offset = { x: 0, y: 0 }) {
      const pieces = path.getAttribute("d").trim().split(/(?=M)/).filter(Boolean);
      if (pieces.length > 1) {
        const parts = pieces.map((d) => { const part = path.cloneNode(false); part.setAttribute("d", d); part.style.opacity = 0; path.parentNode.insertBefore(part, path); return part; });
        path.remove();
        const lengths = parts.map((part) => part.getTotalLength());
        const total = lengths.reduce((a, b) => a + b, 0) || 1;
        for (const [i, part] of parts.entries()) await this.drawPath(part, (ms * lengths[i]) / total, offset);
        return;
      }
      path.setAttribute("pathLength", 1);
      path.style.strokeDasharray = "1 1";
      path.style.strokeDashoffset = 1;
      path.style.opacity = 0;
      const length = path.getTotalLength();
      await this.tween(ms, (p) => {
        if (p >= 1) { path.style.strokeDasharray = ""; path.style.strokeDashoffset = ""; path.style.opacity = 1; return; }
        path.style.strokeDashoffset = 1 - p;
        path.style.opacity = p > 0 ? 1 : 0;
        const point = path.getPointAtLength(length * p);
        this.movePencil(point.x + offset.x, point.y + offset.y, true);
      }, linear);
    }

    /** For dashed strokes, which cannot use the dash trick: reveal left to right behind a growing clip box. */
    async revealPath(path, bbox, ms, offset = { x: 0, y: 0 }) {
      const id = "wbclip" + ++this.uid;
      const clip = svgEl("clipPath", { id }, path.parentNode);
      const rect = svgEl("rect", { x: bbox.x - 10, y: bbox.y - 10, width: 0, height: bbox.h + 20 }, clip);
      path.setAttribute("clip-path", `url(#${id})`);
      await this.tween(ms, (p) => {
        rect.setAttribute("width", (bbox.w + 20) * p);
        this.movePencil(offset.x + bbox.x + bbox.w * p, offset.y + bbox.y + bbox.h / 2, p < 1);
      }, linear);
      path.removeAttribute("clip-path"); clip.remove();
    }

    async fadeIn(element, ms, to = 1) {
      element.style.opacity = 0;
      await this.tween(ms, (p) => { element.style.opacity = num(p * to); });
    }

    // ----- shapes -----
    async runShape(op, d) {
      if (this.items.has(op.id)) this.removeItem(op.id);
      const group = op.group ? this.items.get(op.group) : null;
      if (op.group && (!group || group.type !== "group")) return;
      let pathData, headFrom, tip;
      switch (op.shape) {
        case "line": case "arrow": case "polyline": pathData = linePath(op.points, false); break;
        case "polygon": pathData = linePath(op.points, true); break;
        case "curve": pathData = smoothPath(op.points); break;
        case "rect": pathData = rectPath(op.x, op.y, op.w, op.h); break;
        case "circle": pathData = ellipsePath(op.x, op.y, op.r, op.r); break;
        case "ellipse": pathData = ellipsePath(op.x, op.y, op.rx, op.ry); break;
      }
      if (op.shape === "arrow") { headFrom = op.points[op.points.length - 2]; tip = op.points[op.points.length - 1]; pathData += arrowHead(headFrom, tip, 20); }

      // A shape inside a diagram keeps its local coordinates. A lone shape is placed like any other block: its box is
      // measured, free space is found, and the shape is moved there.
      const box = shapeBox(op);
      let item, offset, rect;
      if (group) {
        item = this.createItem(op.id, "shape", group.page, group);
        offset = { x: group.frame.x, y: group.frame.y };
        rect = { x: offset.x + box.x, y: offset.y + box.y, w: box.w, h: box.h };
      } else {
        const spot = this.reserve(op.id, box.w, box.h, { flow: "any", near: op.near, side: op.side, calc: op.calc });
        item = this.createItem(op.id, "shape", spot.page);
        const dx = spot.x - box.x, dy = spot.y - box.y;
        item.g.setAttribute("transform", `translate(${num(dx)} ${num(dy)})`);
        offset = { x: dx, y: dy };
        rect = { x: spot.x, y: spot.y, w: spot.w, h: spot.h };
      }
      item.bbox = rect;
      item.text = "";
      this.emit();

      const closed = ["rect", "circle", "ellipse", "polygon"].includes(op.shape);
      let fill = null;
      if (op.fill && closed) fill = svgEl("path", { d: pathData, fill: colorVar(op.color), stroke: "none", style: "opacity:0" }, item.g);
      const path = svgEl("path", { d: pathData, fill: "none", stroke: colorVar(op.color), "stroke-width": STROKE, "stroke-linecap": "round", "stroke-linejoin": "round" }, item.g);
      const ms = d(this.naturalMs(op));
      if (op.dashed) {
        path.setAttribute("stroke-dasharray", "12 10");
        await this.revealPath(path, { x: box.x, y: box.y, w: box.w, h: box.h }, ms, offset);
      } else {
        await this.drawPath(path, ms, offset);
      }
      if (fill) await this.fadeIn(fill, d(250), 0.16);
    }

    // ----- graphs -----
    async runGraph(op, d) {
      if (this.items.has(op.id)) this.removeItem(op.id);
      const spot = this.reserve(op.id, op.w, op.h, { flow: "any", near: op.near, side: op.side, calc: op.calc });
      const item = this.createItem(op.id, "graph", spot.page);
      const margin = { l: 50, r: 18, t: 16, b: 38 };
      const plotW = spot.w - margin.l - margin.r, plotH = spot.h - margin.t - margin.b;
      const sx = (v) => margin.l + ((v - op.xmin) / (op.xmax - op.xmin)) * plotW;
      const sy = (v) => margin.t + plotH - ((v - op.ymin) / (op.ymax - op.ymin)) * plotH;
      item.g.setAttribute("transform", `translate(${num(spot.x)} ${num(spot.y)})`);
      item.graph = { op, margin, plotW, plotH, sx, sy, axisX: 0 };
      item.bbox = { x: spot.x, y: spot.y, w: spot.w, h: spot.h };
      this.emit();
      const offset = { x: spot.x, y: spot.y };

      const axisX = op.xmin <= 0 && op.xmax >= 0 ? sx(0) : margin.l;
      const axisY = op.ymin <= 0 && op.ymax >= 0 ? sy(0) : margin.t + plotH;
      item.graph.axisX = axisX;
      const xTicks = core.niceTicks(op.xmin, op.xmax, 7), yTicks = core.niceTicks(op.ymin, op.ymax, 6);
      const stroke = { fill: "none", stroke: "currentColor", "stroke-linecap": "round", "stroke-linejoin": "round" };
      item.g.style.color = colorVar("ink");

      if (op.grid) {
        const grid = svgEl("path", { ...stroke, "stroke-width": 1, d: xTicks.map((v) => `M${num(sx(v))} ${margin.t} v${plotH}`).join(" ") + yTicks.map((v) => ` M${margin.l} ${num(sy(v))} h${plotW}`).join(" "), style: "opacity:0" }, item.g);
        await this.fadeIn(grid, d(250), 0.18);
      }
      const xAxis = svgEl("path", { ...stroke, "stroke-width": 3, d: `M${margin.l - 6} ${num(axisY)} H${num(margin.l + plotW)}` + arrowHead([margin.l + plotW - 20, axisY], [margin.l + plotW, axisY], 12) }, item.g);
      const yAxis = svgEl("path", { ...stroke, "stroke-width": 3, style: "opacity:0", d: `M${num(axisX)} ${margin.t + plotH + 6} V${margin.t}` + arrowHead([axisX, margin.t + 20], [axisX, margin.t], 12) }, item.g);
      await this.drawPath(xAxis, d(msFor(plotW + 30, SPEED.axes)), offset);
      await this.drawPath(yAxis, d(msFor(plotH + 30, SPEED.axes)), offset);

      // Tick marks, then the numbers written by hand.
      const ticks = svgEl("path", { ...stroke, "stroke-width": 2, style: "opacity:0", d:
        xTicks.filter((v) => !(Math.abs(v) < 1e-9 && axisX !== margin.l)).map((v) => `M${num(sx(v))} ${num(axisY - 5)} v10`).join(" ") + " " +
        yTicks.filter((v) => !(Math.abs(v) < 1e-9 && axisY !== margin.t + plotH)).map((v) => ` M${num(axisX - 5)} ${num(sy(v))} h10`).join(" ") }, item.g);
      if (ticks.getAttribute("d").trim()) await this.fadeIn(ticks, d(180)); else ticks.remove();
      const labels = [];
      for (const v of xTicks) if (!(Math.abs(v) < 1e-9 && axisX !== margin.l)) labels.push({ text: String(v), x: sx(v), y: axisY + 28, anchor: "middle" });
      for (const v of yTicks) if (!(Math.abs(v) < 1e-9 && axisY !== margin.t + plotH)) labels.push({ text: String(v), x: axisX - 12, y: sy(v) + 8, anchor: "end" });
      const tickLabels = await this.writeLabels(item.g, labels, "currentColor", offset, d, 22);
      const axisLabels = [];
      if (op.xlabel) axisLabels.push({ text: op.xlabel, x: margin.l + plotW - 4, y: axisY - 12, anchor: "end" });
      if (op.ylabel) axisLabels.push({ text: op.ylabel, x: axisX + 12, y: margin.t + 14, anchor: "start" });
      const nameLabels = await this.writeLabels(item.g, axisLabels, "currentColor", offset, d, 28);
      // What a curve or point label must stay clear of: the axes, the numbers, the axis names, and (as they are drawn) the curves.
      item.graph.obstacles = { rects: [{ x: margin.l - 6, y: axisY - 5, w: plotW + 10, h: 10 }, { x: axisX - 5, y: margin.t - 4, w: 10, h: plotH + 10 }, ...(tickLabels ? tickLabels.rects : []), ...(nameLabels ? nameLabels.rects : [])], lines: [] };
      item.text = [op.xlabel, op.ylabel].filter(Boolean).join(" vs ");
      this.describe();
    }

    graphChild(graphItem, id, type) {
      if (this.items.has(id)) this.removeItem(id);
      const item = this.createItem(id, type, graphItem.page, graphItem); // drawn inside the graph, so it moves with it
      item.bbox = { ...graphItem.bbox };
      return item;
    }

    async runPlot(op, d) {
      const graphItem = this.items.get(op.graph);
      if (!graphItem || !graphItem.graph) return;
      const { op: graph, margin, plotW, plotH, sx, sy, axisX } = graphItem.graph;
      const item = this.graphChild(graphItem, op.id, "plot");
      const evaluate = core.compileExpression(op.fn);
      const from = Math.max(graph.xmin, op.from == null ? graph.xmin : op.from), to = Math.min(graph.xmax, op.to == null ? graph.xmax : op.to);
      if (!(to > from)) return;
      const rangeY = graph.ymax - graph.ymin, samples = Math.max(120, Math.round(plotW / 2));
      let pathData = "", previous = null, last = null, labelPoint = null; const runs = []; let run = null;
      for (let i = 0; i <= samples; i++) {
        const x = from + ((to - from) * i) / samples, y = evaluate(x);
        const usable = Number.isFinite(y) && y > graph.ymin - rangeY * 3 && y < graph.ymax + rangeY * 3;
        if (!usable || (previous !== null && Math.abs(y - previous) > rangeY * 2)) { previous = usable ? y : null; run = null; if (usable) { pathData += ` M${num(sx(x))} ${num(sy(y))}`; run = [[sx(x), sy(y)]]; runs.push(run); } continue; } // break the line at gaps like tan(x)
        pathData += (previous === null ? " M" : " L") + num(sx(x)) + " " + num(sy(y));
        if (!run) { run = []; runs.push(run); } run.push([sx(x), sy(y)]);
        previous = y; last = { x, y };
        if (sy(y) >= margin.t + 28) labelPoint = { x, y }; // where the label can sit beside the curve without leaving the plot
      }
      if (!pathData) return;
      const clipId = "wbclip" + ++this.uid;
      const clip = svgEl("clipPath", { id: clipId }, item.g);
      svgEl("rect", { x: margin.l, y: margin.t, width: plotW, height: plotH }, clip);
      const clipped = svgEl("g", { "clip-path": `url(#${clipId})` }, item.g);
      const path = svgEl("path", { d: pathData.trim(), fill: "none", stroke: colorVar(op.color), "stroke-width": STROKE + 0.5, "stroke-linecap": "round", "stroke-linejoin": "round" }, clipped);
      item.text = "";
      const offset = { x: graphItem.bbox.x, y: graphItem.bbox.y };
      await this.drawPath(path, d(msFor(plotW * 1.4, SPEED.curve)), offset);
      const obstacles = graphItem.graph.obstacles || (graphItem.graph.obstacles = { rects: [], lines: [] });
      obstacles.lines.push(...runs.filter((r) => r.length > 1));
      if (op.label && labelPoint) {
        // Beside the curve on a free side: never on a curve, an axis, a number or another label.
        const size = hand.typesetText(op.label, { size: 26 });
        const spot = Diagram.placeLabel([sx(labelPoint.x), sy(labelPoint.y)], { w: size.width, h: size.height }, { rects: obstacles.rects, lines: obstacles.lines }, { x: margin.l, y: margin.t, w: plotW, h: plotH }, { gap: 12 });
        if (!spot.ok) this.log("info", `The label "${op.label}" has no completely free place beside its curve; placed where it overlaps least.`);
        const written = await this.writeLabels(item.g, [{ text: op.label, x: spot.x, y: spot.y, top: true, anchor: "start" }], colorVar(op.color), offset, d, 26);
        if (written) obstacles.rects.push(...written.rects);
      }
    }

    async runPoint(op, d) {
      const graphItem = this.items.get(op.graph);
      if (!graphItem || !graphItem.graph) return;
      const { sx, sy } = graphItem.graph;
      const item = this.graphChild(graphItem, op.id, "point");
      const cx = sx(op.px), cy = sy(op.py);
      const offset = { x: graphItem.bbox.x, y: graphItem.bbox.y };
      const dot = svgEl("circle", { cx: num(cx), cy: num(cy), r: 0, fill: colorVar(op.color) }, item.g);
      this.movePencil(offset.x + cx, offset.y + cy, true);
      await this.tween(d(300), (p) => { dot.setAttribute("r", num(7 * p)); });
      if (op.label) {
        const size = hand.typesetText(op.label, { size: 26 }), obstacles = graphItem.graph.obstacles || (graphItem.graph.obstacles = { rects: [], lines: [] });
        const dotRect = { x: cx - 9, y: cy - 9, w: 18, h: 18 };
        const spot = Diagram.placeLabel([cx, cy], { w: size.width, h: size.height }, { rects: [...obstacles.rects, dotRect], lines: obstacles.lines }, { x: 2, y: 2, w: graphItem.bbox.w - 4, h: graphItem.bbox.h - 4 }, { gap: 12 });
        const written = await this.writeLabels(item.g, [{ text: op.label, x: spot.x, y: spot.y, top: true, anchor: "start" }], colorVar(op.color), offset, d, 26);
        if (written) obstacles.rects.push(...written.rects);
      }
    }

    /* ----- Teaching moments ----- */

    /**
     * The planner's note on what kind of moment this is: speaking only, writing, drawing, pointing, or waiting for the
     * student. "wait" is a barrier: the teacher has asked something, so nothing more is drawn until the student answers.
     */
    async runMoment(op) {
      this.moments.push({ kind: op.kind, note: op.note || "", at: this.now() });
      if (this.onMoment) this.onMoment({ kind: op.kind, note: op.note || "" });
      if (op.kind === "wait") { this.waiting = true; const dropped = this.queue.filter((e) => e.generation === this.generation).length; this.queue.length = 0; if (dropped) this.log("info", `The teacher asked a question: ${dropped} queued step(s) after it were dropped.`); }
    }

    /* ----- Diagrams: nodes and links laid out as a whole, drawn part by part ----- */

    /** Lay out the whole diagram (sizes, cells, connector routes, label places), reserve its space, and write its title. */
    async runDFrame(op, d) {
      const spec = op.spec;
      if (this.items.has(spec.id)) this.removeItem(spec.id);
      const nodes = spec.parts.filter((p) => p.type === "node").map((p) => ({ id: p.id, label: p.label, shape: p.shape, in: p.in }));
      const links = spec.parts.filter((p) => p.type === "link").map((p) => ({ id: p.id, from: p.from, to: p.to, label: p.label, style: p.style }));
      const measure = (text, o) => { const t = hand.typesetText(text, { size: o.size, maxWidth: o.maxWidth, seed: text }); return { w: t.width, h: t.height }; };
      const page = { maxW: BOARD.width - 2 * MARGIN, maxH: BOARD.height - 2 * MARGIN };
      let keptNodes = nodes, keptLinks = links; const dropped = [];
      const arrange = () => Diagram.layoutDiagram({ title: spec.title, layout: spec.layout, cols: spec.cols, nodes: keptNodes, links: keptLinks }, measure, page);
      let layout = arrange();
      // Nothing may leave the page, and nothing is shrunk: if even the most compact arrangement is too big, leave out the last nodes.
      while (!layout.fits && keptNodes.filter((n) => !n.in).length > 2) {
        const last = [...keptNodes].reverse().find((n) => !n.in), gone = new Set([last.id, ...keptNodes.filter((n) => n.in === last.id).map((n) => n.id)]);
        keptNodes = keptNodes.filter((n) => !gone.has(n.id)); keptLinks = keptLinks.filter((l) => !gone.has(l.from) && !gone.has(l.to)); dropped.push(...gone);
        layout = arrange();
      }
      if (layout.arranged) this.log("info", `Diagram "${spec.id}" would not fit a page as asked, so it was arranged ${layout.arranged}.`);
      if (dropped.length) this.log("warn", `Diagram "${spec.id}" was too big for one page: left out ${dropped.join(", ")}. Use fewer nodes, shorter labels, or two diagrams.`);
      if (layout.warnings.length) this.log("warn", `Diagram "${spec.id}": ${layout.warnings.join("; ")}`);
      const spot = this.reserve(spec.id, layout.w, layout.h, { flow: "any", near: spec.near, side: spec.side, calc: spec.calc });
      const item = this.createItem(spec.id, "diagram", spot.page);
      item.g.setAttribute("transform", `translate(${num(spot.x)} ${num(spot.y)})`);
      item.frame = { x: spot.x, y: spot.y, w: spot.w, h: spot.h };
      item.bbox = { ...item.frame }; item.layout = layout; item.text = spec.title || "";
      this.emit();
      if (spec.title && layout.title) {
        const t = hand.typesetText(spec.title, { size: Diagram.TITLE_SIZE, maxWidth: layout.w, seed: spec.title });
        const built = this.buildHand(item.g, t.strokes.map((s) => s.map(([x, y]) => [x + layout.title.x, y + layout.title.y])), colorVar("ink"), clamp(Diagram.TITLE_SIZE * 0.082, 2.4, 4.4));
        this.stats.handwritten++;
        await this.playHand(built, d(built.timeline.total), { x: spot.x, y: spot.y });
      } else await this.tween(d(120), () => {});
    }

    /** One node: its outline is drawn, then its label is written inside, centred with padding. */
    async runDNode(op, d) {
      const diagram = this.items.get(op.diagram);
      if (!diagram || !diagram.layout) return;
      const L = diagram.layout.nodes.get(op.part.id);
      if (!L) return;
      if (this.items.has(op.part.id)) this.removeItem(op.part.id);
      const item = this.createItem(op.part.id, "node", diagram.page, diagram);
      const offset = { x: diagram.frame.x, y: diagram.frame.y };
      item.bbox = { x: offset.x + L.x, y: offset.y + L.y, w: L.w, h: L.h };
      item.text = L.label;
      this.emit();
      const color = colorVar(op.part.color);
      if (L.shape !== "none") {
        const path = svgEl("path", { d: nodePath(L), fill: "none", stroke: color, "stroke-width": STROKE, "stroke-linecap": "round", "stroke-linejoin": "round" }, item.g);
        await this.drawPath(path, d(msFor(2 * (L.w + L.h), SPEED.line)), offset);
      }
      if (L.label) {
        const t = hand.typesetText(L.label, { size: Diagram.LABEL_SIZE, maxWidth: Diagram.DEFAULTS.labelMaxWidth, seed: L.label });
        const built = this.buildHand(item.g, t.strokes.map((s) => s.map(([x, y]) => [x + L.labelBox.x, y + L.labelBox.y])), color, clamp(Diagram.LABEL_SIZE * 0.085, 2.2, 3.6));
        this.stats.handwritten++;
        await this.playHand(built, d(built.timeline.total), offset);
      }
    }

    /** One connector, drawn along its planned route (never across a node or a label), then its label beside it. */
    async runDLink(op, d) {
      const diagram = this.items.get(op.diagram);
      if (!diagram || !diagram.layout) return;
      const R = diagram.layout.links.find((l) => l.id === op.part.id);
      if (!R) return;
      if (this.items.has(op.part.id)) this.removeItem(op.part.id);
      const item = this.createItem(op.part.id, "link", diagram.page, diagram);
      const offset = { x: diagram.frame.x, y: diagram.frame.y }, xs = R.points.map((p) => p[0]), ys = R.points.map((p) => p[1]);
      item.bbox = { x: offset.x + Math.min(...xs), y: offset.y + Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) || 1, h: Math.max(...ys) - Math.min(...ys) || 1 };
      item.text = op.part.label || "";
      this.emit();
      const color = colorVar(op.part.color), arrow = R.style !== "line";
      const pts = R.points;
      let pathData = linePath(pts, false);
      if (arrow && pts.length >= 2) pathData += arrowHead(pts[pts.length - 2], pts[pts.length - 1], 16);
      const path = svgEl("path", { d: pathData, fill: "none", stroke: color, "stroke-width": 3.5, "stroke-linecap": "round", "stroke-linejoin": "round" }, item.g);
      const ms = d(msFor(polylineLength(pts) + (arrow ? 32 : 0), SPEED.line));
      if (R.style === "dashed") { path.setAttribute("stroke-dasharray", "10 9"); await this.revealPath(path, { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) || 1, h: Math.max(...ys) - Math.min(...ys) || 1 }, ms, offset); }
      else await this.drawPath(path, ms, offset);
      if (R.label && R.labelBox) {
        const t = hand.typesetText(R.label, { size: Diagram.LABEL_SIZE - 4, maxWidth: Diagram.LINK_LABEL_WIDTH, seed: R.label });
        const built = this.buildHand(item.g, t.strokes.map((s) => s.map(([x, y]) => [x + R.labelBox.x, y + R.labelBox.y])), color, 2.4);
        this.stats.handwritten++;
        await this.playHand(built, d(built.timeline.total), offset, SPEED.labelBoost);
      }
    }

    /* ----- Highlight, point, erase, correct, pages ----- */

    async runHighlight(op, d) {
      const item = this.items.get(op.target);
      if (!item || !item.bbox) return;
      if (["text", "math", "graph", "group", "diagram", "node"].includes(item.type)) {
        if (item.marker) item.marker.remove();
        const pad = 8, b = item.bbox, top = item.parent || item;
        const marker = svgEl("rect", { x: b.x - pad, y: b.y - pad / 2, width: 0, height: b.h + pad, rx: 8, fill: colorVar(op.color), style: "opacity:.3;pointer-events:none" });
        item.page.g.insertBefore(marker, top.g); // behind the writing, like highlighter pen
        item.marker = marker;
        await this.tween(d(this.naturalMs(op)), (p) => { marker.setAttribute("width", (b.w + 2 * pad) * p); this.movePencil(b.x - pad + (b.w + 2 * pad) * p, b.y + b.h / 2, p < 1); }, linear);
      } else {
        const strokes = [...item.g.querySelectorAll("path[stroke], circle")].filter((s) => s.getAttribute("stroke") !== "none");
        await this.tween(d(this.naturalMs(op)), (p) => {
          for (const s of strokes) { if (s.tagName === "circle") { s.setAttribute("fill", colorVar(op.color)); continue; } s.style.stroke = colorVar(op.color); s.style.strokeWidth = num(STROKE + 4 * Math.sin(Math.PI * p) + 1.5 * p); }
        });
      }
    }

    /**
     * The teacher points at something already written. If it is on another page the teacher goes there (the student's
     * own view is not moved unless they are following), circles it, and comes back to the page being written.
     */
    async runPointTo(op, d) {
      const item = this.items.get(op.target);
      if (!item || !item.bbox) return;
      const detour = item.page !== this.live;
      if (detour) { this.setLive(item.page); await this.tween(d(300), () => {}); }
      const b = item.bbox, rx = b.w / 2 + 20, ry = b.h / 2 + 14;
      const ring = svgEl("path", { d: ellipsePath(b.x + b.w / 2, b.y + b.h / 2, rx, ry), fill: "none", stroke: colorVar("amber"), "stroke-width": 4, "stroke-linecap": "round", "data-wb-pointer": op.target }, item.page.g);
      try {
        await this.drawPath(ring, d(msFor(2 * Math.PI * Math.sqrt((rx * rx + ry * ry) / 2), SPEED.curve)));
        await this.tween(d(900), () => {});
        await this.tween(d(300), (p) => { ring.style.opacity = num(1 - p); });
      } finally { ring.remove(); }
      if (detour && op.return !== false && this.working) this.setLive(this.working);
    }

    async runErase(target, d) {
      const ids = target === "all" ? this.itemsOf(this.live).filter((i) => !this.items.get(i.id).parent).map((i) => i.id) : [target];
      const items = ids.map((id) => this.items.get(id)).filter(Boolean);
      if (!items.length) return;
      const nodes = items.flatMap((item) => [item.g, item.marker].filter(Boolean));
      await this.tween(d(this.naturalMs({ op: "erase" })), (p) => { for (const n of nodes) n.style.opacity = num(1 - p); });
      for (const id of ids) this.removeItem(id);
      this.emit();
    }

    async runCorrect(op, d, scale) {
      const item = this.items.get(op.target);
      if (!item || !item.bbox) return this.run(op.with, scale);
      const b = item.bbox, page = item.page, group = item.parent && item.parent.type === "group" ? item.parent : null;
      const strike = svgEl("path", { d: `M${num(b.x - 6)} ${num(b.y + b.h / 2)} L${num(b.x + b.w + 6)} ${num(b.y + b.h / 2 - 4)}`, stroke: colorVar("red"), "stroke-width": 5, "stroke-linecap": "round", fill: "none" }, page.g);
      try {
        await this.drawPath(strike, d(msFor(b.w + 12, SPEED.line)));
        await this.tween(d(250), () => {});
      } finally { strike.remove(); }
      await this.runErase(op.target, d);
      // The new version goes where the old one was if it still fits there; otherwise into free space (never on top of anything).
      const replacement = { ...op.with, page };
      if (replacement.op === "write" || replacement.op === "shape") {
        if (group && this.items.get(group.id)) { replacement.group = group.id; if (replacement.op === "write") { replacement.x = b.x - group.frame.x; replacement.y = b.y - group.frame.y; } }
        else if (replacement.op === "write") replacement.prefer = { x: b.x, y: b.y };
      }
      return this.run(replacement, scale);
    }

    /** A new page: a new topic or section starts on a fresh page. Earlier pages are kept. An empty live page is reused. */
    async runNewPage(op, d) {
      if (this.live.ids.size === 0) { if (op.title) this.live.title = op.title; this.emit(); return; }
      const page = this.addPage(op.title);
      this.working = page; this.setLive(page);
      this.log("info", `New page ${page.number}${op.title ? ' "' + op.title + '"' : ""}.`);
      await this.tween(d(250), () => {});
    }
    /** The teacher goes to another page ("latest" returns to the end of the notebook). Writing continues there. */
    async runGoToPage(op, d) {
      const page = this.pageFor(op.page);
      if (!page || page === this.live) return;
      this.setLive(page);
      await this.tween(d(250), () => {});
    }
  }

  root.Whiteboard = Whiteboard;
})(typeof self !== "undefined" ? self : this);
