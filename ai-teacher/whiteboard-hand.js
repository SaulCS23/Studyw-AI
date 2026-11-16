/* Handwriting engine: turns text and LaTeX-style maths into PEN STROKES, so the board can draw letters,
 * digits and equations the way a hand does, one stroke at a time, instead of revealing a finished image.
 *
 *  - Glyphs come from a single-stroke font (whiteboard-font.js): every letter is a few polylines, in the
 *    order a pen would draw them.
 *  - typesetText() lays out words (with line wrapping and accented letters).
 *  - typesetMath() is a small maths typesetter: fractions, roots, powers and indices, sums and integrals,
 *    brackets, accents, Greek letters and common symbols. It outputs strokes directly (no HTML involved).
 *  - strokeTimeline() says when the pen is down, when it is lifted and where it travels.
 *
 * No DOM here, so it is unit-tested in Node. Coordinates: x right, y down, in board units.
 * Classic script (not a module) so index.html still works when opened from disk.
 */
(function (root, factory) {
  const fonts = typeof module === "object" && module.exports ? require("./whiteboard-font.js") : root.WhiteboardFontData;
  const api = factory(fonts);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WhiteboardHand = api;
})(typeof self !== "undefined" ? self : this, function (FONTS) {
  "use strict";

  const BASELINE = 22;        // font units: where letters sit
  const CAP = 21;             // font units: capital letter height
  const UNIT = 30;            // size / UNIT = scale from font units to board units
  const SPACE = 14;           // font units: width of a space
  const AXIS = 8;             // font units: height of the maths axis (where fraction bars and minus signs sit)

  /* ---------- Glyphs ---------- */

  const glyphCache = new Map();
  function makeGlyph(advance, strokes) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const stroke of strokes) for (const [x, y] of stroke) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    if (!strokes.length) { minX = 0; maxX = advance; minY = 0; maxY = 0; }
    return { advance, strokes, minX, maxX, minY, maxY };
  }
  /** A glyph from the font data, in font units with the baseline at y = 0 (letters extend upward as negative y). */
  function fontGlyph(setName, key) {
    const id = setName + "\u0000" + key;
    if (glyphCache.has(id)) return glyphCache.get(id);
    const raw = FONTS && FONTS[setName] && FONTS[setName][key];
    let result = null;
    if (raw) {
      const strokes = raw[1].split("M").filter(Boolean)
        .map((chunk) => (chunk.match(/-?\d+,-?\d+/g) || []).map((pair) => { const [x, y] = pair.split(","); return [+x, +y - BASELINE]; }))
        .filter((stroke) => stroke.length);
      result = makeGlyph(raw[0], strokes);
    }
    glyphCache.set(id, result);
    return result;
  }
  const custom = (advance, strokes) => makeGlyph(advance, strokes);
  const arc = (cx, cy, rx, ry, from, to, steps) => Array.from({ length: steps + 1 }, (_, i) => { const a = from + ((to - from) * i) / steps; return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]; });
  const wave = (x0, x1, y, amplitude) => Array.from({ length: 9 }, (_, i) => [x0 + ((x1 - x0) * i) / 8, y - amplitude * Math.sin((i / 8) * Math.PI * 2)]);

  /** Symbols the font lacks, drawn from a few strokes. */
  const CUSTOM_GLYPHS = {
    approx: () => custom(24, [wave(3, 21, -12, 2), wave(3, 21, -6, 2)]),
    Rightarrow: () => custom(28, [[[3, -11], [22, -11]], [[3, -6], [22, -6]], [[17, -16], [24, -8.5], [17, -1]]]),
    Leftarrow: () => custom(28, [[[6, -11], [25, -11]], [[6, -6], [25, -6]], [[11, -16], [4, -8.5], [11, -1]]]),
    Leftrightarrow: () => custom(32, [[[7, -11], [25, -11]], [[7, -6], [25, -6]], [[12, -16], [4, -8.5], [12, -1]], [[20, -16], [28, -8.5], [20, -1]]]),
    leftrightarrow: () => custom(32, [[[3, -8.5], [29, -8.5]], [[10, -13], [3, -8.5], [10, -4]], [[22, -13], [29, -8.5], [22, -4]]]),
    ldots: () => custom(30, [[[5, 0], [5, 0.4]], [[15, 0], [15, 0.4]], [[25, 0], [25, 0.4]]]),
    cdots: () => custom(30, [[[5, -8], [5, -7.6]], [[15, -8], [15, -7.6]], [[25, -8], [25, -7.6]]]),
    prime: () => custom(8, [[[3, -22], [5, -16]]]),
    minus: () => custom(22, [[[3, -AXIS], [19, -AXIS]]]),
    bar: () => custom(8, [[[4, -22], [4, 4]]]),
    surd: () => fontGlyph("math", "o"),
  };

  const SYMBOLS = {
    pm: ["math", "!", "bin"], mp: ["math", '"', "bin"], times: ["math", "#", "bin"], cdot: ["math", "$", "bin"], div: ["math", "x", "bin"],
    leq: ["math", "&", "rel"], le: ["math", "&", "rel"], geq: ["math", "'", "rel"], ge: ["math", "'", "rel"], neq: ["math", "?", "rel"], ne: ["math", "?", "rel"],
    equiv: ["math", "@", "rel"], propto: ["math", "^", "rel"], infty: ["math", "_", "ord"], circ: ["math", "`", "ord"], degree: ["math", "`", "ord"],
    subset: ["math", "d", "rel"], supset: ["math", "f", "rel"], cup: ["math", "e", "bin"], cap: ["math", "g", "bin"], in: ["math", "h", "rel"],
    to: ["math", "i", "rel"], rightarrow: ["math", "i", "rel"], uparrow: ["math", "j", "ord"], leftarrow: ["math", "k", "rel"], downarrow: ["math", "l", "ord"],
    partial: ["math", "m", "ord"], nabla: ["math", "n", "ord"], exists: ["math", "v", "ord"], parallel: ["math", "y", "rel"], perp: ["math", "z", "rel"],
    angle: ["math", "|", "ord"], therefore: ["math", "~", "ord"],
    approx: ["custom", "approx", "rel"], simeq: ["custom", "approx", "rel"], Rightarrow: ["custom", "Rightarrow", "rel"], implies: ["custom", "Rightarrow", "rel"],
    Leftarrow: ["custom", "Leftarrow", "rel"], Leftrightarrow: ["custom", "Leftrightarrow", "rel"], iff: ["custom", "Leftrightarrow", "rel"], leftrightarrow: ["custom", "leftrightarrow", "rel"],
    ldots: ["custom", "ldots", "ord"], dots: ["custom", "ldots", "ord"], cdots: ["custom", "cdots", "ord"], prime: ["custom", "prime", "ord"], minus: ["custom", "minus", "bin"],
    mid: ["custom", "bar", "rel"], surd: ["custom", "surd", "ord"],
  };
  const GREEK = {
    alpha: "a", beta: "b", gamma: "g", delta: "d", epsilon: "e", varepsilon: "e", zeta: "z", eta: "h", theta: "q", vartheta: "q", iota: "i", kappa: "k",
    lambda: "l", mu: "m", nu: "n", xi: "x", omicron: "o", pi: "p", rho: "r", sigma: "s", tau: "t", upsilon: "u", phi: "f", varphi: "f", chi: "c", psi: "y", omega: "w",
    Gamma: "G", Delta: "D", Theta: "Q", Lambda: "L", Xi: "X", Pi: "P", Sigma: "S", Phi: "F", Psi: "Y", Omega: "W",
  };
  const GREEK_UNICODE = { "α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta", "ε": "epsilon", "ζ": "zeta", "η": "eta", "θ": "theta", "ι": "iota", "κ": "kappa", "λ": "lambda", "μ": "mu", "ν": "nu", "ξ": "xi", "ο": "omicron", "π": "pi", "ρ": "rho", "σ": "sigma", "ς": "sigma", "τ": "tau", "υ": "upsilon", "φ": "phi", "χ": "chi", "ψ": "psi", "ω": "omega", "Γ": "Gamma", "Δ": "Delta", "Θ": "Theta", "Λ": "Lambda", "Ξ": "Xi", "Π": "Pi", "Σ": "Sigma", "Φ": "Phi", "Ψ": "Psi", "Ω": "Omega" };
  const UNICODE_SYMBOLS = { "±": "pm", "∓": "mp", "×": "times", "÷": "div", "·": "cdot", "⋅": "cdot", "°": "circ", "≤": "leq", "≥": "geq", "≠": "neq", "≈": "approx", "≡": "equiv", "∞": "infty", "→": "to", "←": "leftarrow", "↑": "uparrow", "↓": "downarrow", "⇒": "Rightarrow", "⇐": "Leftarrow", "⇔": "Leftrightarrow", "↔": "leftrightarrow", "∂": "partial", "∇": "nabla", "∈": "in", "∩": "cap", "∪": "cup", "⊂": "subset", "⊃": "supset", "∃": "exists", "∴": "therefore", "∠": "angle", "⊥": "perp", "∥": "parallel", "∝": "propto", "′": "prime", "…": "ldots", "−": "minus", "–": "minus", "—": "minus", "√": "surd" };
  const ASCII_QUOTES = { "‘": "'", "’": "'", "“": '"', "”": '"', "«": '"', "»": '"', " ": " " };
  const SUPERSCRIPT_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹", SUBSCRIPT_DIGITS = "₀₁₂₃₄₅₆₇₈₉";

  function symbolGlyph(name) {
    if (GREEK[name]) { const g = fontGlyph("greek", GREEK[name]); return g ? { glyph: g, cls: "ord" } : null; }
    const entry = SYMBOLS[name];
    if (!entry) return null;
    const glyph = entry[0] === "custom" ? CUSTOM_GLYPHS[entry[1]]() : fontGlyph(entry[0], entry[1]);
    return glyph ? { glyph, cls: entry[2] } : null;
  }

  /* ---------- Accents: a base letter plus a few extra strokes ---------- */

  function withAccent(base, mark) {
    const top = Math.min(base.minY, -CAP * 0.62), xc = (base.minX + base.maxX) / 2, extra = [];
    switch (mark) {
      case "́": extra.push([[xc - 1.5, top - 3], [xc + 2.5, top - 8]]); break;
      case "̀": extra.push([[xc - 2.5, top - 8], [xc + 1.5, top - 3]]); break;
      case "̂": extra.push([[xc - 3.5, top - 3], [xc, top - 8], [xc + 3.5, top - 3]]); break;
      case "̌": extra.push([[xc - 3.5, top - 8], [xc, top - 3], [xc + 3.5, top - 8]]); break;
      case "̃": extra.push([[xc - 4.5, top - 4], [xc - 2.5, top - 7], [xc + 0.5, top - 4.5], [xc + 3, top - 7.5]]); break;
      case "̈": extra.push([[xc - 3, top - 5], [xc - 3, top - 5.4]], [[xc + 3, top - 5], [xc + 3, top - 5.4]]); break;
      case "̊": extra.push(arc(xc, top - 6, 2.2, 2.2, 0, Math.PI * 2, 10)); break;
      case "̧": extra.push([[xc, 0], [xc + 0.6, 3], [xc + 2.6, 4.5], [xc + 1.6, 7], [xc - 1.4, 7.6]]); break;
      default: return null;
    }
    return makeGlyph(base.advance, [...base.strokes, ...extra]);
  }

  /** Glyph (font units) for one character of ordinary text, or null if the font cannot draw it. */
  function textGlyph(ch) {
    if (ASCII_QUOTES[ch]) ch = ASCII_QUOTES[ch];
    const code = ch.codePointAt(0);
    // Print capitals with cursive lowercase: capitals stay legible (H2O, DNA) while words still look handwritten.
    if (code >= 65 && code <= 90) return { glyph: fontGlyph("caps", ch) };
    if (code >= 33 && code <= 126) return { glyph: fontGlyph("text", ch) };
    if (GREEK_UNICODE[ch]) return symbolGlyph(GREEK_UNICODE[ch]);
    if (UNICODE_SYMBOLS[ch]) return symbolGlyph(UNICODE_SYMBOLS[ch]);
    const sup = SUPERSCRIPT_DIGITS.indexOf(ch), sub = SUBSCRIPT_DIGITS.indexOf(ch);
    if (sup >= 0) return { glyph: fontGlyph("text", String(sup)), scale: 0.62, dy: -11 };
    if (sub >= 0) return { glyph: fontGlyph("text", String(sub)), scale: 0.62, dy: 5 };
    return null;
  }

  /* ---------- Small helpers ---------- */

  function makeRandom(seedText) {
    let h = 1779033703 ^ String(seedText).length;
    for (let i = 0; i < String(seedText).length; i++) { h = Math.imul(h ^ String(seedText).charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    let a = h >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const translate = (strokes, dx, dy) => strokes.map((stroke) => stroke.map(([x, y]) => [x + dx, y + dy]));
  const emptyBox = (w) => ({ w, asc: 0, desc: 0, strokes: [] });

  /** A glyph as a box at scale s: slight random tilt and lift per glyph so the writing is not machine-perfect. */
  function glyphBox(glyph, s, ctx, extra) {
    const scale = s * ((extra && extra.scale) || 1), dyUnits = (extra && extra.dy) || 0;
    const rotation = (ctx.random() - 0.5) * 2 * ctx.tilt, lift = (ctx.random() - 0.5) * 2 * ctx.lift * scale;
    const cos = Math.cos(rotation), sin = Math.sin(rotation), cx = glyph.advance / 2, cy = -CAP / 2;
    const strokes = glyph.strokes.map((stroke) => stroke.map(([x, y]) => {
      const px = x - cx, py = y - cy;
      return [(px * cos - py * sin + cx) * scale, (px * sin + py * cos + cy) * scale + lift + dyUnits * s];
    }));
    return { w: glyph.advance * scale, asc: Math.max(0, -glyph.minY * scale - dyUnits * s), desc: Math.max(0, glyph.maxY * scale + dyUnits * s), strokes };
  }

  function boundsOf(strokes) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const stroke of strokes) for (const [x, y] of stroke) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    return strokes.length ? { minX, maxX, minY, maxY } : { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  }

  /** Move strokes so the top-left of their ink is at (pad, pad); report the size. */
  function finish(strokes, advanceWidth, extras) {
    const b = boundsOf(strokes), pad = 2;
    const shifted = translate(strokes, pad - Math.min(0, b.minX), pad - b.minY);
    return { strokes: shifted, width: Math.max(advanceWidth, b.maxX - Math.min(0, b.minX)) + pad * 2, height: b.maxY - b.minY + pad * 2, baseline: pad - b.minY, ...extras };
  }

  /* ---------- Plain text ---------- */

  /**
   * Lay out text as pen strokes.
   * @returns {{strokes:number[][][], width:number, height:number, unsupported:string[]}}
   */
  function typesetText(text, options) {
    const o = options || {};
    const size = o.size || 34, s = size / UNIT, maxWidth = o.maxWidth || Infinity;
    const ctx = { random: makeRandom(o.seed == null ? text : o.seed), tilt: 0.035, lift: 0.5 };
    const unsupported = [];
    const words = [[]]; // each word is a list of glyph boxes; blank entries between words mark spaces
    const lineBreaks = new Set();
    const chars = Array.from(String(text).normalize("NFD"));
    for (let i = 0; i < chars.length; i++) {
      let ch = chars[i];
      if (ch === "\n") { words.push([]); lineBreaks.add(words.length - 1); continue; }
      if (/\s/.test(ch)) { if (words[words.length - 1].length) words.push([]); continue; }
      let found = textGlyph(ch), glyph = found && found.glyph;
      while (i + 1 < chars.length && /[̀-ͯ]/.test(chars[i + 1])) { // combining marks: draw the accent on the previous letter
        const mark = chars[++i];
        const accented = glyph && withAccent(glyph, mark);
        if (accented) glyph = accented; else if (!unsupported.includes(ch + mark)) unsupported.push(ch + mark);
      }
      if (!glyph) { if (!unsupported.includes(ch)) unsupported.push(ch); continue; }
      words[words.length - 1].push(glyphBox(glyph, s, ctx, found));
    }
    const lines = [[]]; let lineWidth = 0;
    const spaceWidth = SPACE * s, wordWidth = (word) => word.reduce((sum, b) => sum + b.w, 0);
    words.forEach((word, index) => {
      if (lineBreaks.has(index)) { lines.push([]); lineWidth = 0; return; }
      if (!word.length) return;
      const width = wordWidth(word), extra = lines[lines.length - 1].length ? spaceWidth : 0;
      if (lines[lines.length - 1].length && lineWidth + extra + width > maxWidth) { lines.push([]); lineWidth = 0; }
      const line = lines[lines.length - 1];
      lineWidth += (line.length ? spaceWidth : 0) + width;
      line.push(word);
    });
    const lineHeight = 38 * s, strokes = []; let advanceWidth = 0;
    lines.forEach((line, row) => {
      let x = 0;
      line.forEach((word, wi) => {
        if (wi) x += spaceWidth;
        for (const box of word) { strokes.push(...translate(box.strokes, x, row * lineHeight)); x += box.w; }
      });
      advanceWidth = Math.max(advanceWidth, x);
    });
    return finish(strokes, advanceWidth, { unsupported, warnings: [] });
  }

  /* ---------- Maths: parse a LaTeX subset ---------- */

  const FUNCTIONS = new Set("sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh log ln exp lim max min det sup inf".split(" "));
  const LIMIT_FUNCTIONS = new Set(["lim", "max", "min", "sup", "inf"]);
  const BIG_OPERATORS = { sum: "sum", prod: "prod", int: "int", iint: "int", oint: "int" };
  const SPACES = { ",": 3, ";": 5, ":": 4, "!": 0, " ": 5, quad: 14, qquad: 28 };
  const ACCENTS = new Set(["vec", "bar", "overline", "hat", "widehat", "underline", "dot", "tilde", "overrightarrow"]);
  const TEXT_COMMANDS = new Set(["text", "mathrm", "textbf", "mathbf", "mathit", "operatorname", "mbox", "textrm"]);

  function tokenizeMath(src) {
    const tokens = []; let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { while (i < src.length && /\s/.test(src[i])) i++; tokens.push({ t: "sp" }); continue; }
      if (c === "\\") {
        let j = i + 1;
        if (/[A-Za-z]/.test(src[j] || "")) { while (/[A-Za-z]/.test(src[j] || "")) j++; tokens.push({ t: "cmd", v: src.slice(i + 1, j) }); i = j; }
        else { tokens.push({ t: "cmd", v: src[j] || "" }); i = j + 1; }
        continue;
      }
      if ("{}^_".includes(c)) { tokens.push({ t: c }); i++; continue; }
      const ch = String.fromCodePoint(src.codePointAt(i)); tokens.push({ t: "ch", v: ch }); i += ch.length;
    }
    return tokens;
  }

  function parseMath(src, warnings) {
    const tokens = tokenizeMath(src); let p = 0;
    const skipSpaces = () => { while (tokens[p] && tokens[p].t === "sp") p++; };
    const warn = (message) => { if (!warnings.includes(message)) warnings.push(message); };

    function parseSequence(stop) {
      const nodes = [];
      for (;;) {
        skipSpaces();
        const t = tokens[p];
        if (!t) break;
        if (stop === "}" && t.t === "}") break;
        if (stop === "right" && t.t === "cmd" && t.v === "right") break;
        if (t.t === "}") { p++; warn("unmatched }"); continue; }
        nodes.push(parseScripted());
      }
      return nodes;
    }
    function parseScripted() {
      const base = parseAtom(); let sup = null, sub = null;
      for (;;) {
        skipSpaces();
        const t = tokens[p];
        if (t && t.t === "^") { p++; sup = parseArgument(); } else if (t && t.t === "_") { p++; sub = parseArgument(); } else break;
      }
      return sup || sub ? { k: "script", base, sup, sub } : base;
    }
    function parseArgument() {
      skipSpaces();
      const t = tokens[p];
      if (!t) return [];
      if (t.t === "{") { p++; const body = parseSequence("}"); if (tokens[p] && tokens[p].t === "}") p++; return body; }
      return [parseAtom()];
    }
    function parseRawText() { // \text{...}: keep spaces
      skipSpaces();
      let out = "";
      if (tokens[p] && tokens[p].t === "{") {
        p++; let depth = 1;
        while (tokens[p] && depth) {
          const t = tokens[p++];
          if (t.t === "{") depth++; else if (t.t === "}") { depth--; } else if (t.t === "sp") out += " "; else if (t.t === "ch") out += t.v; else if (t.t === "cmd") out += t.v === " " ? " " : t.v.length === 1 ? t.v : "";
        }
      } else if (tokens[p]) { const t = tokens[p++]; if (t.t === "ch") out = t.v; }
      return out;
    }
    function parseDelimiter() {
      skipSpaces();
      const t = tokens[p++];
      if (!t) return ".";
      if (t.t === "ch") return t.v;
      if (t.t === "cmd") return { lbrace: "{", rbrace: "}", langle: "<", rangle: ">", vert: "|", "|": "|", "{": "{", "}": "}" }[t.v] || ".";
      return ".";
    }
    function parseAtom() {
      skipSpaces();
      const t = tokens[p++];
      if (!t) return { k: "empty" };
      if (t.t === "{") { const body = parseSequence("}"); if (tokens[p] && tokens[p].t === "}") p++; return { k: "group", body }; }
      if (t.t === "^" || t.t === "_") { p--; return { k: "empty" }; }
      if (t.t === "ch") return t.v === "'" ? { k: "sym", name: "prime" } : { k: "char", ch: t.v };
      if (t.t === "cmd") return parseCommand(t.v);
      return { k: "empty" };
    }
    function parseCommand(name) {
      if (name === "frac" || name === "dfrac" || name === "tfrac") return { k: "frac", n: parseArgument(), d: parseArgument() };
      if (name === "sqrt") {
        skipSpaces(); let index = null;
        if (tokens[p] && tokens[p].t === "ch" && tokens[p].v === "[") { p++; index = []; while (tokens[p] && !(tokens[p].t === "ch" && tokens[p].v === "]")) index.push(parseScripted()); p++; }
        return { k: "sqrt", index, body: parseArgument() };
      }
      if (TEXT_COMMANDS.has(name)) return { k: "text", str: parseRawText() };
      if (name === "left") { const open = parseDelimiter(); const body = parseSequence("right"); let close = "."; if (tokens[p] && tokens[p].t === "cmd" && tokens[p].v === "right") { p++; close = parseDelimiter(); } return { k: "lr", open, close, body }; }
      if (name === "right") { warn("\\right without \\left"); return { k: "empty" }; }
      if (ACCENTS.has(name)) return { k: "accent", type: name, body: parseArgument() };
      if (BIG_OPERATORS[name]) return { k: "bigop", name: BIG_OPERATORS[name] };
      if (FUNCTIONS.has(name)) return { k: "func", name, limits: LIMIT_FUNCTIONS.has(name) };
      if (name in SPACES) return { k: "space", w: SPACES[name] };
      if (GREEK[name] || SYMBOLS[name]) return { k: "sym", name };
      if ("{}%$&#_".includes(name) && name) return { k: "char", ch: name };
      warn("\\" + name);
      return { k: "empty" };
    }
    return parseSequence(null);
  }

  /* ---------- Maths: lay the parsed tree out as strokes ---------- */

  const MATH_CHAR_OPERATORS = { "+": ["math", "+", "bin"], "-": ["math", "-", "bin"], "=": ["math", "=", "rel"], "<": ["math", "<", "rel"], ">": ["math", ">", "rel"], "(": ["math", "(", "open"], ")": ["math", ")", "close"], "[": ["math", "[", "open"], "]": ["math", "]", "close"], "/": ["math", "/", "ord"], "*": ["math", "*", "bin"], ",": ["math", ",", "punct"], ";": ["text", ";", "punct"] };

  function mathChar(ch, s, ctx) {
    let glyph = null, cls = "ord", extra = null;
    const op = MATH_CHAR_OPERATORS[ch];
    if (op) { glyph = fontGlyph(op[0], op[1]); cls = op[2]; }
    else { const found = textGlyph(ch); if (found) { glyph = found.glyph; extra = found; if (found.cls) cls = found.cls; } }
    if (!glyph) { if (!ctx.unsupported.includes(ch)) ctx.unsupported.push(ch); return { box: emptyBox(4 * s), cls: "ord" }; }
    return { box: glyphBox(glyph, s, ctx, extra), cls };
  }

  function compose(parts) {
    let w = 0, asc = 0, desc = 0; const strokes = [];
    for (const { box, dx, dy } of parts) {
      strokes.push(...translate(box.strokes, dx, dy));
      w = Math.max(w, dx + box.w); asc = Math.max(asc, box.asc - dy); desc = Math.max(desc, box.desc + dy);
    }
    return { w, asc, desc, strokes };
  }

  function measure(box) {
    const b = boundsOf(box.strokes);
    return { ...box, asc: Math.max(0, -b.minY), desc: Math.max(0, b.maxY) };
  }

  function layoutDelimiter(ch, height, centreY, s, ctx) {
    const tall = height > CAP * 1.45 * s;
    const glyphs = { "(": ["math", tall ? "r" : "("], ")": ["math", tall ? "s" : ")"], "[": ["math", tall ? "t" : "["], "]": ["math", tall ? "u" : "]"], "{": ["math", "{"], "}": ["math", "}"] };
    if (ch === "." || ch === "") return emptyBox(1 * s);
    if (ch === "|") { const h = Math.max(height, CAP * 1.1 * s); return { w: 8 * s, asc: h / 2 - centreY, desc: h / 2 + centreY, strokes: [[[4 * s, centreY - h / 2], [4 * s, centreY + h / 2]]] }; }
    if (ch === "<" || ch === ">") { const h = Math.max(height, CAP * s) / 2, x0 = ch === "<" ? 8 * s : 2 * s, x1 = ch === "<" ? 2 * s : 8 * s; return { w: 10 * s, asc: h - centreY, desc: h + centreY, strokes: [[[x0, centreY - h], [x1, centreY], [x0, centreY + h]]] }; }
    const spec = glyphs[ch];
    const glyph = spec && fontGlyph(spec[0], spec[1]);
    if (!glyph) return mathChar(ch, s, ctx).box;
    if (!tall && !(height > CAP * 1.1 * s)) return glyphBox(glyph, s, ctx);
    const natural = glyph.maxY - glyph.minY, k = Math.max(s, height / natural);
    const box = glyphBox(glyph, k, ctx), glyphCentre = ((glyph.minY + glyph.maxY) / 2) * k;
    return measure({ w: glyph.advance * Math.min(k, s * 1.6), strokes: translate(box.strokes, 0, centreY - glyphCentre) });
  }

  function layoutSequence(nodes, ctx) {
    const s = ctx.s, parts = []; let x = 0, previous = null, gap = 0;
    for (const node of nodes) {
      const layout = layoutNode(node, ctx);
      let cls = layout.cls || "ord";
      if (cls === "bin" && (previous === null || ["bin", "rel", "open", "punct"].includes(previous))) cls = "ord"; // a sign, not an operator
      let before = gap;
      if (cls === "rel") before = Math.max(before, 7 * s); else if (cls === "bin") before = Math.max(before, 5 * s);
      x += before;
      parts.push({ box: layout.box, dx: x, dy: layout.dy || 0 });
      x += layout.box.w;
      gap = cls === "rel" ? 7 * s : cls === "bin" ? 5 * s : cls === "punct" ? 4 * s : 0;
      if (layout.after) gap = Math.max(gap, layout.after);
      previous = cls;
    }
    const box = compose(parts);
    box.w = Math.max(box.w, x);
    return box;
  }

  const smaller = (ctx, factor) => ({ ...ctx, s: ctx.s * factor, depth: ctx.depth + 1 });

  function layoutNode(node, ctx) {
    const s = ctx.s;
    switch (node.k) {
      case "empty": return { box: emptyBox(0) };
      case "char": return mathChar(node.ch, s, ctx);
      case "sym": {
        const found = symbolGlyph(node.name);
        if (!found) { ctx.unsupported.push("\\" + node.name); return { box: emptyBox(4 * s) }; }
        return { box: glyphBox(found.glyph, s, ctx), cls: found.cls };
      }
      case "group": return { box: layoutSequence(node.body, ctx) };
      case "space": return { box: emptyBox(node.w * s) };
      case "text": {
        const text = typesetText(node.str, { size: ctx.s * UNIT, seed: node.str + ctx.depth });
        if (text.unsupported.length) text.unsupported.forEach((u) => ctx.unsupported.push(u));
        const b = boundsOf(text.strokes), baseline = text.baseline;
        return { box: { w: text.width - 4, asc: Math.max(0, baseline - b.minY), desc: Math.max(0, b.maxY - baseline), strokes: translate(text.strokes, -2, -baseline) } };
      }
      case "func": {
        const text = layoutNode({ k: "text", str: node.name }, ctx);
        return { box: text.box, after: 3 * s, limits: node.limits, isFunc: true };
      }
      case "frac": {
        const inner = smaller(ctx, 0.88), n = layoutSequence(node.n, inner), d = layoutSequence(node.d, inner);
        const w = Math.max(n.w, d.w) + 6 * s, barY = -AXIS * s, gap = 3.5 * s;
        const nBase = barY - gap - n.desc, dBase = barY + gap + Math.max(d.asc, 12 * inner.s);
        const box = compose([
          { box: n, dx: (w - n.w) / 2, dy: nBase },
          { box: d, dx: (w - d.w) / 2, dy: dBase },
          { box: { w, asc: 0, desc: 0, strokes: [[[0.5 * s, barY], [w - 0.5 * s, barY]]] }, dx: 0, dy: 0 },
        ]);
        box.asc = Math.max(box.asc, -nBase + n.asc); box.desc = Math.max(box.desc, dBase + d.desc);
        return { box: { ...box, w: w + 2 * s }, dy: 0 };
      }
      case "sqrt": {
        const body = layoutSequence(node.body, ctx);
        const top = -(Math.max(body.asc, CAP * 0.8 * s) + 5 * s), bottom = Math.max(body.desc, 0) + 1.2 * s, mid = top + (bottom - top) * 0.58, sign = 11 * s;
        let indexBox = null;
        if (node.index) indexBox = layoutSequence(node.index, smaller(ctx, 0.5));
        const lead = indexBox ? Math.max(0, indexBox.w - 4 * s) : 0;
        const radical = [[0, mid + 1.2 * s], [2.4 * s, mid - 0.6 * s], [5.6 * s, bottom], [9.6 * s, top], [sign + body.w + 3 * s, top]];
        const parts = [{ box: { w: 0, asc: 0, desc: 0, strokes: [radical.map(([x, y]) => [x + lead, y])] }, dx: 0, dy: 0 }, { box: body, dx: lead + sign, dy: 0 }];
        if (indexBox) parts.push({ box: indexBox, dx: 0, dy: top * 0.62 });
        const box = compose(parts);
        box.w = lead + sign + body.w + 3.5 * s; box.asc = Math.max(box.asc, -top); box.desc = Math.max(box.desc, bottom);
        return { box };
      }
      case "bigop": {
        const glyph = node.name === "sum" ? fontGlyph("math", ";") : node.name === "prod" ? fontGlyph("math", ":") : fontGlyph("math", "q");
        const target = (node.name === "int" ? 2.1 : 1.45) * CAP * s;
        const natural = glyph.maxY - glyph.minY, k = target / natural, box = glyphBox(glyph, k, ctx);
        const centre = ((glyph.minY + glyph.maxY) / 2) * k;
        const placed = measure({ w: glyph.advance * k, strokes: translate(box.strokes, 0, -AXIS * s - centre) });
        return { box: placed, limits: node.name !== "int", isOperator: true, after: 2 * s };
      }
      case "accent": {
        const body = layoutSequence(node.body, ctx), top = -(body.asc + 4 * s), bottom = body.desc + 4 * s, w = body.w, extra = [];
        if (node.type === "vec" || node.type === "overrightarrow") extra.push([[0.1 * w, top], [0.95 * w, top]], [[0.95 * w - 3.5 * s, top - 2.5 * s], [0.95 * w, top], [0.95 * w - 3.5 * s, top + 2.5 * s]]);
        else if (node.type === "bar" || node.type === "overline") extra.push([[0.05 * w, top + 1.5 * s], [0.95 * w, top + 1.5 * s]]);
        else if (node.type === "underline") extra.push([[0.05 * w, bottom], [0.95 * w, bottom]]);
        else if (node.type === "hat" || node.type === "widehat") extra.push([[w / 2 - 3.5 * s, top + 2 * s], [w / 2, top - 2 * s], [w / 2 + 3.5 * s, top + 2 * s]]);
        else if (node.type === "tilde") extra.push([[w / 2 - 4.5 * s, top], [w / 2 - 2 * s, top - 2.5 * s], [w / 2 + 1 * s, top + 0.2 * s], [w / 2 + 4 * s, top - 2.5 * s]]);
        else if (node.type === "dot") extra.push([[w / 2, top], [w / 2, top + 0.4]]);
        const box = compose([{ box: body, dx: 0, dy: 0 }, { box: { w, asc: 0, desc: 0, strokes: extra }, dx: 0, dy: 0 }]);
        box.asc = Math.max(box.asc, -top + 2 * s); box.desc = Math.max(box.desc, node.type === "underline" ? bottom : body.desc);
        return { box };
      }
      case "lr": {
        const inner = layoutSequence(node.body, ctx);
        const height = inner.asc + inner.desc + 3 * s, centre = -(inner.asc - inner.desc) / 2;
        const open = layoutDelimiter(node.open, height, centre, s, ctx), close = layoutDelimiter(node.close, height, centre, s, ctx);
        const box = compose([{ box: open, dx: 0, dy: 0 }, { box: inner, dx: open.w, dy: 0 }, { box: close, dx: open.w + inner.w, dy: 0 }]);
        box.w = open.w + inner.w + close.w;
        return { box };
      }
      case "script": return layoutScript(node, ctx);
      default: return { box: emptyBox(0) };
    }
  }

  function layoutScript(node, ctx) {
    const s = ctx.s, base = layoutNode(node.base, ctx), baseBox = base.box;
    const inner = smaller(ctx, ctx.depth >= 1 ? 0.8 : 0.7);
    const sup = node.sup ? layoutSequence(node.sup, inner) : null, sub = node.sub ? layoutSequence(node.sub, inner) : null;
    const limits = base.limits && (base.isOperator || base.isFunc);
    const parts = [{ box: baseBox, dx: 0, dy: 0 }]; let w = baseBox.w;
    if (limits) {
      const width = Math.max(baseBox.w, sup ? sup.w : 0, sub ? sub.w : 0);
      parts[0].dx = (width - baseBox.w) / 2;
      if (sup) parts.push({ box: sup, dx: (width - sup.w) / 2, dy: -(baseBox.asc + 4.5 * s + sup.desc) });
      if (sub) parts.push({ box: sub, dx: (width - sub.w) / 2, dy: baseBox.desc + 4.5 * s + sub.asc });
      w = width;
    } else {
      const isIntegral = base.isOperator && !base.limits;
      const supY = -Math.max(baseBox.asc * (isIntegral ? 0.85 : 0.62), 10 * s) + (sup ? 0 : 0);
      const subY = isIntegral ? baseBox.desc * 0.7 + 1 * s : Math.max(baseBox.desc, 0) + 4.2 * s;
      const x = baseBox.w + 0.8 * s;
      if (sup) parts.push({ box: sup, dx: x, dy: supY });
      if (sub) parts.push({ box: sub, dx: x, dy: subY });
      w = x + Math.max(sup ? sup.w : 0, sub ? sub.w : 0);
    }
    const box = compose(parts);
    box.w = w;
    return { box, cls: base.cls, after: base.after };
  }

  /**
   * Lay out a LaTeX-style expression as pen strokes.
   * @returns {{strokes:number[][][], width:number, height:number, unsupported:string[], warnings:string[]}}
   */
  function typesetMath(latex, options) {
    const o = options || {}, size = o.size || 34, warnings = [], unsupported = [];
    const tree = parseMath(String(latex), warnings);
    const ctx = { s: size / UNIT, depth: 0, random: makeRandom(o.seed == null ? latex : o.seed), tilt: 0.012, lift: 0.25, unsupported };
    const box = layoutSequence(tree, ctx);
    warnings.forEach((w) => { if (!unsupported.includes(w)) unsupported.push(w); });
    return finish(box.strokes, box.w, { unsupported, warnings });
  }

  /* ---------- Pen timeline ---------- */

  const strokeLength = (points) => { let total = 0; for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]); return total; };

  /**
   * When each stroke is drawn. Pen-down speed and pen-up travel are separate, and every lifted move
   * costs a short pause, like a real hand. Times are in milliseconds at normal speed.
   */
  function strokeTimeline(strokes, options) {
    const o = options || {}, drawSpeed = o.drawSpeed || 320, moveSpeed = o.moveSpeed || 1400, lift = o.lift == null ? 30 : o.lift;
    let time = 0, position = null; const items = [];
    strokes.forEach((points, index) => {
      const cumulative = [0];
      for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
      const length = cumulative[cumulative.length - 1];
      const travel = position ? (Math.hypot(points[0][0] - position[0], points[0][1] - position[1]) / moveSpeed) * 1000 + lift : 0;
      const moveStart = time; time += travel;
      const drawMs = Math.max(70, (length / drawSpeed) * 1000);
      items.push({ index, points, cumulative, length, from: position, moveStart, moveEnd: time, drawStart: time, drawEnd: time + drawMs });
      time += drawMs; position = points[points.length - 1];
    });
    return { total: time, items };
  }

  /** Where the pen is at time t (ms) on a timeline: { x, y, down, stroke }. */
  function penAt(timeline, t) {
    const items = timeline.items;
    if (!items.length) return null;
    for (const item of items) {
      if (t < item.moveEnd && item.from) {
        const f = item.moveEnd === item.moveStart ? 1 : (t - item.moveStart) / (item.moveEnd - item.moveStart);
        return { x: item.from[0] + (item.points[0][0] - item.from[0]) * f, y: item.from[1] + (item.points[0][1] - item.from[1]) * f, down: false, stroke: item.index };
      }
      if (t < item.drawEnd) {
        const f = (t - item.drawStart) / (item.drawEnd - item.drawStart), distance = f * item.length;
        let i = 1; while (i < item.cumulative.length - 1 && item.cumulative[i] < distance) i++;
        const a = item.points[i - 1] || item.points[0], b = item.points[i] || a, span = (item.cumulative[i] || 0) - (item.cumulative[i - 1] || 0);
        const g = span > 0 ? (distance - item.cumulative[i - 1]) / span : 0;
        return { x: a[0] + (b[0] - a[0]) * g, y: a[1] + (b[1] - a[1]) * g, down: true, stroke: item.index };
      }
    }
    const last = items[items.length - 1], end = last.points[last.points.length - 1];
    return { x: end[0], y: end[1], down: false, stroke: last.index };
  }

  return { typesetText, typesetMath, strokeTimeline, penAt, strokeLength, boundsOf, UNIT, CAP };
});
