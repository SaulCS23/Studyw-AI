// Run with: node --test ai-teacher/test/hand.test.js
// Tests for the handwriting engine: text and maths become pen strokes, and the pen timeline is sane.
const test = require("node:test");
const assert = require("node:assert/strict");
const hand = require("../whiteboard-hand.js");

const inkWidth = (r) => { const b = hand.boundsOf(r.strokes); return b.maxX - b.minX; };
const inkHeight = (r) => { const b = hand.boundsOf(r.strokes); return b.maxY - b.minY; };

test("text becomes pen strokes, several per word, none per space", () => {
  const r = hand.typesetText("Hi there", { size: 34 });
  assert.ok(r.strokes.length >= 6, "strokes: " + r.strokes.length);
  assert.ok(r.strokes.every((s) => s.length >= 1));
  assert.deepEqual(r.unsupported, []);
  assert.equal(hand.typesetText("   ", { size: 34 }).strokes.length, 0);
});

test("the same text always gives the same strokes (no flicker between renders)", () => {
  assert.deepEqual(hand.typesetText("Rome", { size: 34 }).strokes, hand.typesetText("Rome", { size: 34 }).strokes);
  assert.deepEqual(hand.typesetMath("x^2", { size: 34 }).strokes, hand.typesetMath("x^2", { size: 34 }).strokes);
});

test("text wraps at the maximum width and grows taller", () => {
  const long = "Plants make sugar from light and water";
  const wide = hand.typesetText(long, { size: 34, maxWidth: 2000 }), narrow = hand.typesetText(long, { size: 34, maxWidth: 260 });
  assert.ok(narrow.height > wide.height * 1.6, `${narrow.height} vs ${wide.height}`);
  assert.ok(narrow.width <= 260 + 4, "width " + narrow.width);
});

test("accented letters (Portuguese, Spanish, German, French) are drawn with extra strokes, not dropped", () => {
  for (const [plain, accented] of [["a", "á"], ["a", "ã"], ["c", "ç"], ["n", "ñ"], ["u", "ü"], ["e", "è"], ["o", "ô"]]) {
    const p = hand.typesetText(plain), a = hand.typesetText(accented);
    assert.ok(a.strokes.length > p.strokes.length, accented + " should add an accent stroke");
    assert.deepEqual(a.unsupported, []);
  }
});

test("characters the font cannot draw are reported, not silently lost", () => {
  const r = hand.typesetText("ok 你好");
  assert.deepEqual(r.unsupported.sort(), ["你", "好"].sort());
  assert.ok(r.strokes.length > 0);
});

test("maths: fractions are stacked and have a bar", () => {
  const frac = hand.typesetMath("\\frac{1}{2}"), flat = hand.typesetMath("1 2");
  assert.ok(inkHeight(frac) > inkHeight(flat) * 1.8, `${inkHeight(frac)} vs ${inkHeight(flat)}`);
  assert.ok(frac.strokes.some((s) => s.length === 2 && Math.abs(s[0][1] - s[1][1]) < 0.01 && Math.abs(s[1][0] - s[0][0]) > 8), "a horizontal bar stroke");
});

test("maths: powers sit up and to the right, indices sit down", () => {
  const base = hand.typesetMath("x"), up = hand.typesetMath("x^2"), down = hand.typesetMath("x_2");
  assert.ok(inkWidth(up) > inkWidth(base) && inkWidth(down) > inkWidth(base));
  assert.ok(inkHeight(up) > inkHeight(base) * 1.15, "power raises the top");
  assert.ok(hand.boundsOf(down.strokes).maxY > hand.boundsOf(base.strokes).maxY - 0.01 && inkHeight(down) > inkHeight(base) * 1.1, "index lowers the bottom");
});

test("maths: roots, sums, integrals, brackets, accents and Greek all produce strokes without complaint", () => {
  for (const latex of ["\\sqrt{x+1}", "\\sqrt[3]{8}", "\\sum_{i=1}^{n} i", "\\int_0^1 x\\,dx", "\\left( \\frac{a}{b} \\right)^2", "\\vec{v}", "\\overline{AB}", "\\pi r^2", "\\theta \\approx 30^\\circ", "x \\leq y \\neq z", "\\lim_{x \\to 0} \\frac{\\sin x}{x}", "a \\Rightarrow b", "\\text{if } x > 0", "6CO_2 + 6H_2O \\rightarrow C_6H_{12}O_6 + 6O_2"]) {
    const r = hand.typesetMath(latex);
    assert.deepEqual(r.unsupported, [], latex + " -> " + r.unsupported);
    assert.ok(r.strokes.length > 2, latex);
    assert.ok(Number.isFinite(r.width) && Number.isFinite(r.height) && r.width > 0 && r.height > 0, latex);
  }
});

test("maths: spacing commands are spaces (no stray characters), and a space adds width", () => {
  const plain = hand.typesetMath("a,b"), spaced = hand.typesetMath("a,\\; b"), same = hand.typesetMath("a, b");
  assert.equal(spaced.strokes.length, plain.strokes.length, "\\; draws nothing");
  assert.equal(hand.typesetMath("a\\quad b").strokes.length, hand.typesetMath("ab").strokes.length);
  assert.ok(hand.typesetMath("a\\quad b").width > hand.typesetMath("ab").width);
  assert.equal(same.strokes.length, plain.strokes.length);
});

test("maths: relations and binary operators get breathing room, signs do not", () => {
  assert.ok(hand.typesetMath("a=b").width > hand.typesetMath("a,b").width - 8);
  assert.ok(hand.typesetMath("a + b").width > hand.typesetMath("ab").width + 20);
  assert.ok(hand.typesetMath("-a").width < hand.typesetMath("b - a").width - 15, "a leading minus is a sign");
});

test("maths: unknown commands are reported and everything else still draws", () => {
  const r = hand.typesetMath("x + \\bogus{y} = 2");
  assert.ok(r.unsupported.includes("\\bogus"));
  assert.ok(r.strokes.length >= 4);
});

test("maths: malformed input never throws", () => {
  for (const bad of ["", "{", "}", "\\frac{1}", "\\sqrt", "x^", "_", "^2", "\\left(", "\\right)", "\\text{", "{{{{", "\\\\", "x^{y^{z^{w}}}"]) {
    assert.doesNotThrow(() => hand.typesetMath(bad), JSON.stringify(bad));
  }
});

test("timeline: constant speed, pen lifts between strokes, ends where it should", () => {
  const strokes = [[[0, 0], [320, 0]], [[0, 50], [0, 50.5]], [[100, 100], [100, 420]]];
  const t = hand.strokeTimeline(strokes, { drawSpeed: 320, moveSpeed: 1400, lift: 30 });
  assert.equal(t.items.length, 3);
  assert.equal(Math.round(t.items[0].drawEnd - t.items[0].drawStart), 1000, "320 units at 320/s");
  assert.ok(t.items[1].drawEnd - t.items[1].drawStart >= 70, "a dot takes a moment");
  assert.ok(t.items[1].moveEnd > t.items[1].moveStart, "lifted travel takes time");
  assert.ok(t.items.every((it, i) => i === 0 || it.moveStart >= t.items[i - 1].drawEnd));
  assert.ok(Math.abs(t.total - t.items[2].drawEnd) < 1e-6);
});

test("timeline: the pen position follows the strokes", () => {
  const t = hand.strokeTimeline([[[0, 0], [100, 0]], [[100, 100], [200, 100]]], { drawSpeed: 100, moveSpeed: 1000, lift: 0 });
  const mid = hand.penAt(t, 500);
  assert.ok(mid.down && Math.abs(mid.x - 50) < 1e-6 && mid.y === 0);
  const travel = hand.penAt(t, t.items[1].moveStart + (t.items[1].moveEnd - t.items[1].moveStart) / 2);
  assert.equal(travel.down, false);
  const end = hand.penAt(t, t.total + 10);
  assert.deepEqual([end.x, end.y], [200, 100]);
});

test("writing speed is human: a short word takes a second or two, a line a few seconds", () => {
  const word = hand.strokeTimeline(hand.typesetText("Rome", { size: 34 }).strokes).total;
  const line = hand.strokeTimeline(hand.typesetText("Plants make sugar from light", { size: 34 }).strokes).total;
  assert.ok(word > 600 && word < 3500, "word ms " + word);
  assert.ok(line > 3000 && line < 12000, "line ms " + line);
});
