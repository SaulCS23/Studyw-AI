/* Layout engine for one page of the notebook: decides WHERE things go, so nothing ever overlaps.
 *
 * It never trusts coordinates from Claude. Every element is measured first (text and equations are typeset before
 * they are drawn; graphs and diagram frames declare their size), then placed in free space on the page. If it does
 * not fit, place() answers null and the board starts a new page BEFORE drawing anything. Elements are never shrunk
 * to make them fit.
 *
 *  - Free space is found among "corner points" next to what is already on the page (right of and below each element).
 *  - Text and equations stack downwards in a column; graphs and diagrams may go beside the previous element.
 *  - `near` + `side` puts an element beside another (explanations next to a diagram).
 *  - `calc` keeps the lines of one calculation together: tight spacing, left aligned, and room reserved below.
 *  - `prefer` is tried first (a correction landing where the old text was).
 *
 * No DOM, so it is unit-tested in Node. Coordinates are board units; a page is 1000 x 600.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WhiteboardLayout = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULTS = { width: 1000, height: 600, margin: 36, gap: 18, calcGap: 8 };
  const EPS = 1e-6;

  /** True when a and b are closer than `pad` (or overlap). */
  const tooClose = (a, b, pad) => a.x < b.x + b.w + pad - EPS && b.x < a.x + a.w + pad - EPS && a.y < b.y + b.h + pad - EPS && b.y < a.y + a.h + pad - EPS;
  const snap = (v) => Math.ceil(v - EPS); // whole units, rounded so that gaps can only grow

  class PageLayout {
    constructor(options) {
      Object.assign(this, DEFAULTS, options || {});
      this.items = new Map(); // id -> { x, y, w, h, calc }
      this.order = [];        // ids in the order they were placed
    }

    /** The area elements may use: the page minus its margins. */
    get inner() { return { x: this.margin, y: this.margin, w: this.width - 2 * this.margin, h: this.height - 2 * this.margin }; }

    occupy(id, rect, calc) {
      this.release(id);
      this.items.set(id, { x: rect.x, y: rect.y, w: rect.w, h: rect.h, calc: calc || null });
      this.order.push(id);
    }
    release(id) { if (this.items.delete(id)) this.order = this.order.filter((other) => other !== id); }
    rect(id) { return this.items.get(id) || null; }
    last() { return this.order.length ? this.items.get(this.order[this.order.length - 1]) : null; }

    /** Inside the margins and clear of everything else by the required gap? (`ignore` = an id to leave out.) */
    isFree(rect, calc, ignore) {
      const i = this.inner;
      if (rect.x < i.x - EPS || rect.y < i.y - EPS || rect.x + rect.w > i.x + i.w + EPS || rect.y + rect.h > i.y + i.h + EPS) return false;
      for (const [id, other] of this.items) {
        if (id === ignore) continue;
        const pad = calc && other.calc === calc ? this.calcGap : this.gap;
        if (tooClose(rect, other, pad)) return false;
      }
      return true;
    }

    /** Share of the page's usable area that is still empty (0..1). */
    freeFraction() {
      const i = this.inner;
      let used = 0; for (const r of this.items.values()) used += r.w * r.h;
      return Math.max(0, 1 - used / (i.w * i.h));
    }

    /**
     * Find a spot for a w x h block, or null if the page has no room (the caller then starts a new page).
     * @param {{w:number,h:number,id?:string,prefer?:{x:number,y:number},near?:string,side?:string,calc?:string,
     *          flow?:"stack"|"any",reserveH?:number}} request
     */
    place(request) {
      const { w, h } = request, calc = request.calc || null, id = request.id;
      const i = this.inner;
      if (w > i.w + EPS || h > i.h + EPS) return null;
      // Calculation lines ask for room below. A page that is already in use must have it (otherwise a new page is
      // started, so the calculation is not split); only an EMPTY page may do without, as it cannot offer more.
      const reserve = request.reserveH || 0;
      const spot = this.search(w, h, reserve, request, calc, id);
      if (spot || !reserve || this.items.size > 0) return spot;
      return this.search(w, h, 0, request, calc, id);
    }

    search(w, h, reserve, request, calc, id) {
      const gap = this.gap;
      const fits = (x, y) => { x = snap(x); y = snap(y); return this.isFree({ x, y, w, h: h + reserve }, calc, id) ? { x, y } : null; };
      const first = (candidates) => { for (const [x, y] of candidates) { const spot = fits(x, y); if (spot) return spot; } return null; };

      if (request.prefer) { const spot = fits(request.prefer.x, request.prefer.y); if (spot) return spot; }

      const near = request.near && this.items.get(request.near);
      if (near) {
        const sides = { right: [near.x + near.w + gap, near.y], below: [near.x, near.y + near.h + gap], left: [near.x - gap - w, near.y], above: [near.x, near.y - gap - h] };
        const wanted = sides[request.side] ? [request.side] : [];
        const order = [...wanted, ...["right", "below", "left", "above"].filter((s) => s !== request.side)];
        const candidates = [];
        for (const side of order) {
          candidates.push(sides[side]);
          if (side === "right") candidates.push([sides.right[0], near.y + (near.h - h) / 2]);
          if (side === "below") candidates.push([near.x + (near.w - w) / 2, sides.below[1]]);
        }
        const spot = first(candidates);
        if (spot) return spot;
      }

      if (calc) { // keep a calculation together: directly under its previous line, same left edge
        const previous = [...this.order].reverse().map((other) => this.items.get(other)).find((r) => r && r.calc === calc);
        if (previous) {
          const spot = first([[previous.x, previous.y + previous.h + this.calcGap], [previous.x + previous.w + gap, previous.y]]);
          if (spot) return spot;
        }
      }

      // General flow. Candidate corners come from the page margin and from the edges of what is already there.
      const xs = new Set([i_x(this)]), ys = new Set([i_y(this)]);
      for (const r of this.items.values()) { xs.add(r.x); xs.add(r.x + r.w + gap); ys.add(r.y); ys.add(r.y + r.h + gap); }
      const last = this.last();
      let candidates = [];
      if ((request.flow || "any") === "stack") {
        // Text and equations go down a column: left edge of the page or of the previous element, below something.
        const columns = new Set([i_x(this)]); if (last) columns.add(last.x);
        for (const x of columns) for (const y of ys) candidates.push([x, y]);
      } else {
        for (const x of xs) for (const y of ys) candidates.push([x, y]);
      }
      const reading = (a, b) => a[1] - b[1] || a[0] - b[0];
      candidates.sort(reading);
      // Prefer moving forward (not back-filling above the previous element); fall back to any free spot.
      const forward = last ? candidates.filter(([, y]) => y >= last.y - EPS) : candidates;
      return first(forward) || first(candidates);
    }
  }
  const i_x = (layout) => layout.margin, i_y = (layout) => layout.margin;

  return { PageLayout, DEFAULTS, tooClose };
});
