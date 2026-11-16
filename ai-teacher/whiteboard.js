/* Whiteboard renderer: draws validated instructions (see whiteboard-core.js) onto an SVG board the way a hand does.
 *
 *  - Text, numbers and equations are HANDWRITTEN: each letter is a few pen strokes (whiteboard-hand.js) and
 *    each stroke draws itself while a pencil tip travels along it, lifts and moves to the next stroke.
 *  - Axes, curves, arrows and shapes draw themselves the same way; graph numbers and labels are written too.
 *  - Everything goes through a queue, so new content is added to the board instead of replacing it, and
 *    drawing speed adapts to how long the teacher will keep talking.
 *  - cancelPending() is the "student interrupted" button: the pen finishes the stroke it is on, the rest of
 *    the queue is dropped, and what is already on the board stays.
 *  - Nothing from the AI is ever inserted as HTML.
 *
 * Needs whiteboard-core.js and whiteboard-hand.js first.
 */
(function (root) {
  "use strict";
  const core = root.WhiteboardCore, hand = root.WhiteboardHand;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const { BOARD } = core;

  const INK = { ink: ["#24313a", "#eef3ea"], blue: ["#2459c4", "#8db8ff"], red: ["#c2412d", "#ff8d78"], green: ["#2c7a4b", "#7bd49f"], amber: ["#a8690a", "#f0c35a"], violet: ["#7440b8", "#c9a8f7"] };
  const FONT_SIZE = { title: 46, body: 34, small: 28 };
  const STROKE = 4;
  // Pen speeds in board units per second: how fast a hand moves when writing, drawing a line, or tracing a curve.
  const SPEED = { write: 320, line: 520, curve: 420, axes: 650, labelBoost: 2.2 };

  const STYLE = `
.wb{--wb-paper:#fbfcfa;${Object.entries(INK).map(([n, c]) => `--wb-${n}:${c[0]};`).join("")}display:block;position:relative;background:var(--wb-paper)}
@media (prefers-color-scheme:dark){.wb{--wb-paper:#1e2b27;${Object.entries(INK).map(([n, c]) => `--wb-${n}:${c[1]};`).join("")}}}
.wb-svg{display:block;width:100%;height:100%}
.wb-text{display:inline-block;font-family:var(--hand,"Kalam","Comic Sans MS","Segoe Print",cursive);line-height:1.25;white-space:normal;overflow-wrap:anywhere}
.wb-text.wb-raw{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.8em}
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
  const msFor = (length, speed) => Math.max(120, (length / speed) * 1000);

  class Whiteboard {
    /**
     * @param {HTMLElement} host element to draw into
     * @param {object} [options]
     * @param {number} [options.timeScale] > 1 plays faster (tests), < 1 slow motion
     * @param {boolean} [options.reducedMotion] force the reduced-motion setting (tests)
     * @param {number} [options.cueTimeoutMs] longest a step waits for its spoken cue
     * @param {() => number|null} [options.speechLeftMs] how long the teacher will keep talking (null when unknown)
     * @param {(level:string, message:string) => void} [options.log] diagnostics sink
     * @param {boolean} [options.debugStrokeColors] colour every pen stroke differently, to see stroke order (tests)
     */
    constructor(host, options = {}) {
      this.host = host;
      this.timeScale = options.timeScale || 1;
      this.cueTimeoutMs = options.cueTimeoutMs == null ? 5000 : options.cueTimeoutMs;
      this.speechLeftMs = options.speechLeftMs || null;
      this.debugStrokeColors = !!options.debugStrokeColors;
      this.log = options.log || ((level, message) => (console[level] || console.log)("[Whiteboard] " + message));
      // Read live, so changing the system setting mid-lesson takes effect on the next stroke.
      const motionQuery = root.matchMedia ? root.matchMedia("(prefers-reduced-motion: reduce)") : null;
      this.prefersReducedMotion = () => (options.reducedMotion != null ? options.reducedMotion : !!(motionQuery && motionQuery.matches));
      if (!document.getElementById("wb-style")) { const s = document.createElement("style"); s.id = "wb-style"; s.textContent = STYLE; document.head.appendChild(s); }
      host.classList.add("wb");
      this.svg = svgEl("svg", { class: "wb-svg", viewBox: `0 0 ${BOARD.width} ${BOARD.height}`, role: "img", "aria-label": "Whiteboard, empty" }, host);
      this.layer = svgEl("g", {}, this.svg);
      this.buildPencil();

      this.items = new Map();
      this.queue = [];
      this.running = false;
      this.generation = 0;
      this.jobs = new Set();
      this.current = null;
      this.scheduled = false; this.raf = 0; this.timer = 0;
      this.cueWaiters = new Set();
      this.idleWaiters = [];
      this.spoken = "";
      this.tracking = false;
      this.uid = 0;
      this.typesetCache = new Map();
      // Live counters, so tests and diagnostics can see that real strokes are being drawn.
      this.stats = { strokesTotal: 0, strokesDone: 0, penDown: false, pen: null, handwritten: 0, fallbackText: 0 };
      this.resetFlow();
    }

    buildPencil() {
      // A pencil seen from above-right: its point is the origin, which is what rides along the line being drawn.
      this.pencil = svgEl("g", { style: "opacity:0;pointer-events:none", "data-wb-pencil": "" }, this.svg);
      svgEl("path", { d: "M0 0 L3.2 -8 L15 -40 L24 -36.5 L9 -5.5 Z", fill: "#e9edef", stroke: "#33414a", "stroke-width": 1.6, "stroke-linejoin": "round" }, this.pencil);
      svgEl("path", { d: "M0 0 L3.2 -8 L9 -5.5 Z", fill: "#f0b43a", stroke: "#33414a", "stroke-width": 1.2, "stroke-linejoin": "round" }, this.pencil);
      svgEl("path", { d: "M14.5 -39 L24 -36 L21.5 -30 L12 -33.5 Z", fill: "#c2412d", opacity: 0.9 }, this.pencil);
    }

    /* ----- Public API ----- */

    /** Add validated ops to the end of the queue. They are drawn one after another, never all at once. */
    enqueue(ops) {
      if (!ops || !ops.length) return;
      for (const op of ops) this.queue.push({ op, generation: this.generation });
      this.drain();
    }

    /** The student interrupted: the pen finishes the stroke it is on, everything waiting is dropped, the drawing stays. */
    cancelPending() {
      this.generation++;
      this.queue.length = 0;
      for (const waiter of [...this.cueWaiters]) waiter.release();
      if (this.current) this.current.cancelled = true; // the element in progress stops instead of carrying on animating
      this.finishJobs(true);
    }

    /** Remove everything from the board (no animation). */
    reset() {
      this.cancelPending();
      for (const id of [...this.items.keys()]) this.removeItem(id);
      this.resetFlow();
      this.describe();
    }

    /** Call when the teacher starts a new spoken turn. */
    beginTurn() { this.spoken = ""; this.tracking = false; }

    /** Feed the text of what has actually been spoken so far (from the voice alignment events), so ops with a cue wait for it. */
    speechProgress(text) {
      this.spoken += String(text || "");
      this.tracking = true;
      for (const waiter of [...this.cueWaiters]) if (core.cueSpoken(this.spoken, waiter.cue)) waiter.release();
    }

    /** Resolves when nothing is drawing or waiting. */
    idle() {
      return this.running || this.queue.length ? new Promise((resolve) => this.idleWaiters.push(resolve)) : Promise.resolve();
    }

    /** What is on the board, for the planner: [{id,type,x,y,w,h,text}] */
    summary() {
      return [...this.items.values()].filter((item) => item.bbox).map((item) => ({ id: item.id, type: item.type, ...item.bbox, text: item.text }));
    }
    graphIds() { return [...this.items.values()].filter((item) => item.type === "graph").map((item) => item.id); }
    nextSlot() { return { x: this.flow.x, y: this.flow.y }; }

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
          try { await this.run(entry.op, this.paceFor(entry)); } catch (error) { this.log("warn", "A drawing step failed: " + (error && error.message) + " " + JSON.stringify(entry.op).slice(0, 120)); }
          this.current = null;
        }
      } finally {
        this.running = false; this.current = null;
        this.pencil.style.opacity = 0;
        for (const resolve of this.idleWaiters.splice(0)) resolve();
      }
    }

    /**
     * How fast to draw this step, as a multiplier on its natural duration (< 1 is faster). While the teacher is
     * still talking, the drawing is paced to finish about when the speech does, but never faster than 1.5x a
     * real hand or slower than 1.4x, so it neither appears all at once nor drags on.
     */
    paceFor(entry) {
      const speechLeft = this.speechLeftMs ? this.speechLeftMs() : null;
      if (speechLeft == null) return 1;
      let queued = this.naturalMs(entry.op);
      for (const waiting of this.queue) if (waiting.generation === this.generation) queued += this.naturalMs(waiting.op);
      const scale = clamp((Math.max(0, speechLeft) + 2500) / Math.max(1, queued), 0.65, 1.4);
      return Number.isFinite(scale) ? scale : 1;
    }

    waitForCue(entry) {
      const cue = entry.op.cue;
      // Without voice timing events there is nothing to wait for, so cues are ignored and pacing is time-based.
      if (!cue || !this.tracking || core.cueSpoken(this.spoken, cue)) return Promise.resolve();
      return new Promise((resolve) => {
        const waiter = { cue, release: () => { clearTimeout(timer); this.cueWaiters.delete(waiter); resolve(); } };
        const timer = setTimeout(waiter.release, this.cueTimeoutMs / this.timeScale); // never stall the board on a missed cue
        this.cueWaiters.add(waiter);
      });
    }

    /** Typeset (and remember) the strokes for a write op. */
    typeset(op) {
      const size = FONT_SIZE[op.size] || FONT_SIZE.body;
      const maxWidth = op.w || (op.x === undefined ? (op.size === "title" ? 920 : 440) : Math.min(460, BOARD.width - op.x - 20));
      const key = [op.kind, size, maxWidth, op.content].join("\u0001");
      if (!this.typesetCache.has(key)) {
        if (this.typesetCache.size > 200) this.typesetCache.clear();
        this.typesetCache.set(key, op.kind === "math" ? hand.typesetMath(op.content, { size }) : hand.typesetText(op.content, { size, maxWidth }));
      }
      return { ...this.typesetCache.get(key), size, maxWidth };
    }

    /** How long a step takes at normal hand speed, in ms. Used to pace the drawing against the speech. */
    naturalMs(op) {
      switch (op.op) {
        case "write": { const t = this.typeset(op); return t.unsupported.length && op.kind !== "math" ? 800 : hand.strokeTimeline(t.strokes, { drawSpeed: SPEED.write }).total; }
        case "graph": return msFor(op.w + op.h, SPEED.axes) + 900;
        case "plot": return msFor(this.plotWidth(op) * 1.4, SPEED.curve) + (op.label ? 600 : 0);
        case "point": return 500 + (op.label ? 500 : 0);
        case "shape": return msFor(this.shapeLength(op), op.shape === "curve" ? SPEED.curve : SPEED.line);
        case "highlight": return 650;
        case "erase": return 400;
        case "correct": return 900 + this.naturalMs(op.with);
        case "clear": return 500;
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
        case "plot": return this.runPlot(op, d);
        case "point": return this.runPoint(op, d);
        case "shape": return this.runShape(op, d);
        case "highlight": return this.runHighlight(op, d);
        case "erase": return this.runErase(op.target, d);
        case "correct": return this.runCorrect(op, d, scale);
        case "clear": await this.runErase("all", d); this.resetFlow(); return;
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
      this.pencil.style.opacity = visible ? (down ? 1 : 0.55) : 0; // paler while the pen is lifted and travelling
      this.stats.penDown = !!(visible && down); this.stats.pen = { x, y };
    }

    /* ----- Items ----- */

    resetFlow() { this.flow = { x: 40, y: 34, column: 0 }; }

    createItem(id, type) {
      if (this.items.has(id)) this.removeItem(id); // reusing an id replaces the element
      const g = svgEl("g", { "data-wb-id": id, "data-wb-type": type }, this.layer);
      const item = { id, type, g, children: new Set(), bbox: null, text: "", marker: null };
      this.items.set(id, item);
      return item;
    }
    removeItem(id) {
      const item = this.items.get(id);
      if (!item) return;
      for (const childId of [...item.children]) this.removeItem(childId);
      if (item.marker) item.marker.remove();
      item.g.remove();
      this.items.delete(id);
    }
    describe() {
      const spoken = [...this.items.values()].filter((i) => i.text).map((i) => i.text);
      this.svg.setAttribute("aria-label", spoken.length ? "Whiteboard: " + spoken.join("; ") : "Whiteboard, empty");
    }

    /** Choose where a measured block goes: the author's x,y, or the next free spot in the text flow. */
    place(op, width, height) {
      let x, y;
      if (op.x !== undefined) { x = op.x; y = op.y; }
      else {
        if (this.flow.column === 0 && this.flow.y + height > BOARD.height - 20) { this.flow.column = 1; this.flow.x = 520; this.flow.y = 34; }
        x = this.flow.x; y = this.flow.y;
        this.flow.y = y + height + 12;
      }
      return { x: clamp(x, 6, Math.max(6, BOARD.width - width - 6)), y: clamp(y, 6, Math.max(6, BOARD.height - height - 6)) };
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
      const strokes = [];
      for (const label of labels) {
        const typeset = hand.typesetText(label.text, { size: label.size || size, seed: label.text });
        const dx = label.anchor === "end" ? -typeset.width : label.anchor === "middle" ? -typeset.width / 2 : 0;
        strokes.push(...typeset.strokes.map((stroke) => stroke.map(([x, y]) => [x + label.x + dx, y + label.y - typeset.baseline])));
      }
      if (!strokes.length) return null;
      const built = this.buildHand(parent, strokes, color, clamp(size * 0.09, 1.8, 3));
      await this.playHand(built, d(built.timeline.total), offset, SPEED.labelBoost);
      return built;
    }

    async runWrite(op, d) {
      const typeset = this.typeset(op);
      const drawable = typeset.strokes.length && (op.kind === "math" || !typeset.unsupported.length);
      if (typeset.unsupported.length) this.log("warn", `${op.kind === "math" ? "Maths" : "Text"} contains things the handwriting font cannot draw (${typeset.unsupported.join(" ")}): ${op.kind === "math" ? "drawing the rest" : "using the typed-text fallback"}.`);
      if (!drawable) return this.runWriteFallback(op, d, typeset);

      const item = this.createItem(op.id, op.kind === "math" ? "math" : "text");
      const { x, y } = this.place(op, typeset.width, typeset.height);
      item.g.setAttribute("transform", `translate(${num(x)} ${num(y)})`);
      item.bbox = { x, y, w: typeset.width, h: typeset.height };
      item.text = op.content;
      this.describe();
      const built = this.buildHand(item.g, typeset.strokes, colorVar(op.color), clamp(typeset.size * 0.082, 2.4, 4.4));
      this.stats.handwritten++;
      await this.playHand(built, d(built.timeline.total), { x, y });
      if (built.interrupted) item.text += " (unfinished)";
    }

    /** Last resort for text the stroke font cannot draw (other alphabets): typed text, wiped in left to right. */
    async runWriteFallback(op, d, typeset) {
      this.stats.fallbackText++;
      const item = this.createItem(op.id, "text");
      const size = typeset.size, maxWidth = typeset.maxWidth;
      const fo = svgEl("foreignObject", { x: 0, y: 0, width: maxWidth + 40, height: 400 }, item.g);
      const box = document.createElement("div");
      box.className = "wb-text" + (op.kind === "math" ? " wb-raw" : "");
      box.style.cssText = `font-size:${size}px;color:${colorVar(op.color)};max-width:${maxWidth}px;${op.size === "title" ? "font-weight:700;" : ""}`;
      box.textContent = op.content;
      fo.appendChild(box);
      void box.offsetWidth;
      const width = Math.ceil(box.offsetWidth) + 8, height = Math.ceil(box.offsetHeight) + 8;
      fo.setAttribute("width", width); fo.setAttribute("height", height);
      const { x, y } = this.place(op, width, height);
      item.g.setAttribute("transform", `translate(${num(x)} ${num(y)})`);
      item.bbox = { x, y, w: width, h: height };
      item.text = op.content;
      this.describe();
      const wipe = (p) => { box.style.clipPath = p >= 1 ? "" : `inset(-8px ${num((1 - p) * 100)}% -8px -8px)`; };
      wipe(0);
      await this.tween(d(900 + op.content.length * 40), (p) => { wipe(p); this.movePencil(x + p * width, y + height * 0.7, p < 1); }, linear);
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
    async revealPath(path, bbox, ms) {
      const id = "wbclip" + ++this.uid;
      const clip = svgEl("clipPath", { id }, path.parentNode);
      const rect = svgEl("rect", { x: bbox.x - 10, y: bbox.y - 10, width: 0, height: bbox.h + 20 }, clip);
      path.setAttribute("clip-path", `url(#${id})`);
      await this.tween(ms, (p) => {
        rect.setAttribute("width", (bbox.w + 20) * p);
        this.movePencil(bbox.x + bbox.w * p, bbox.y + bbox.h / 2, p < 1);
      }, linear);
      path.removeAttribute("clip-path"); clip.remove();
    }

    async fadeIn(element, ms, to = 1) {
      element.style.opacity = 0;
      await this.tween(ms, (p) => { element.style.opacity = num(p * to); });
    }

    // ----- shapes -----
    async runShape(op, d) {
      const item = this.createItem(op.id, "shape");
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

      const closed = ["rect", "circle", "ellipse", "polygon"].includes(op.shape);
      let fill = null;
      if (op.fill && closed) fill = svgEl("path", { d: pathData, fill: colorVar(op.color), stroke: "none", style: "opacity:0" }, item.g);
      const path = svgEl("path", { d: pathData, fill: "none", stroke: colorVar(op.color), "stroke-width": STROKE, "stroke-linecap": "round", "stroke-linejoin": "round" }, item.g);
      const box = item.g.getBBox();
      item.bbox = { x: box.x, y: box.y, w: box.width, h: box.height };
      item.text = "";
      const ms = d(this.naturalMs(op));
      if (op.dashed) {
        path.setAttribute("stroke-dasharray", "12 10");
        await this.revealPath(path, item.bbox, ms);
      } else {
        await this.drawPath(path, ms);
      }
      if (fill) await this.fadeIn(fill, d(250), 0.16);
    }

    // ----- graphs -----
    async runGraph(op, d) {
      const item = this.createItem(op.id, "graph");
      const margin = { l: 50, r: 18, t: 16, b: 38 };
      const plotW = op.w - margin.l - margin.r, plotH = op.h - margin.t - margin.b;
      const sx = (v) => margin.l + ((v - op.xmin) / (op.xmax - op.xmin)) * plotW;
      const sy = (v) => margin.t + plotH - ((v - op.ymin) / (op.ymax - op.ymin)) * plotH;
      item.g.setAttribute("transform", `translate(${op.x} ${op.y})`);
      item.graph = { op, margin, plotW, plotH, sx, sy, axisX: 0 };
      item.bbox = { x: op.x, y: op.y, w: op.w, h: op.h };
      const offset = { x: op.x, y: op.y };

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
      await this.writeLabels(item.g, labels, "currentColor", offset, d, 22);
      const axisLabels = [];
      if (op.xlabel) axisLabels.push({ text: op.xlabel, x: margin.l + plotW - 4, y: axisY - 12, anchor: "end" });
      if (op.ylabel) axisLabels.push({ text: op.ylabel, x: axisX + 12, y: margin.t + 14, anchor: "start" });
      await this.writeLabels(item.g, axisLabels, "currentColor", offset, d, 28);
      item.text = [op.xlabel, op.ylabel].filter(Boolean).join(" vs ");
      this.describe();
    }

    graphChild(graphItem, id, type) {
      const item = this.createItem(id, type);
      item.g.setAttribute("transform", graphItem.g.getAttribute("transform"));
      graphItem.children.add(id);
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
      let pathData = "", previous = null, last = null, labelPoint = null;
      for (let i = 0; i <= samples; i++) {
        const x = from + ((to - from) * i) / samples, y = evaluate(x);
        const usable = Number.isFinite(y) && y > graph.ymin - rangeY * 3 && y < graph.ymax + rangeY * 3;
        if (!usable || (previous !== null && Math.abs(y - previous) > rangeY * 2)) { previous = usable ? y : null; if (usable) pathData += ` M${num(sx(x))} ${num(sy(y))}`; continue; } // break the line at gaps like tan(x)
        pathData += (previous === null ? " M" : " L") + num(sx(x)) + " " + num(sy(y));
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
      if (op.label && labelPoint) {
        // Beside the curve, but never across the y axis or its letter.
        const labelWidth = hand.typesetText(op.label, { size: 26 }).width;
        const right = clamp(sx(labelPoint.x) - 14, axisX + 18 + labelWidth, margin.l + plotW);
        await this.writeLabels(item.g, [{ text: op.label, x: right, y: clamp(sy(labelPoint.y) + 6, margin.t + 30, margin.t + plotH), anchor: "end" }], colorVar(op.color), offset, d, 26);
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
      if (op.label) await this.writeLabels(item.g, [{ text: op.label, x: cx + 14, y: cy - 12, anchor: "start" }], colorVar(op.color), offset, d, 26);
    }

    /* ----- Highlight, erase, correct ----- */

    async runHighlight(op, d) {
      const item = this.items.get(op.target);
      if (!item || !item.bbox) return;
      if (["text", "math", "graph"].includes(item.type)) {
        if (item.marker) item.marker.remove();
        const pad = 8, b = item.bbox;
        const marker = svgEl("rect", { x: b.x - pad, y: b.y - pad / 2, width: 0, height: b.h + pad, rx: 8, fill: colorVar(op.color), style: "opacity:.3;pointer-events:none" });
        this.layer.insertBefore(marker, item.g); // behind the writing, like highlighter pen
        item.marker = marker;
        await this.tween(d(this.naturalMs(op)), (p) => { marker.setAttribute("width", (b.w + 2 * pad) * p); this.movePencil(b.x - pad + (b.w + 2 * pad) * p, b.y + b.h / 2, p < 1); }, linear);
      } else {
        const strokes = [...item.g.querySelectorAll("path[stroke], circle")].filter((s) => s.getAttribute("stroke") !== "none");
        await this.tween(d(this.naturalMs(op)), (p) => {
          for (const s of strokes) { if (s.tagName === "circle") { s.setAttribute("fill", colorVar(op.color)); continue; } s.style.stroke = colorVar(op.color); s.style.strokeWidth = num(STROKE + 4 * Math.sin(Math.PI * p) + 1.5 * p); }
        });
      }
    }

    async runErase(target, d) {
      const ids = target === "all" ? [...this.items.keys()] : [target];
      const items = ids.map((id) => this.items.get(id)).filter(Boolean);
      if (!items.length) return;
      const nodes = items.flatMap((item) => [item.g, item.marker].filter(Boolean));
      await this.tween(d(this.naturalMs({ op: "erase" })), (p) => { for (const n of nodes) n.style.opacity = num(1 - p); });
      for (const id of ids) this.removeItem(id);
      if (!this.items.size) this.resetFlow();
      this.describe();
    }

    async runCorrect(op, d, scale) {
      const item = this.items.get(op.target);
      if (!item || !item.bbox) return this.run(op.with, scale);
      const b = item.bbox;
      const strike = svgEl("path", { d: `M${num(b.x - 6)} ${num(b.y + b.h / 2)} L${num(b.x + b.w + 6)} ${num(b.y + b.h / 2 - 4)}`, stroke: colorVar("red"), "stroke-width": 5, "stroke-linecap": "round", fill: "none" }, this.layer);
      await this.drawPath(strike, d(msFor(b.w + 12, SPEED.line)));
      await this.tween(d(250), () => {});
      strike.remove();
      await this.runErase(op.target, d);
      const replacement = { ...op.with };
      if (replacement.op === "write" && replacement.x === undefined) { replacement.x = b.x; replacement.y = b.y; } // new text lands where the old one was
      return this.run(replacement, scale);
    }
  }

  root.Whiteboard = Whiteboard;
})(typeof self !== "undefined" ? self : this);
