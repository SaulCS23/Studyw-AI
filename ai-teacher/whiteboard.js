/* Whiteboard renderer: draws validated instructions (see whiteboard-core.js) onto an SVG board, one stroke at a time.
 *
 *  - Everything is drawn through a queue, so new content is added to the board instead of replacing it.
 *  - Each element is animated: strokes draw themselves with a pencil tip leading them, text and
 *    equations are written left to right.
 *  - cancelPending() is the "student interrupted" button: it finishes the stroke in progress, drops
 *    everything still waiting, and keeps what is already on the board.
 *  - Nothing from the AI is ever inserted as HTML. Text goes in through textContent, maths through KaTeX.
 *
 * Needs whiteboard-core.js first. KaTeX is optional: without it, equations show as plain LaTeX.
 */
(function (root) {
  "use strict";
  const core = root.WhiteboardCore;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const { BOARD } = core;

  const INK = { ink: ["#24313a", "#eef3ea"], blue: ["#2459c4", "#8db8ff"], red: ["#c2412d", "#ff8d78"], green: ["#2c7a4b", "#7bd49f"], amber: ["#a8690a", "#f0c35a"], violet: ["#7440b8", "#c9a8f7"] };
  const FONT_SIZE = { title: 46, body: 34, small: 28 };
  const STROKE = 4;

  const STYLE = `
.wb{--wb-paper:#fbfcfa;${Object.entries(INK).map(([n, c]) => `--wb-${n}:${c[0]};`).join("")}display:block;position:relative;background:var(--wb-paper)}
@media (prefers-color-scheme:dark){.wb{--wb-paper:#1e2b27;${Object.entries(INK).map(([n, c]) => `--wb-${n}:${c[1]};`).join("")}}}
.wb-svg{display:block;width:100%;height:100%}
.wb-text{display:inline-block;font-family:var(--hand,"Kalam","Comic Sans MS","Segoe Print",cursive);line-height:1.25;white-space:normal;overflow-wrap:anywhere}
.wb-text.wb-raw{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.8em}
.wb-text .katex{font-size:1.1em}
.wb-tick{font-family:var(--hand,"Kalam",cursive);font-size:20px;fill:currentColor}
.wb-label{font-family:var(--hand,"Kalam",cursive);font-size:26px}
`;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const linear = (t) => t;
  const colorVar = (name) => `var(--wb-${INK[name] ? name : "ink"})`;

  function svgEl(tag, attributes, parent) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes || {})) element.setAttribute(key, value);
    if (parent) parent.appendChild(element);
    return element;
  }

  /* ---------- Path builders (board coordinates) ---------- */

  const num = (v) => +v.toFixed(2);
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

  class Whiteboard {
    /**
     * @param {HTMLElement} host element to draw into
     * @param {{timeScale?:number, reducedMotion?:boolean, cueTimeoutMs?:number}} [options] timeScale > 1 plays faster (tests)
     */
    constructor(host, options = {}) {
      this.host = host;
      this.timeScale = options.timeScale || 1;
      this.cueTimeoutMs = options.cueTimeoutMs == null ? 5000 : options.cueTimeoutMs;
      // Read live, so changing the system setting mid-lesson takes effect on the next stroke.
      const motionQuery = root.matchMedia ? root.matchMedia("(prefers-reduced-motion: reduce)") : null;
      this.prefersReducedMotion = () => (options.reducedMotion != null ? options.reducedMotion : !!(motionQuery && motionQuery.matches));
      if (!document.getElementById("wb-style")) { const s = document.createElement("style"); s.id = "wb-style"; s.textContent = STYLE; document.head.appendChild(s); }
      host.classList.add("wb");
      this.svg = svgEl("svg", { class: "wb-svg", viewBox: `0 0 ${BOARD.width} ${BOARD.height}`, role: "img", "aria-label": "Whiteboard, empty" }, host);
      this.layer = svgEl("g", {}, this.svg);
      this.pencil = svgEl("g", { style: "opacity:0;pointer-events:none" }, this.svg);
      svgEl("circle", { r: 7, fill: "#e8b23a", stroke: "#3a2a05", "stroke-width": 2 }, this.pencil);

      this.items = new Map();
      this.queue = [];
      this.running = false;
      this.generation = 0;
      this.jobs = new Set();
      this.current = null;
      this.raf = 0; this.scheduled = false; this.timer = 0;
      this.cueWaiters = new Set();
      this.idleWaiters = [];
      this.spoken = "";
      this.tracking = false;
      this.uid = 0;
      this.resetFlow();
    }

    /* ----- Public API ----- */

    /** Add validated ops to the end of the queue. budgetMs is how long the teacher will probably keep talking. */
    enqueue(ops, { budgetMs } = {}) {
      if (!ops || !ops.length) return;
      const natural = ops.reduce((sum, op) => sum + this.naturalMs(op), 0);
      // Squeeze or stretch the drawing to fit the speech, within limits so it never looks frantic or frozen.
      const scale = budgetMs ? clamp(budgetMs / natural, 0.5, 1.6) : 1;
      for (const op of ops) this.queue.push({ op, scale, generation: this.generation });
      this.drain();
    }

    /** The student interrupted: finish the stroke in progress, drop everything waiting, keep the drawing. */
    cancelPending() {
      this.generation++;
      this.queue.length = 0;
      for (const waiter of [...this.cueWaiters]) waiter.release();
      if (this.current) this.current.cancelled = true; // the element in progress finishes instantly instead of carrying on animating
      this.finishJobs();
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
          try { await this.run(entry.op, entry.scale); } catch (error) { console.warn("Whiteboard op failed", entry.op, error); }
          this.current = null;
        }
      } finally {
        this.running = false; this.current = null;
        this.pencil.style.opacity = 0;
        for (const resolve of this.idleWaiters.splice(0)) resolve();
      }
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

    naturalMs(op) {
      switch (op.op) {
        case "write": return op.kind === "math" ? 700 + op.content.length * 45 : 350 + Math.min(op.content.length, 80) * 42;
        case "graph": return 1100;
        case "plot": return 1400;
        case "point": return 400;
        case "shape": return ["line", "arrow"].includes(op.shape) ? 600 : 1000;
        case "highlight": return 650;
        case "erase": return 400;
        case "correct": return 900 + this.naturalMs(op.with);
        case "clear": return 500;
        case "pause": return op.ms;
        default: return 500;
      }
    }

    async run(op, scale) {
      const d = (ms) => (ms * scale) / this.timeScale;
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

    tween(ms, step, ease = easeInOut) {
      if (ms <= 0 || this.prefersReducedMotion() || document.hidden || (this.current && this.current.cancelled)) { step(1); return Promise.resolve(); }
      return new Promise((resolve) => {
        this.jobs.add({ ms, step, ease, resolve, start: null });
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
    finishJobs() {
      for (const job of [...this.jobs]) { job.step(1); this.jobs.delete(job); job.resolve(); }
    }
    movePencil(x, y, visible) {
      this.pencil.setAttribute("transform", `translate(${num(x)} ${num(y)})`);
      this.pencil.style.opacity = visible ? 1 : 0;
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

    /* ----- Writing ----- */

    async runWrite(op, d) {
      const item = this.createItem(op.id, op.kind === "math" ? "math" : "text");
      const fontSize = FONT_SIZE[op.size] || FONT_SIZE.body;
      const maxWidth = op.w || (op.x === undefined ? (op.size === "title" ? 920 : 440) : Math.min(460, BOARD.width - op.x - 20));
      const fo = svgEl("foreignObject", { x: 0, y: 0, width: maxWidth + 40, height: 400 }, item.g);
      const box = document.createElement("div");
      box.className = "wb-text";
      box.style.cssText = `font-size:${fontSize}px;color:${colorVar(op.color)};max-width:${maxWidth}px;${op.size === "title" ? "font-weight:700;" : ""}`;
      fo.appendChild(box);

      if (op.kind === "math" && root.katex) {
        try { root.katex.render(op.content, box, { throwOnError: false, strict: "ignore", trust: false, maxExpand: 200, maxSize: 20 }); }
        catch (error) { box.textContent = op.content; box.classList.add("wb-raw"); }
      } else {
        box.textContent = op.content;
        if (op.kind === "math") box.classList.add("wb-raw"); // KaTeX did not load: show the LaTeX as plain text
      }

      void box.offsetWidth; // start any font loads, then wait briefly so we measure with the real fonts
      if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, sleep(1200)]);
      const width = Math.ceil(box.offsetWidth) + 8, height = Math.ceil(box.offsetHeight) + 8;
      fo.setAttribute("width", width); fo.setAttribute("height", height);
      const { x, y } = this.place(op, width, height);
      item.g.setAttribute("transform", `translate(${num(x)} ${num(y)})`);
      item.bbox = { x, y, w: width, h: height };
      item.text = op.kind === "math" ? op.content : op.content;
      this.describe();

      // Write it left to right, the pencil riding the leading edge.
      const wipe = (p) => { box.style.clipPath = p >= 1 ? "" : `inset(-8px ${num((1 - p) * 100)}% -8px -8px)`; };
      wipe(0);
      await this.tween(d(this.naturalMs(op)), (p) => { wipe(p); this.movePencil(x + p * width, y + height * 0.7, p < 1); }, linear);
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
      });
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
      if (op.dashed) {
        path.setAttribute("stroke-dasharray", "12 10");
        await this.revealPath(path, item.bbox, d(this.naturalMs(op)));
      } else {
        await this.drawPath(path, d(this.naturalMs(op)));
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
      item.graph = { op, margin, plotW, plotH, sx, sy };
      item.bbox = { x: op.x, y: op.y, w: op.w, h: op.h };

      const axisX = op.xmin <= 0 && op.xmax >= 0 ? sx(0) : margin.l;
      const axisY = op.ymin <= 0 && op.ymax >= 0 ? sy(0) : margin.t + plotH;
      const xTicks = core.niceTicks(op.xmin, op.xmax, 7), yTicks = core.niceTicks(op.ymin, op.ymax, 6);
      const stroke = { fill: "none", stroke: "currentColor", "stroke-linecap": "round", "stroke-linejoin": "round" };
      item.g.style.color = colorVar("ink");

      if (op.grid) {
        const grid = svgEl("path", { ...stroke, "stroke-width": 1, d: xTicks.map((v) => `M${num(sx(v))} ${margin.t} v${plotH}`).join(" ") + yTicks.map((v) => ` M${margin.l} ${num(sy(v))} h${plotW}`).join(" "), style: "opacity:0" }, item.g);
        await this.fadeIn(grid, d(250), 0.18);
      }
      const xAxis = svgEl("path", { ...stroke, "stroke-width": 3, d: `M${margin.l - 6} ${num(axisY)} H${num(margin.l + plotW)}` + arrowHead([margin.l + plotW - 20, axisY], [margin.l + plotW, axisY], 12) }, item.g);
      const yAxis = svgEl("path", { ...stroke, "stroke-width": 3, style: "opacity:0", d: `M${num(axisX)} ${margin.t + plotH + 6} V${margin.t}` + arrowHead([axisX, margin.t + 20], [axisX, margin.t], 12) }, item.g);
      await this.drawPath(xAxis, d(350), { x: op.x, y: op.y });
      await this.drawPath(yAxis, d(350), { x: op.x, y: op.y });

      const ticks = svgEl("g", { style: "opacity:0" }, item.g);
      const tickLabel = (text, x, y, anchor) => { const t = svgEl("text", { class: "wb-tick", x: num(x), y: num(y), "text-anchor": anchor }, ticks); t.textContent = text; };
      for (const v of xTicks) { if (Math.abs(v) < 1e-9 && axisX !== margin.l) continue; svgEl("path", { ...stroke, "stroke-width": 2, d: `M${num(sx(v))} ${num(axisY - 5)} v10` }, ticks); tickLabel(String(v), sx(v), axisY + 24, "middle"); }
      for (const v of yTicks) { if (Math.abs(v) < 1e-9 && axisY !== margin.t + plotH) continue; svgEl("path", { ...stroke, "stroke-width": 2, d: `M${num(axisX - 5)} ${num(sy(v))} h10` }, ticks); tickLabel(String(v), axisX - 10, sy(v) + 5, "end"); }
      if (op.xlabel) { const t = svgEl("text", { class: "wb-label", x: margin.l + plotW, y: num(axisY - 10), "text-anchor": "end", fill: "currentColor" }, ticks); t.textContent = op.xlabel; }
      if (op.ylabel) { const t = svgEl("text", { class: "wb-label", x: num(axisX + 10), y: margin.t + 8, fill: "currentColor" }, ticks); t.textContent = op.ylabel; }
      await this.fadeIn(ticks, d(250));
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
      const { op: graph, margin, plotW, plotH, sx, sy } = graphItem.graph;
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
      await this.drawPath(path, d(this.naturalMs(op)), { x: graphItem.bbox.x, y: graphItem.bbox.y });
      if (op.label && labelPoint) {
        const t = svgEl("text", { class: "wb-label", x: clamp(sx(labelPoint.x) - 14, margin.l + 60, margin.l + plotW), y: clamp(sy(labelPoint.y) + 4, margin.t + 20, margin.t + plotH), "text-anchor": "end", fill: colorVar(op.color) }, item.g);
        t.textContent = op.label;
        await this.fadeIn(t, d(250));
      }
    }

    async runPoint(op, d) {
      const graphItem = this.items.get(op.graph);
      if (!graphItem || !graphItem.graph) return;
      const { sx, sy } = graphItem.graph;
      const item = this.graphChild(graphItem, op.id, "point");
      const cx = sx(op.px), cy = sy(op.py);
      const dot = svgEl("circle", { cx: num(cx), cy: num(cy), r: 0, fill: colorVar(op.color) }, item.g);
      let label = null;
      if (op.label) { label = svgEl("text", { class: "wb-label", x: num(cx + 12), y: num(cy - 10), fill: colorVar(op.color), style: "opacity:0" }, item.g); label.textContent = op.label; }
      this.movePencil(graphItem.bbox.x + cx, graphItem.bbox.y + cy, true);
      await this.tween(d(this.naturalMs(op)), (p) => { dot.setAttribute("r", num(7 * p)); if (label) label.style.opacity = p; });
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
      await this.drawPath(strike, d(350));
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
