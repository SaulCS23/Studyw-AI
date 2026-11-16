// Run with: node --test ai-teacher/test/layout.test.js
// Geometric proof that the layout engine never overlaps elements and never leaves the page.
const test = require("node:test");
const assert = require("node:assert/strict");
const { PageLayout, tooClose } = require("../whiteboard-layout.js");
const hand = require("../whiteboard-hand.js");

/** Deterministic random numbers, so a failure can be reproduced. */
function random(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Everything that must hold for a page, checked from scratch (not trusting the engine's own bookkeeping). */
function assertPageIsClean(layout, label) {
  const inner = layout.inner, entries = [...layout.items.entries()];
  for (const [id, r] of entries) {
    assert.ok(r.x >= inner.x - 1e-9 && r.y >= inner.y - 1e-9 && r.x + r.w <= inner.x + inner.w + 1e-9 && r.y + r.h <= inner.y + inner.h + 1e-9, `${label}: ${id} leaves the page ${JSON.stringify(r)}`);
  }
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    const [ida, a] = entries[i], [idb, b] = entries[j];
    const pad = a.calc && a.calc === b.calc ? layout.calcGap : layout.gap;
    assert.ok(!tooClose(a, b, pad), `${label}: ${ida} and ${idb} are closer than ${pad}: ${JSON.stringify(a)} / ${JSON.stringify(b)}`);
  }
}

/** A notebook of pages: place a block, starting a new page when it does not fit (as the board does). */
function notebook() {
  const pages = [new PageLayout()];
  return {
    pages,
    place(request) {
      let spot = pages[pages.length - 1].place(request);
      if (!spot) { pages.push(new PageLayout()); spot = pages[pages.length - 1].place(request); }
      assert.ok(spot, "a block that fits an empty page must always be placeable: " + JSON.stringify(request));
      pages[pages.length - 1].occupy(request.id, { x: spot.x, y: spot.y, w: request.w, h: request.h }, request.calc);
      return { page: pages.length - 1, ...spot };
    },
  };
}

test("the first element goes in the top-left corner, inside the margin", () => {
  const layout = new PageLayout(), spot = layout.place({ w: 300, h: 60 });
  assert.deepEqual(spot, { x: layout.margin, y: layout.margin });
});

test("text stacks downwards with a consistent gap and the same left edge", () => {
  const layout = new PageLayout(); const ys = [];
  for (let n = 0; n < 4; n++) { const spot = layout.place({ w: 300, h: 50, flow: "stack" }); layout.occupy("t" + n, { ...spot, w: 300, h: 50 }); ys.push(spot); }
  assert.ok(ys.every((s) => s.x === layout.margin));
  for (let n = 1; n < ys.length; n++) assert.equal(ys[n].y - (ys[n - 1].y + 50), layout.gap);
});

test("an equation followed by a graph puts the graph beside it when there is room (side by side)", () => {
  const layout = new PageLayout();
  layout.occupy("eq", { ...layout.place({ w: 260, h: 60, flow: "stack" }), w: 260, h: 60 });
  const graph = layout.place({ w: 420, h: 300, flow: "any" });
  assert.ok(graph.x > layout.margin + 260, "graph should be to the right: " + JSON.stringify(graph));
  assert.equal(graph.y, layout.margin);
});

test("near + side puts an explanation beside its diagram", () => {
  const layout = new PageLayout();
  layout.occupy("diagram", { x: 36, y: 36, w: 400, h: 300 });
  const right = layout.place({ w: 300, h: 80, near: "diagram", side: "right" });
  assert.equal(right.x, 36 + 400 + layout.gap); assert.equal(right.y, 36);
  const below = layout.place({ w: 300, h: 80, near: "diagram", side: "below" });
  assert.equal(below.x, 36); assert.equal(below.y, 36 + 300 + layout.gap);
  const crowded = new PageLayout(); crowded.occupy("d", { x: 36, y: 36, w: 880, h: 300 });
  const fallback = crowded.place({ w: 300, h: 80, near: "d", side: "right" });
  assert.ok(fallback && fallback.y >= 36 + 300 + crowded.gap, "no room on the right: falls back below, not on top: " + JSON.stringify(fallback));
});

test("a calculation stays together: tight spacing, same left edge, and room is reserved below", () => {
  const layout = new PageLayout(); layout.occupy("title", { x: 36, y: 36, w: 400, h: 60 });
  const lines = [];
  for (let n = 0; n < 4; n++) {
    const spot = layout.place({ w: 240, h: 54, calc: "solve", flow: "stack", reserveH: n === 0 ? 150 : 0 });
    layout.occupy("c" + n, { ...spot, w: 240, h: 54 }, "solve"); lines.push(spot);
  }
  assert.ok(lines.every((s) => s.x === lines[0].x));
  for (let n = 1; n < lines.length; n++) assert.equal(lines[n].y - (lines[n - 1].y + 54), layout.calcGap, "calculation lines are closer than ordinary elements");
  const nearBottom = new PageLayout(); nearBottom.occupy("big", { x: 36, y: 36, w: 800, h: 400 });
  assert.equal(nearBottom.place({ w: 240, h: 54, calc: "x", flow: "stack", reserveH: 150 }), null, "a calculation that cannot fit its lines starts on a new page instead of being split");
  assert.ok(nearBottom.place({ w: 240, h: 54, flow: "stack" }), "a single line still fits");
});

test("a block bigger than the page is refused (never shrunk) and a full page answers null", () => {
  const layout = new PageLayout();
  assert.equal(layout.place({ w: 2000, h: 40 }), null);
  assert.equal(layout.place({ w: 100, h: 2000 }), null);
  layout.occupy("all", { x: 36, y: 36, w: 928, h: 528 });
  assert.equal(layout.place({ w: 50, h: 50 }), null);
});

test("prefer is used when free and ignored when it would collide", () => {
  const layout = new PageLayout(); layout.occupy("a", { x: 36, y: 36, w: 300, h: 60 });
  assert.deepEqual(layout.place({ w: 100, h: 40, prefer: { x: 500, y: 300 } }), { x: 500, y: 300 });
  const moved = layout.place({ w: 100, h: 40, prefer: { x: 40, y: 40 } });
  assert.ok(moved.x !== 40 || moved.y !== 40);
  assert.ok(layout.isFree({ ...moved, w: 100, h: 40 }));
});

test("releasing an element frees its space for the next one", () => {
  const layout = new PageLayout(); layout.occupy("a", { x: 36, y: 36, w: 300, h: 60 });
  layout.release("a");
  assert.deepEqual(layout.place({ w: 300, h: 60 }), { x: 36, y: 36 });
  assert.ok(layout.freeFraction() === 1);
});

test("placement is deterministic", () => {
  const run = () => { const nb = notebook(), r = random(7), out = []; for (let n = 0; n < 30; n++) out.push(nb.place({ id: "e" + n, w: 80 + r() * 300, h: 40 + r() * 120, flow: r() < 0.6 ? "stack" : "any" })); return JSON.stringify(out); };
  assert.equal(run(), run());
});

test("FUZZ: 400 random lessons of 40 blocks each: no overlap, always inside the page, pages added when needed", () => {
  let blocks = 0, pagesTotal = 0, multiPage = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const r = random(seed), nb = notebook(); let calcId = 0, inCalc = 0;
    for (let n = 0; n < 40; n++) {
      const kind = r();
      let request;
      if (kind < 0.5) request = { w: 100 + r() * 400, h: 36 + r() * 90, flow: "stack" };                               // text / equations
      else if (kind < 0.7) request = { w: 280 + r() * 300, h: 200 + r() * 160, flow: "any" };                            // graphs
      else if (kind < 0.85) request = { w: 200 + r() * 360, h: 120 + r() * 260, flow: "any" };                          // diagram frames
      else request = { w: 120 + r() * 240, h: 40 + r() * 70, flow: "stack" };                                           // calculation lines
      if (kind >= 0.85) { if (!inCalc) { calcId++; inCalc = 3; request.reserveH = 130; } request.calc = "calc" + calcId; inCalc--; }
      if (r() < 0.15 && nb.pages[nb.pages.length - 1].order.length) { const ids = nb.pages[nb.pages.length - 1].order; request.near = ids[Math.floor(r() * ids.length)]; request.side = ["right", "below", "left", "above"][Math.floor(r() * 4)]; }
      request.id = "e" + n;
      nb.place(request); blocks++;
    }
    nb.pages.forEach((page, index) => assertPageIsClean(page, `seed ${seed} page ${index + 1}`));
    pagesTotal += nb.pages.length; if (nb.pages.length > 1) multiPage++;
  }
  assert.ok(blocks === 16000 && multiPage > 300, `blocks ${blocks}, lessons with several pages ${multiPage}`);
  assert.ok(pagesTotal / 400 > 2, "lessons of 40 blocks need several pages on average: " + pagesTotal / 400);
});

test("FUZZ with removals and corrections: space is reused without ever overlapping", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const r = random(seed * 31), layout = new PageLayout(); const live = [];
    for (let n = 0; n < 60; n++) {
      if (live.length && r() < 0.3) { const index = Math.floor(r() * live.length); layout.release(live[index]); live.splice(index, 1); continue; }
      const request = { id: "e" + n, w: 80 + r() * 350, h: 36 + r() * 120, flow: r() < 0.6 ? "stack" : "any" };
      if (live.length && r() < 0.3) request.prefer = { x: layout.rect(live[0]).x, y: layout.rect(live[0]).y };
      const spot = layout.place(request);
      if (spot) { layout.occupy(request.id, { ...spot, w: request.w, h: request.h }); live.push(request.id); }
    }
    assertPageIsClean(layout, "seed " + seed);
  }
});

test("real handwriting: the INK of unrelated elements never overlaps, and stays inside the page", () => {
  const samples = [
    ["text", "Photosynthesis", 46], ["text", "Plants make sugar from light", 34], ["text", "Água, coração, ñandú", 28],
    ["math", "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}", 34], ["math", "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}", 34], ["math", "6CO_2 + 6H_2O \\rightarrow C_6H_{12}O_6 + 6O_2", 34],
    ["text", "The vertex is the lowest point", 34], ["math", "y = x^2 - 4", 34], ["math", "\\int_0^1 x^2 dx = \\frac{1}{3}", 34], ["text", "Rome falls in 476", 28],
  ];
  for (let seed = 1; seed <= 60; seed++) {
    const r = random(seed * 17), nb = notebook(), placed = [];
    for (let n = 0; n < 24; n++) {
      const [kind, content, size] = samples[Math.floor(r() * samples.length)];
      const t = kind === "math" ? hand.typesetMath(content, { size }) : hand.typesetText(content, { size, maxWidth: 440 });
      const spot = nb.place({ id: "i" + n, w: t.width, h: t.height, flow: "stack" });
      placed.push({ page: spot.page, id: "i" + n, ink: hand.boundsOf(t.strokes.map((s) => s.map(([x, y]) => [x + spot.x, y + spot.y]))) });
    }
    for (const a of placed) {
      assert.ok(a.ink.minX >= 36 - 1e-6 && a.ink.minY >= 36 - 1e-6 && a.ink.maxX <= 964 + 1e-6 && a.ink.maxY <= 564 + 1e-6, `seed ${seed}: ink of ${a.id} leaves the page: ${JSON.stringify(a.ink)}`);
      for (const b of placed) if (a.id < b.id && a.page === b.page) {
        const apart = a.ink.maxX < b.ink.minX || b.ink.maxX < a.ink.minX || a.ink.maxY < b.ink.minY || b.ink.maxY < a.ink.minY;
        assert.ok(apart, `seed ${seed}: ink of ${a.id} and ${b.id} overlap`);
      }
    }
  }
});
