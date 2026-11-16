// Run with: node --test ai-teacher/test/diagram.test.js
// Geometric proof that diagrams are laid out cleanly: text sits inside its shape with padding, connectors never cross
// a node or a label, labels never sit on lines, and nothing leaves the frame.
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../whiteboard-diagram.js");
const hand = require("../whiteboard-hand.js");

const measure = (text, { size, maxWidth }) => { const t = hand.typesetText(text, { size, maxWidth }); return { w: t.width, h: t.height }; };
function random(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rectOf = (n) => ({ x: n.x, y: n.y, w: n.w, h: n.h });

/** Every guarantee, checked from scratch on the finished layout. Returns a list of problems. */
function problemsIn(layout, spec) {
  const out = [], nodes = [...layout.nodes.values()], frame = { x: 0, y: 0, w: layout.w, h: layout.h };
  const containerOf = (n) => (n.parent ? layout.nodes.get(n.parent) : null);
  for (const n of nodes) {
    if (!D.inside(rectOf(n), frame, 1)) out.push(`${n.id} leaves the frame`);
    // 1. The label sits inside its shape with real padding
    const lb = n.labelBox;
    if (n.label && !n.container) {
      if (n.shape === "ellipse" || n.shape === "circle") {
        const cx = n.x + n.w / 2, cy = n.y + n.h / 2, a = n.w / 2, b = n.h / 2;
        for (const [px, py] of [[lb.x, lb.y], [lb.x + lb.w, lb.y], [lb.x, lb.y + lb.h], [lb.x + lb.w, lb.y + lb.h]]) if (((px - cx) / a) ** 2 + ((py - cy) / b) ** 2 > 0.92) out.push(`${n.id}: label corner too close to the curve`);
      } else if (n.shape !== "none") {
        if (lb.x - n.x < 12 || n.x + n.w - (lb.x + lb.w) < 12 || lb.y - n.y < 8 || n.y + n.h - (lb.y + lb.h) < 8) out.push(`${n.id}: label closer than the padding to its border`);
      }
    }
    // 2. Children sit inside their container, below its title, with padding
    const parent = containerOf(n);
    if (parent) {
      if (!D.inside(rectOf(n), rectOf(parent), 10)) out.push(`${n.id} is not inside ${parent.id} with padding`);
      if (parent.label && n.y < parent.labelBox.y + parent.labelBox.h + 4) out.push(`${n.id} touches the title of ${parent.id}`);
    }
  }
  // 3. Top-level nodes are apart from each other
  const top = nodes.filter((n) => !n.parent);
  for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) if (D.overlaps(D.inflate(rectOf(top[i]), 12), rectOf(top[j]))) out.push(`${top[i].id} and ${top[j].id} are too close`);
  // children of one container are apart
  for (const c of nodes.filter((n) => n.container)) {
    const kids = nodes.filter((n) => n.parent === c.id);
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) if (D.overlaps(D.inflate(rectOf(kids[i]), 6), rectOf(kids[j]))) out.push(`${kids[i].id} and ${kids[j].id} overlap inside ${c.id}`);
  }
  // 4. Connectors: end on the borders of their nodes and never cross another node
  const ancestors = (id) => { const s = new Set(); let n = layout.nodes.get(id); while (n && n.parent) { s.add(n.parent); n = layout.nodes.get(n.parent); } return s; };
  for (const link of layout.links) {
    const skip = new Set([link.from, link.to, ...ancestors(link.from), ...ancestors(link.to)]);
    if (link.clear) for (const n of nodes) {
      if (skip.has(n.id)) continue;
      if (D.polylineHitsRect(link.points, rectOf(n))) out.push(`link ${link.id} crosses node ${n.id}`);
    }
    // never through the label of a container it does not belong to, and never through any node label
    for (const n of nodes) if (n.label && !skip.has(n.id) && link.clear && D.polylineHitsRect(link.points, n.labelBox)) out.push(`link ${link.id} crosses the label of ${n.id}`);
    for (const n of nodes) if (n.container && skip.has(n.id) && n.id !== link.from && n.id !== link.to && D.polylineHitsRect(link.points, D.inflate(n.labelBox, 1))) out.push(`link ${link.id} crosses the title of its container ${n.id}`);
    // a bent route leaves and enters its nodes cleanly: it never runs through the body of its own start or end node
    const shrunk = (n) => ({ x: n.x + 3, y: n.y + 3, w: Math.max(1, n.w - 6), h: Math.max(1, n.h - 6) });
    if (link.points.length > 2) for (const id of [link.from, link.to]) { const n = layout.nodes.get(id); if (n && D.polylineHitsRect(link.points, shrunk(n))) out.push(`link ${link.id} runs through its own node ${id}`); }
    // 5. Its label: beside the line, not on anything
    if (link.label && link.labelBox) {
      const box = link.labelBox;
      if (!D.inside(box, frame, 0)) out.push(`label of ${link.id} leaves the frame`);
      for (const n of nodes) if (D.overlaps(box, rectOf(n)) && !(n.container && skip.has(n.id) && !D.overlaps(box, n.labelBox))) out.push(`label of ${link.id} sits on node ${n.id}`);
      for (const other of layout.links) if (D.polylineHitsRect(other.points, D.inflate(box, 1))) out.push(`label of ${link.id} touches the line of ${other.id}`);
      for (const other of layout.links) if (other !== link && other.labelBox && D.overlaps(D.inflate(box, 1), other.labelBox)) out.push(`label of ${link.id} overlaps the label of ${other.id}`);
      if (layout.title && D.overlaps(box, layout.title)) out.push(`label of ${link.id} sits on the title`);
    }
  }
  return out;
}

const WORDS = ["Sun", "Ocean", "Cloud", "Rain", "Plant", "Chloroplast", "Nucleus", "Mitochondria", "Water vapour", "Sugar", "Oxygen", "Carbon dioxide", "Light energy", "Evaporation", "Rome", "Senate", "Emperor", "Army", "Provinces", "Trade routes"];

function spec(layout, labels, shapes, linkLabels) {
  const nodes = labels.map((label, i) => ({ id: "n" + i, label, shape: shapes[i % shapes.length] }));
  const links = nodes.slice(1).map((n, i) => ({ id: "l" + i, from: nodes[i].id, to: n.id, label: linkLabels[i % linkLabels.length], style: "arrow" }));
  if (layout === "cycle" && nodes.length >= 3) links.push({ id: "lc", from: nodes[nodes.length - 1].id, to: nodes[0].id, label: linkLabels[0], style: "arrow" });
  return { title: "A diagram", layout, nodes, links };
}

test("a row of boxes: labels padded inside, arrows between neighbours, labels beside the arrows", () => {
  const s = spec("row", ["Sun", "Plant", "Sugar"], ["box"], ["gives light", "makes"]);
  const L = D.layoutDiagram(s, measure);
  assert.deepEqual(L.warnings, []);
  assert.deepEqual(problemsIn(L, s), []);
  const ys = [...L.nodes.values()].map((n) => Math.round(n.y + n.h / 2)); assert.ok(Math.max(...ys) - Math.min(...ys) <= 1, "all on one row (same centre line): " + ys);
  for (const link of L.links) assert.equal(link.points.length, 2, "neighbours are joined by a straight arrow");
});

test("a cycle goes around in a ring with arrows between neighbours", () => {
  const s = spec("cycle", ["Evaporation", "Cloud", "Rain", "Ocean"], ["rounded"], ["rises", "falls", "flows"]);
  const L = D.layoutDiagram(s, measure);
  assert.deepEqual(L.warnings, []);
  assert.deepEqual(problemsIn(L, s), []);
  const n = [...L.nodes.values()];
  assert.ok(n[0].x < n[1].x && n[1].y < n[2].y && n[3].x < n[2].x, "clockwise: top-left, top-right, bottom-right, bottom-left");
  assert.equal(L.links.length, 4);
});

test("shapes: circles and ellipses get room for the whole label inside the curve", () => {
  for (const shape of ["ellipse", "circle"]) {
    const s = { title: "", layout: "row", nodes: [{ id: "a", label: "Chloroplast", shape }, { id: "b", label: "Sun", shape }], links: [{ id: "l", from: "a", to: "b", label: "", style: "line" }] };
    const L = D.layoutDiagram(s, measure);
    assert.deepEqual(problemsIn(L, s), [], shape);
  }
});

test("long labels wrap (they are never shrunk) and the box grows to hold them", () => {
  const long = { title: "", layout: "row", nodes: [{ id: "a", label: "A very long label that must wrap onto lines", shape: "box" }, { id: "b", label: "Short", shape: "box" }], links: [] };
  const L = D.layoutDiagram(long, measure);
  const a = L.nodes.get("a"), b = L.nodes.get("b");
  assert.ok(a.labelBox.h > b.labelBox.h * 1.5, "the long label wrapped onto several lines");
  assert.ok(a.labelBox.w <= 200, "wrapped at the label width: " + a.labelBox.w);
  assert.deepEqual(problemsIn(L, long), []);
});

test("a container holds its children inside, with its title above them", () => {
  const s = { title: "Inside a cell", layout: "row", nodes: [
    { id: "cell", label: "Cell", shape: "ellipse" }, { id: "nuc", label: "Nucleus", shape: "circle", in: "cell" }, { id: "mito", label: "Mitochondrion", shape: "rounded", in: "cell" }, { id: "wall", label: "Cell wall", shape: "box" },
  ], links: [{ id: "l", from: "cell", to: "wall", label: "", style: "line" }] };
  const L = D.layoutDiagram(s, measure);
  assert.deepEqual(L.warnings, []);
  assert.deepEqual(problemsIn(L, s), []);
  const cell = L.nodes.get("cell"), nuc = L.nodes.get("nuc");
  assert.ok(nuc.x > cell.x && nuc.x + nuc.w < cell.x + cell.w && nuc.y > cell.labelBox.y + cell.labelBox.h, "child inside, below the container's title");
});

test("a container is always drawn as a rounded box, whatever shape was asked for (a rectangle of children cannot sit inside a curve)", () => {
  for (const shape of ["ellipse", "circle", "none", "box"]) {
    const s = { title: "", layout: "row", nodes: [{ id: "c", label: "Cell", shape }, { id: "a", label: "Nucleus", shape: "rounded", in: "c" }, { id: "b", label: "Wall", shape: "rounded", in: "c" }], links: [] };
    const L = D.layoutDiagram(s, measure);
    assert.equal(L.nodes.get("c").shape, "rounded", "container asked as " + shape);
    assert.deepEqual(problemsIn(L, s), []);
  }
});

test("a diagram too big for a page is rearranged (grid, tighter spacing) instead of overflowing; the handwriting is never shrunk", () => {
  const nodes = ["Carbon dioxide", "Mitochondria", "Water vapour", "Light energy", "Chloroplast", "Evaporation", "Trade routes"].map((label, i) => ({ id: "n" + i, label, shape: "box" }));
  const links = nodes.slice(1).map((n, i) => ({ id: "l" + i, from: nodes[i].id, to: n.id, label: "then", style: "arrow" }));
  const asked = D.layoutDiagram({ title: "Tall", layout: "column", nodes, links }, measure);
  assert.ok(asked.fits && asked.arranged, "a 7-node column becomes something that fits: " + JSON.stringify({ fits: asked.fits, arranged: asked.arranged, w: asked.w, h: asked.h }));
  assert.ok(asked.w <= 929 && asked.h <= 529);
  assert.deepEqual(problemsIn(asked, { title: "Tall", layout: "column", nodes, links }), []);
  const impossible = Array.from({ length: 14 }, (_, i) => ({ id: "m" + i, label: "A very long label that must wrap", shape: "box" }));
  const L = D.layoutDiagram({ title: "", layout: "column", nodes: impossible, links: [] }, measure);
  assert.equal(L.fits, false, "a diagram that cannot fit says so (the board then leaves out the last nodes)");
});

test("a link between non-neighbours goes around through the gutters, never across a node", () => {
  const s = { title: "", layout: "grid", cols: 3, nodes: ["A", "B", "C", "D", "E", "F", "G", "H", "I"].map((l, i) => ({ id: "n" + i, label: l, shape: "box" })), links: [{ id: "x", from: "n0", to: "n8", label: "far", style: "arrow" }, { id: "y", from: "n2", to: "n6", label: "", style: "arrow" }] };
  const L = D.layoutDiagram(s, measure);
  assert.deepEqual(L.warnings, []);
  assert.deepEqual(problemsIn(L, s), []);
  assert.ok(L.links[0].points.length >= 3, "the long link bends");
});

test("a connector label goes beside the line, never on it, and a crowded diagram still keeps them apart", () => {
  const s = spec("row", ["Water", "Steam", "Cloud", "Rain"], ["box"], ["heat", "cools", "condenses"]);
  const L = D.layoutDiagram(s, measure);
  assert.deepEqual(problemsIn(L, s), []);
  for (const link of L.links) { const mid = [(link.points[0][0] + link.points[1][0]) / 2, (link.points[0][1] + link.points[1][1]) / 2]; assert.ok(Math.abs(link.labelBox.y + link.labelBox.h / 2 - mid[1]) > 10, "the label is off the line"); }
});

test("a title has its own band above everything", () => {
  const s = spec("row", ["A", "B"], ["box"], [""]);
  const L = D.layoutDiagram(s, measure);
  assert.ok(L.title && [...L.nodes.values()].every((n) => n.y >= L.title.y + L.title.h + 10));
});

test("the diagram always fits a page, or says so", () => {
  const nodes = Array.from({ length: 8 }, (_, i) => ({ id: "n" + i, label: WORDS[i], shape: "box" }));
  const L = D.layoutDiagram({ title: "Big", layout: "row", nodes, links: [] }, measure);
  assert.ok(L.w <= 928 + 1 && L.h <= 528 + 1 || !L.fits, JSON.stringify({ w: L.w, h: L.h, fits: L.fits }));
  assert.ok(L.w <= 928 + 1, "a row of 8 wraps into several rows instead of running off the page");
});

test("placeLabel: a label next to a point avoids curves, axes and other labels", () => {
  const curve = [[0, 100], [50, 60], [100, 20]];
  const spot = D.placeLabel([50, 60], { w: 60, h: 24 }, { rects: [{ x: 100, y: 30, w: 40, h: 20 }], lines: [curve] }, { x: 0, y: 0, w: 300, h: 200 });
  assert.ok(spot.ok);
  const box = { x: spot.x, y: spot.y, w: 60, h: 24 };
  assert.ok(!D.polylineHitsRect(curve, D.inflate(box, 2)) && !D.overlaps(box, { x: 100, y: 30, w: 40, h: 20 }));
  const cornered = D.placeLabel([5, 5], { w: 60, h: 24 }, { rects: [], lines: [] }, { x: 0, y: 0, w: 300, h: 200 });
  assert.ok(cornered.ok && cornered.x >= 2 && cornered.y >= 2, "stays inside the bounds near a corner");
});

test("FUZZ: 600 random diagrams (every layout, shape and label length, containers and long links): every guarantee holds", () => {
  let diagrams = 0, withLabels = 0, withContainers = 0, rerouted = 0, unclear = 0, oversized = 0;
  for (let seed = 1; seed <= 600; seed++) {
    const r = random(seed * 7919);
    const extreme = seed > 500, maxNodes = extreme ? 8 : 6; // the last 100 seeds push to the largest diagram the planner may ask for
    const layout = ["row", "column", "grid", "cycle"][Math.floor(r() * 4)], count = extreme ? 7 + Math.floor(r() * 2) : 2 + Math.floor(r() * 5);
    const labels = Array.from({ length: count }, () => (extreme && r() < 0.12 ? "A very long label that must wrap" : WORDS[Math.floor(r() * WORDS.length)]));
    const shapes = [["box"], ["rounded"], ["ellipse"], ["circle"], ["box", "ellipse", "none"], ["rounded", "circle"]][Math.floor(r() * 6)];
    const linkLabels = r() < 0.6 ? ["heats", "then", "gives", "turns into", ""] : [""];
    const s = spec(layout, labels, shapes, linkLabels);
    if (r() < 0.25) { // a container with two or three children (the whole diagram stays within the 8 nodes the planner is allowed)
      const kids = 2 + Math.floor(r() * 2);
      s.nodes = s.nodes.slice(0, Math.max(2, maxNodes - 1 - kids));
      const keep = new Set(s.nodes.map((n) => n.id)); s.links = s.links.filter((l) => keep.has(l.from) && keep.has(l.to));
      s.nodes.push({ id: "box", label: "Container", shape: r() < 0.5 ? "rounded" : "ellipse" });
      for (let k = 0; k < kids; k++) s.nodes.push({ id: "kid" + k, label: WORDS[Math.floor(r() * 12)], shape: "rounded", in: "box" });
      s.links.push({ id: "tolink", from: s.nodes[0].id, to: "kid0", label: "", style: "arrow" });
      withContainers++;
    }
    if (r() < 0.3 && s.nodes.length >= 3) { const top = s.nodes.filter((n) => !n.in); s.links.push({ id: "extra", from: top[0].id, to: top[top.length - 1].id, label: r() < 0.5 ? "also" : "", style: "arrow" }); }
    const L = D.layoutDiagram(s, measure);
    const problems = L.fits ? problemsIn(L, s) : [];
    if (!L.fits && !extreme) oversized++;
    assert.deepEqual(problems, [], `seed ${seed} (${layout}, ${count} nodes): ${problems.join("; ")}`);
    diagrams++; if (s.links.some((l) => l.label)) withLabels++;
    rerouted += L.links.filter((l) => l.points.length > 2).length; unclear += L.links.filter((l) => !l.clear).length;
    if (L.fits) assert.ok(L.w <= 929 && L.h <= 529, `seed ${seed}: ${L.w}x${L.h}`);
  }
  assert.ok(diagrams === 600 && withLabels > 100 && withContainers > 80 && rerouted > 30, JSON.stringify({ diagrams, withLabels, withContainers, rerouted }));
  assert.ok(unclear < 12, "links without a clear route are rare: " + unclear);
  assert.ok(oversized <= 6, "realistic diagrams (up to 6 nodes) that cannot be made to fit a page are very rare (and flagged): " + oversized);
});

test("layout is deterministic", () => {
  const s = spec("cycle", ["Sun", "Ocean", "Cloud", "Rain"], ["circle", "box"], ["heats", "rises", ""]);
  assert.equal(JSON.stringify([...D.layoutDiagram(s, measure).nodes.values()]), JSON.stringify([...D.layoutDiagram(s, measure).nodes.values()]));
});
