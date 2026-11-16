/* Semantic diagram layout: turns "these things, connected like this" into a clean picture.
 *
 * Claude describes a diagram as NODES (a labelled shape) and LINKS (a connector between two nodes, with an optional
 * label). It does not give coordinates. This module decides everything geometric, so the result is always tidy:
 *
 *  - Text inside a shape always has padding: a box is the label plus margins; an ellipse or circle is sized so the
 *    whole label fits inside the curve. Labels are wrapped, never shrunk.
 *  - Nodes sit in a grid of equal cells (a row, a column, a grid, or a ring for a cycle), with wide gutters between
 *    cells. A container node (a cell, a leaf) holds its children inside, with its own title above them.
 *  - Connectors run from border to border. A straight line is used when nothing is in the way; otherwise the route
 *    follows the gutters (channels between cells), which by construction never cross a node or its label.
 *  - A connector's label is placed beside its line, on whichever side is free: never on the line, never on a node,
 *    never on another label.
 *  - The title has its own band above the diagram.
 *
 * Pure (no DOM): text is measured through a function the caller passes in. All coordinates are local to the diagram's
 * frame, with its top-left at (0, 0). Unit-tested in Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WhiteboardDiagram = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LABEL_SIZE = 28, TITLE_SIZE = 38, LINK_LABEL_WIDTH = 120; // connector labels wrap at this width, so long ones do not widen the gutters
  const PAD = { x: 18, y: 12 };           // space between a label and the border of its box
  const FRAME_PAD = 24;                   // an empty channel around the whole grid, so routes can go around the outside
  const CLEAR = 7;                        // how far connectors keep from nodes, and labels from lines
  const DEFAULTS = { maxW: 928, maxH: 528, labelMaxWidth: 190, minGutterX: 84, minGutterY: 68, innerGap: 24, titleGap: 22 };

  /* ---------- Geometry ---------- */

  const inflate = (r, p) => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p });
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const inside = (inner, outer, margin) => inner.x >= outer.x + margin - 1e-6 && inner.y >= outer.y + margin - 1e-6 && inner.x + inner.w <= outer.x + outer.w - margin + 1e-6 && inner.y + inner.h <= outer.y + outer.h - margin + 1e-6;

  /** Does the segment p-q touch the rectangle? (Liang-Barsky clipping.) */
  function segmentHitsRect(p, q, r) {
    let t0 = 0, t1 = 1; const dx = q[0] - p[0], dy = q[1] - p[1];
    const clip = (pp, qq) => {
      if (pp === 0) return qq >= 0;
      const t = qq / pp;
      if (pp < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
      return true;
    };
    return clip(-dx, p[0] - r.x) && clip(dx, r.x + r.w - p[0]) && clip(-dy, p[1] - r.y) && clip(dy, r.y + r.h - p[1]);
  }
  const polylineHitsRect = (points, r) => points.some((p, i) => i > 0 && segmentHitsRect(points[i - 1], p, r));
  const polylineLength = (points) => points.reduce((sum, p, i) => (i ? sum + Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) : 0), 0);
  const simplify = (points) => { // drop repeated and collinear points
    const out = [];
    for (const p of points) {
      if (out.length && Math.abs(out[out.length - 1][0] - p[0]) < 1e-6 && Math.abs(out[out.length - 1][1] - p[1]) < 1e-6) continue;
      out.push([p[0], p[1]]);
      while (out.length >= 3) {
        const a = out[out.length - 3], b = out[out.length - 2], c = out[out.length - 1];
        if ((Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(b[0] - c[0]) < 1e-6) || (Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(b[1] - c[1]) < 1e-6)) out.splice(out.length - 2, 1); else break;
      }
    }
    return out;
  };
  /** Where the ray from the node's centre toward `toward` leaves the node's outline. */
  function borderPoint(node, toward) {
    const cx = node.x + node.w / 2, cy = node.y + node.h / 2, dx = toward[0] - cx, dy = toward[1] - cy;
    if (!dx && !dy) return [cx, cy];
    if (node.shape === "ellipse" || node.shape === "circle") {
      const a = node.w / 2, b = node.h / 2, k = 1 / Math.sqrt((dx * dx) / (a * a) + (dy * dy) / (b * b));
      return [cx + dx * k, cy + dy * k];
    }
    const k = Math.min(dx ? node.w / 2 / Math.abs(dx) : Infinity, dy ? node.h / 2 / Math.abs(dy) : Infinity);
    return [cx + dx * k, cy + dy * k];
  }
  /** Is the point on the outline-facing side `side` of the node? Used to start a route straight out of a side. */
  function sidePoint(node, side) {
    const cx = node.x + node.w / 2, cy = node.y + node.h / 2;
    return side === "top" ? [cx, node.y] : side === "bottom" ? [cx, node.y + node.h] : side === "left" ? [node.x, cy] : [node.x + node.w, cy];
  }

  /* ---------- Sizes ---------- */

  /** How big a node must be so that its label sits inside with proper padding. */
  function nodeSize(label, shape, measure, options) {
    const t = label ? measure(label, { size: LABEL_SIZE, maxWidth: options.labelMaxWidth }) : { w: 0, h: 0 }, lw = Math.ceil(t.w), lh = Math.ceil(t.h);
    // A curve needs a lot of room around a long label (and looks awkward): a plain rounded box is cleaner.
    if ((shape === "circle" || shape === "ellipse") && (lw > 120 || lh > 40)) shape = "rounded";
    let w, h;
    if (shape === "none") { w = lw + 8; h = lh + 8; }
    else if (shape === "ellipse") { w = Math.ceil(lw * 1.5 + 28); h = Math.ceil(lh * 1.5 + 20); }
    else if (shape === "circle") { w = h = Math.ceil(Math.hypot(lw, lh) * 1.25 + 22); } // the label's corners stay well inside the curve
    else { w = lw + 2 * PAD.x; h = lh + 2 * PAD.y; }
    return { w, h, lw, lh, shape };
  }

  /* ---------- Layout plans ---------- */

  const RINGS = {
    3: { cols: 2, rows: 2, order: [[0, 0], [1, 0], [1, 1]] },
    4: { cols: 2, rows: 2, order: [[0, 0], [1, 0], [1, 1], [0, 1]] },
    5: { cols: 3, rows: 2, order: [[0, 0], [1, 0], [2, 0], [2, 1], [0, 1]] },
    6: { cols: 3, rows: 2, order: [[0, 0], [1, 0], [2, 0], [2, 1], [1, 1], [0, 1]] },
    7: { cols: 3, rows: 3, order: [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2]] },
    8: { cols: 3, rows: 3, order: [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]] },
  };
  function gridPlan(count, layout, wantedCols, maxCols) {
    if (layout === "cycle" && count >= 3) { const ring = RINGS[Math.min(8, count)]; return { cols: ring.cols, rows: ring.rows, cells: ring.order.slice(0, count) }; }
    let cols = layout === "column" ? 1 : layout === "row" ? count : wantedCols || Math.ceil(Math.sqrt(count));
    cols = Math.max(1, Math.min(cols, maxCols, count));
    return { cols, rows: Math.ceil(count / cols), cells: Array.from({ length: count }, (_, i) => [i % cols, Math.floor(i / cols)]) };
  }

  /* ---------- The layout ---------- */

  /**
   * @param {{title?:string, layout?:string, cols?:number, nodes:{id:string,label:string,shape?:string,in?:string}[],
   *          links:{id:string,from:string,to:string,label?:string,style?:string}[]}} spec
   * @param {(text:string, o:{size:number,maxWidth:number}) => {w:number,h:number}} measure size of handwritten text
   * @returns {{w:number,h:number,fits:boolean,title:object|null,nodes:Map,links:object[],warnings:string[]}}
   */
  function layoutOnce(spec, measure, options) {
    const o = { ...DEFAULTS, ...(options || {}) }, warnings = [];
    const byId = new Map(spec.nodes.map((n) => [n.id, { ...n, shape: n.shape || "rounded" }]));
    const children = new Map(); for (const n of byId.values()) if (n.in && byId.has(n.in)) { if (!children.has(n.in)) children.set(n.in, []); children.get(n.in).push(n); }
    const topLevel = [...byId.values()].filter((n) => !(n.in && byId.has(n.in)));

    // 1. Sizes. A container is always a rounded box: its title, then its children in a small grid, all with padding.
    //    (A rectangle of children cannot sit inside an ellipse without its corners poking out.)
    const laid = new Map();
    function size(n) {
      if ((children.get(n.id) || []).length) n.shape = "rounded";
      const base = nodeSize(n.label, n.shape, measure, o), kids = children.get(n.id);
      if (!kids || !kids.length) return { ...base };
      const kidSizes = kids.map((k) => ({ k, s: size(k) })), kidCols = kids.length <= 3 ? kids.length : Math.ceil(Math.sqrt(kids.length));
      const cw = Math.max(...kidSizes.map((x) => x.s.w)), ch = Math.max(...kidSizes.map((x) => x.s.h)), rows = Math.ceil(kids.length / kidCols);
      const gridW = kidCols * cw + (kidCols - 1) * o.innerGap, gridH = rows * ch + (rows - 1) * o.innerGap;
      const titleH = n.label ? base.lh + 14 : 0;
      return { w: Math.ceil(Math.max(base.lw + 2 * PAD.x, gridW + 2 * 24)), h: Math.ceil(titleH + gridH + 2 * 20), lw: base.lw, lh: base.lh, kidCols, cw, ch, kidSizes, titleH, gridW, gridH, container: true, shape: "rounded" };
    }
    for (const n of topLevel) laid.set(n.id, { ...n, ...size(n) });

    // 2. A grid for the top-level nodes. Each column is as wide as its widest node and each row as tall as its tallest,
    //    so one big node does not make everything else big.
    const count = topLevel.length;
    const widest = Math.max(60, ...topLevel.map((n) => laid.get(n.id).w));
    const linkLabels = spec.links.filter((l) => l.label).map((l) => measure(l.label, { size: LABEL_SIZE - 4, maxWidth: LINK_LABEL_WIDTH }));
    let gutterX = Math.max(o.minGutterX, ...linkLabels.map((t) => Math.ceil(t.w) + 40)), gutterY = Math.max(o.minGutterY, ...linkLabels.map((t) => Math.ceil(t.h) + 36));
    const title = spec.title ? measure(spec.title, { size: TITLE_SIZE, maxWidth: o.maxW }) : null;
    const titleBand = title ? Math.ceil(title.h) + o.titleGap : 0;
    const maxCols = count; // the loop below takes columns away until the widths really fit (one wide container must not force a single column)
    const kind = spec.layout || (count <= 3 ? "row" : "grid");
    const measurePlan = (plan) => {
      const colW = Array(plan.cols).fill(60), rowH = Array(plan.rows).fill(40);
      topLevel.forEach((n, i) => { const [c, r] = plan.cells[i], L = laid.get(n.id); colW[c] = Math.max(colW[c], L.w); rowH[r] = Math.max(rowH[r], L.h); });
      const sum = (a) => a.reduce((x, y) => x + y, 0);
      return { colW, rowH, width: 2 * FRAME_PAD + sum(colW) + (plan.cols - 1) * gutterX, height: titleBand + 2 * FRAME_PAD + sum(rowH) + (plan.rows - 1) * gutterY };
    };
    let plan = gridPlan(count, kind, spec.cols, maxCols), m = measurePlan(plan);
    while (m.width > o.maxW && plan.cols > 1 && kind !== "cycle") { plan = gridPlan(count, "grid", plan.cols - 1, plan.cols - 1); m = measurePlan(plan); }
    let fits = true;
    if (m.height > o.maxH) { gutterY = Math.max(44, gutterY - 24); m = measurePlan(plan); }
    const gridX0 = FRAME_PAD, gridY0 = titleBand + FRAME_PAD;
    const cellX = (c) => gridX0 + m.colW.slice(0, c).reduce((x, y) => x + y + gutterX, 0), cellY = (r) => gridY0 + m.rowH.slice(0, r).reduce((x, y) => x + y + gutterY, 0);
    topLevel.forEach((n, i) => {
      const L = laid.get(n.id), [c, r] = plan.cells[i];
      L.x = cellX(c) + (m.colW[c] - L.w) / 2; L.y = cellY(r) + (m.rowH[r] - L.h) / 2; L.cell = [c, r];
    });
    let frameW = Math.max(m.width, title ? Math.ceil(title.w) : 0), frameH = m.height;

    // 3. Place children inside their container, below the container's title.
    const all = new Map(laid);
    function placeChildren(L) {
      if (!L.container) return;
      const startX = L.x + (L.w - L.gridW) / 2, startY = L.y + L.titleH + (L.h - L.titleH - L.gridH) / 2;
      L.kidSizes.forEach(({ k, s: ks }, i) => {
        const c = i % L.kidCols, r = Math.floor(i / L.kidCols);
        const K = { ...k, ...ks, x: startX + c * (L.cw + o.innerGap) + (L.cw - ks.w) / 2, y: startY + r * (L.ch + o.innerGap) + (L.ch - ks.h) / 2, parent: L.id };
        all.set(K.id, K); placeChildren(K);
      });
    }
    for (const L of laid.values()) placeChildren(L);

    // 4. Label boxes: centred in a leaf; in the title band of a container.
    for (const L of all.values()) {
      const lw = L.lw || 0, lh = L.lh || 0;
      L.labelBox = L.container ? { x: L.x + (L.w - lw) / 2, y: L.y + 10, w: lw, h: lh } : { x: L.x + (L.w - lw) / 2, y: L.y + (L.h - lh) / 2, w: lw, h: lh };
    }

    // 5. Connectors, one at a time, so each one keeps clear of the labels already placed.
    const placedLabels = [], routes = [];
    const nodeRect = (n) => ({ x: n.x, y: n.y, w: n.w, h: n.h });
    const ancestors = (id) => { const out = new Set(); let n = all.get(id); while (n && n.parent) { out.add(n.parent); n = all.get(n.parent); } return out; };
    // Channels: the empty lines between cells (and around the grid) that routes may follow.
    const chX = Array.from({ length: plan.cols + 1 }, (_, k) => (k === 0 ? FRAME_PAD / 2 : k === plan.cols ? cellX(plan.cols - 1) + m.colW[plan.cols - 1] + FRAME_PAD / 2 : cellX(k) - gutterX / 2));
    const chY = Array.from({ length: plan.rows + 1 }, (_, k) => (k === 0 ? titleBand + FRAME_PAD / 2 : k === plan.rows ? cellY(plan.rows - 1) + m.rowH[plan.rows - 1] + FRAME_PAD / 2 : cellY(k) - gutterY / 2));

    const chIdx = (list, v) => list.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(list[best] - v) ? i : best), 0);
    const chanY = (n, side, p) => (n.cell ? chY[side === "top" ? n.cell[1] : n.cell[1] + 1] : chY[chIdx(chY, p[1])]);
    const chanX = (n, side, p) => (n.cell ? chX[side === "left" ? n.cell[0] : n.cell[0] + 1] : chX[chIdx(chX, p[0])]);

    for (const link of spec.links) {
      const A = all.get(link.from), B = all.get(link.to);
      if (!A || !B) { warnings.push(`link ${link.id}: unknown node`); continue; }
      const skip = new Set([A.id, B.id, ...ancestors(A.id), ...ancestors(B.id)]);
      // Obstacles: every other node (a container only matters if neither end is inside it), and the labels of containers.
      const blocks = [];
      for (const n of all.values()) {
        if (skip.has(n.id)) { if (n.container && n.id !== A.id && n.id !== B.id) blocks.push(inflate(n.labelBox, 4)); continue; }
        blocks.push(inflate(nodeRect(n), CLEAR));
      }
      for (const lab of placedLabels) blocks.push(inflate(lab, 3));
      const valid = (pts) => !blocks.some((r) => polylineHitsRect(pts, r)) && pts.every((p) => p[0] >= 0 && p[1] >= 0 && p[0] <= frameW && p[1] <= frameH);
      const candidates = [];
      const shrink = (n, by) => ({ x: n.x + by, y: n.y + by, w: Math.max(1, n.w - 2 * by), h: Math.max(1, n.h - 2 * by) });
      const ownA = shrink(A, 3), ownB = shrink(B, 3);
      const aC = [A.x + A.w / 2, A.y + A.h / 2], bC = [B.x + B.w / 2, B.y + B.h / 2];
      candidates.push({ pts: simplify([borderPoint(A, bC), borderPoint(B, aC)]), channel: false });
      // Along the channels: leave A through one side, travel in a channel, enter B through one side.
      const sides = ["top", "bottom", "left", "right"];
      for (const sa of sides) for (const sb of sides) {
        const p0 = sidePoint(A, sa), p1 = sidePoint(B, sb);
        const aHorizontal = sa === "top" || sa === "bottom", bHorizontal = sb === "top" || sb === "bottom";
        // The channel line next to each chosen side (a cell node uses the lines around its cell; a child inside a container, the nearest).
        const ya = aHorizontal ? chanY(A, sa, p0) : null, xa = !aHorizontal ? chanX(A, sa, p0) : null;
        const yb = bHorizontal ? chanY(B, sb, p1) : null, xb = !bHorizontal ? chanX(B, sb, p1) : null;
        const start = aHorizontal ? [p0[0], ya] : [xa, p0[1]], end = bHorizontal ? [p1[0], yb] : [xb, p1[1]];
        // join two channel points with an L or Z along channel lines
        const mids = [];
        if (aHorizontal && bHorizontal) for (const x of chX) mids.push([[start[0], start[1]], [x, start[1]], [x, end[1]], [end[0], end[1]]]);
        else if (!aHorizontal && !bHorizontal) for (const y of chY) mids.push([[start[0], start[1]], [start[0], y], [end[0], y], [end[0], end[1]]]);
        else if (aHorizontal && !bHorizontal) mids.push([[start[0], start[1]], [end[0], start[1]], [end[0], end[1]]]);
        else mids.push([[start[0], start[1]], [start[0], end[1]], [end[0], end[1]]]);
        for (const mid of mids) candidates.push({ pts: simplify([p0, ...mid, p1]), channel: true });
      }
      // A route along the channels must not run through the body of the node it leaves or enters (a child's nearest channel can be on its far side).
      const cleanEnds = (c) => !c.channel || !(polylineHitsRect(c.pts, ownA) || polylineHitsRect(c.pts, ownB));
      const scored = candidates.map((c) => ({ pts: c.pts, ok: valid(c.pts) && cleanEnds(c), cost: polylineLength(c.pts) + 30 * (c.pts.length - 2) })).sort((p, q) => (q.ok - p.ok) || (p.cost - q.cost));
      const trim = (from, to, by) => { const d = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1; return [from[0] + ((to[0] - from[0]) / d) * by, from[1] + ((to[1] - from[1]) / d) * by]; };
      const finish = (pts) => { const q = pts.map((p) => [p[0], p[1]]); q[0] = trim(q[0], q[1], 4); q[q.length - 1] = trim(q[q.length - 1], q[q.length - 2], 6); return q; };
      let t = null, labelBlocks = null;
      if (link.label) { t = measure(link.label, { size: LABEL_SIZE - 4, maxWidth: LINK_LABEL_WIDTH }); labelBlocks = [...blocks, ...[...all.values()].map((n) => inflate(nodeRect(n), CLEAR))]; }
      // The route and its label are chosen together: the shortest route whose label also has a clean place beside it.
      let chosen = null, spot = null;
      for (const cand of scored.slice(0, 14)) {
        const pts = finish(cand.pts);
        if (!t) { chosen = { cand, pts }; break; }
        const tryLabel = placeBesideLine(pts, Math.ceil(t.w), Math.ceil(t.h), labelBlocks, routes.map((r) => r.points), frameW, frameH);
        if (cand.ok && tryLabel.ok) { chosen = { cand, pts }; spot = tryLabel; break; }
        if (!chosen) { chosen = { cand, pts }; spot = tryLabel; } // remember the best route as a fallback
      }
      if (!chosen.cand.ok) warnings.push(`link ${link.id}: no clear route between ${A.id} and ${B.id}`);
      const out = { id: link.id, from: link.from, to: link.to, style: link.style || "arrow", points: chosen.pts, label: null, labelBox: null, clear: chosen.cand.ok };
      if (t) {
        const w = Math.ceil(t.w), h = Math.ceil(t.h);
        if (!spot.ok) warnings.push(`link ${link.id}: label "${link.label}" has no free place beside its line`);
        out.label = link.label; out.labelBox = { x: spot.x, y: spot.y, w, h }; placedLabels.push(out.labelBox);
      }
      routes.push(out);
    }

    // 6. The frame must contain everything: nodes, connectors and their labels. Shift and grow it as needed.
    let minX = 0, minY = 0, maxX = frameW, maxY = frameH;
    for (const r of routes) {
      if (r.labelBox) { minX = Math.min(minX, r.labelBox.x - 2); minY = Math.min(minY, r.labelBox.y - 2); maxX = Math.max(maxX, r.labelBox.x + r.labelBox.w + 2); maxY = Math.max(maxY, r.labelBox.y + r.labelBox.h + 2); }
      for (const p of r.points) { minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); }
    }
    const shiftX = -minX, shiftY = -minY;
    if (shiftX || shiftY) {
      for (const n of all.values()) { n.x += shiftX; n.y += shiftY; n.labelBox.x += shiftX; n.labelBox.y += shiftY; }
      for (const r of routes) { r.points = r.points.map((p) => [p[0] + shiftX, p[1] + shiftY]); if (r.labelBox) { r.labelBox.x += shiftX; r.labelBox.y += shiftY; } }
    }
    frameW = maxX + shiftX; frameH = maxY + shiftY;
    if (frameW > o.maxW + 1 || frameH > o.maxH + 1) { fits = false; if (!warnings.length) warnings.push("The diagram is larger than a page; use fewer nodes, shorter labels or split it."); }
    return { w: Math.ceil(frameW), h: Math.ceil(frameH), fits, title: title ? { x: shiftX, y: shiftY, w: Math.ceil(title.w), h: Math.ceil(title.h) } : null, titleBand, nodes: all, links: routes, warnings };
  }

  /**
   * Lay out a diagram. If it would not fit a page as asked, try progressively more compact arrangements (a grid instead of
   * a column or row, tighter gutters, narrower label wrapping) before giving up. The handwriting is never made smaller.
   * `result.arranged` says what was changed, if anything; `result.fits` is false only if nothing made it fit.
   */
  function layoutDiagram(spec, measure, options) {
    const first = layoutOnce(spec, measure, options);
    if (first.fits) return first;
    const kind = spec.layout || (spec.nodes.length <= 3 ? "row" : "grid");
    const attempts = [], canGrid = kind !== "cycle" || spec.nodes.some((n) => n.in); // a ring cannot hold containers, a grid can
    if (canGrid) for (const cols of [2, 3, 4]) attempts.push({ note: "as a grid of " + cols + " columns", spec: { ...spec, layout: "grid", cols } });
    const compact = { minGutterX: 56, minGutterY: 40, labelMaxWidth: 150 };
    attempts.push({ note: "with tighter spacing", spec, options: compact });
    if (canGrid) for (const cols of [2, 3, 4]) attempts.push({ note: "as a compact grid of " + cols + " columns", spec: { ...spec, layout: "grid", cols }, options: compact });
    let best = first;
    for (const attempt of attempts) {
      const result = layoutOnce(attempt.spec, measure, { ...(options || {}), ...(attempt.options || {}) });
      if (result.fits) { result.arranged = attempt.note; return result; }
      if (result.w * result.h < best.w * best.h) best = result;
    }
    return best;
  }

  /**
   * Put a label beside a connector, on a free side, never on the line itself. It prefers a spot inside the frame, but a
   * free spot outside is better than any spot on top of something (the frame then grows to include it).
   */
  function placeBesideLine(points, w, h, blocks, otherLines, frameW, frameH) {
    const segs = points.slice(1).map((p, i) => ({ a: points[i], b: p, len: Math.hypot(p[0] - points[i][0], p[1] - points[i][1]) })).sort((s, t) => t.len - s.len);
    let fallback = null;
    for (const mustBeInside of [true, false]) {
      for (const seg of segs) for (const t of [0.5, 0.35, 0.65, 0.25, 0.75]) {
        const px = seg.a[0] + (seg.b[0] - seg.a[0]) * t, py = seg.a[1] + (seg.b[1] - seg.a[1]) * t;
        const dx = (seg.b[0] - seg.a[0]) / (seg.len || 1), dy = (seg.b[1] - seg.a[1]) / (seg.len || 1);
        for (const sign of [1, -1]) {
          const nx = -dy * sign, ny = dx * sign;
          const gap = Math.abs(nx) * (w / 2) + Math.abs(ny) * (h / 2) + CLEAR + 2;
          const box = { x: px + nx * gap - w / 2, y: py + ny * gap - h / 2, w, h };
          if (!fallback) fallback = box;
          if (mustBeInside && (box.x < 2 || box.y < 2 || box.x + box.w > frameW - 2 || box.y + box.h > frameH - 2)) continue;
          const bigger = inflate(box, 3);
          if (blocks.some((r) => overlaps(bigger, r))) continue;
          if (polylineHitsRect(points, bigger) || otherLines.some((l) => polylineHitsRect(l, bigger))) continue;
          return { ok: true, x: box.x, y: box.y };
        }
      }
    }
    return { ok: false, x: fallback.x, y: fallback.y };
  }

  /**
   * Place a small label next to something (a point, the end of a curve), on whichever side is free of the given
   * obstacles (rectangles and polylines). Used for graph labels so that they never sit on a curve, an axis or a number.
   * @returns {{x:number,y:number,ok:boolean}} top-left of the label box
   */
  function placeLabel(anchor, size, obstacles, bounds, options) {
    const o = options || {}, gap = o.gap == null ? 10 : o.gap, w = size.w, h = size.h;
    // Search outward in rings, nearest first, in eight directions (up-right preferred): the closest spot that is free.
    const directions = [[1, -1], [1, 1], [-1, -1], [-1, 1], [1, 0], [-1, 0], [0, -1], [0, 1]];
    let best = null;
    for (const ring of [1, 1.8, 2.8, 4, 5.5]) {
      const r = gap * ring;
      for (const [ux, uy] of directions) {
        const box = { x: anchor[0] + (ux > 0 ? r : ux < 0 ? -r - w : -w / 2), y: anchor[1] + (uy > 0 ? r : uy < 0 ? -r - h : -h / 2), w, h };
        if (bounds && !inside(box, bounds, 2)) continue;
        const bigger = inflate(box, 3);
        const hits = (obstacles.rects || []).filter((rect) => overlaps(bigger, rect)).length + (obstacles.lines || []).filter((l) => polylineHitsRect(l, bigger)).length;
        if (hits === 0) return { x: box.x, y: box.y, ok: true };
        if (!best || hits < best.hits) best = { x: box.x, y: box.y, hits };
      }
    }
    return best ? { x: best.x, y: best.y, ok: false } : { x: anchor[0] + gap, y: anchor[1] - h - gap, ok: false };
  }

  return { LINK_LABEL_WIDTH, layoutDiagram, nodeSize, placeLabel, segmentHitsRect, polylineHitsRect, overlaps, inflate, inside, borderPoint, LABEL_SIZE, TITLE_SIZE, PAD, CLEAR, DEFAULTS };
});
