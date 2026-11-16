/* Simulated whiteboard steps, written the way the planner would return them, for testing the board without Claude or
 * ElevenLabs. Test data only: the product never reads this file.
 * Each lesson is a list of turns; each turn is what the planner would return after one teacher reply.
 * Every step has a "cue": words copied from that turn's teacher text, where the step's idea begins.
 * Nothing here gives positions: the layout engine places things. Diagram parts use local coordinates inside a group.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WhiteboardFixtures = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const mathematics = {
    subject: "mathematics",
    turns: [
      { teacher: "A parabola is the curve you get from y equals x squared minus four. Let's draw it.", ops: [
        { op: "write", kind: "text", size: "title", content: "Parabolas", id: "title", cue: "A parabola" },
        { op: "write", kind: "math", content: "y = x^2 - 4", id: "eq", color: "blue", cue: "y equals x squared minus four" },
        { op: "graph", id: "g", w: 440, h: 320, xmin: -4, xmax: 4, ymin: -5, ymax: 10, xlabel: "x", ylabel: "y", grid: true, cue: "Let's draw it" },
        { op: "plot", id: "curve", graph: "g", fn: "x^2 - 4", color: "blue", label: "y = x² − 4", cue: "Let's draw it" },
      ] },
      { teacher: "The lowest point is the vertex, right at zero, minus four. It crosses the x axis at plus and minus two.", ops: [
        { op: "point", id: "vertex", graph: "g", px: 0, py: -4, label: "vertex", color: "red", cue: "the vertex" },
        { op: "highlight", target: "eq", color: "amber", cue: "right at zero" },
        { op: "write", kind: "math", content: "x = \\pm 2", id: "roots", color: "green", near: "g", side: "below", cue: "plus and minus two" },
      ] },
      { teacher: "Let's check it by solving. Set y to zero. Then x squared equals four. So x is plus or minus two.", ops: [
        { op: "write", kind: "math", content: "x^2 - 4 = 0", id: "c1", calc: "solve", cue: "Set y to zero" },
        { op: "write", kind: "math", content: "x^2 = 4", id: "c2", calc: "solve", cue: "x squared equals four" },
        { op: "write", kind: "math", content: "x = \\pm 2", id: "c3", calc: "solve", color: "green", cue: "plus or minus two" },
      ] },
    ],
  };

  const biology = {
    subject: "biology",
    turns: [
      { teacher: "Plants use sunlight inside the chloroplast to turn carbon dioxide and water into sugar and oxygen.", ops: [
        { op: "new_page", title: "Photosynthesis", cue: "Plants use sunlight" },
        { op: "write", kind: "text", size: "title", content: "Photosynthesis", id: "btitle", cue: "Plants use sunlight" },
        { op: "diagram", id: "photo", layout: "row", cue: "sunlight", parts: [
          { node: "sun", label: "Sunlight", shape: "circle", color: "amber", cue: "sunlight" },
          { node: "inputs", label: "CO2 and water", shape: "box", color: "blue", cue: "carbon dioxide and water" },
          { node: "leaf", label: "Leaf", shape: "rounded", color: "green", cue: "inside the chloroplast" },
          { node: "chl", label: "Chloroplast", shape: "rounded", color: "green", in: "leaf", cue: "the chloroplast" },
          { node: "out", label: "Sugar and oxygen", shape: "box", color: "violet", cue: "sugar and oxygen" },
          { from: "sun", to: "leaf", label: "light", color: "amber", cue: "sunlight" },
          { from: "inputs", to: "leaf", label: "", color: "blue", cue: "carbon dioxide and water" },
          { from: "leaf", to: "out", label: "makes", color: "violet", cue: "into sugar and oxygen" },
        ] },
      ] },
    ],
  };

  const history = {
    subject: "history",
    turns: [
      { teacher: "Let's put the story of Rome on a timeline: Augustus in 27 BC, the split of the empire in 395, and the fall of the West in 475.", ops: [
        { op: "new_page", title: "Rome", cue: "put the story of Rome" },
        { op: "diagram", id: "tl", title: "Rome: a timeline", layout: "row", cue: "put the story of Rome", parts: [
          { node: "aug", label: "27 BC Augustus", shape: "rounded", color: "red", cue: "Augustus" },
          { node: "split", label: "395 Empire splits", shape: "rounded", color: "blue", cue: "the split of the empire" },
          { node: "fall", label: "West falls", shape: "rounded", color: "green", cue: "the fall of the West" },
          { from: "aug", to: "split", label: "", cue: "the split of the empire" },
          { from: "split", to: "fall", label: "", cue: "the fall of the West" },
        ] },
        { op: "write", kind: "text", size: "small", content: "Fall of the West: 475", id: "fallnote", near: "tl", side: "below", cue: "in 475" },
      ] },
      { teacher: "Sorry, I misspoke. The usual date for the fall is 476, not 475.", ops: [
        { op: "correct", target: "fallnote", with: { op: "write", kind: "text", size: "small", content: "Fall of the West: 476", color: "red", id: "fallnote" }, cue: "476" },
        { op: "highlight", target: "fallnote", color: "amber", cue: "not 475" },
      ] },
    ],
  };

  /** A later student question that changes the subject: a new page, earlier pages are kept. */
  const topicChange = {
    subject: "topic change",
    turns: [
      { teacher: "Switching to cells. Every living thing is made of them.", ops: [
        { op: "new_page", title: "Cells", cue: "Switching to cells" },
        { op: "write", kind: "text", size: "title", content: "Cells", id: "title2", cue: "Switching to cells" },
        { op: "diagram", id: "cellg", layout: "row", cue: "made of them", parts: [
          { node: "cell", label: "Cell", shape: "rounded", color: "green", cue: "made of them" },
          { node: "nuc", label: "Nucleus", shape: "circle", color: "violet", in: "cell", cue: "made of them" },
          { node: "mito", label: "Mitochondrion", shape: "rounded", color: "amber", in: "cell", cue: "made of them" },
          { node: "wall", label: "Cell wall", shape: "box", cue: "made of them" },
          { from: "wall", to: "cell", label: "protects", cue: "made of them" },
        ] },
      ] },
    ],
  };

  /** The teacher goes back to an earlier page, points at an equation, and returns. (Needs the mathematics lesson first.) */
  const revisit = {
    subject: "revisit",
    turns: [
      { teacher: "Remember the parabola from before? Look at the equation again, right there. Now back to where we were.", ops: [
        { op: "go_to_page", page: "p1", cue: "Remember the parabola" },
        { op: "point_to", target: "eq", cue: "the equation" },
        { op: "go_to_page", page: "latest", cue: "back to where we were" },
      ] },
    ],
  };

  /** Three steps tied to three sentences, for testing that each is drawn when it is said. */
  const sentences = {
    subject: "sentences",
    turns: [
      { teacher: "First we look at the triangle. Then we mark the right angle. Finally we write the formula for the area.", ops: [
        { op: "write", kind: "text", content: "Triangle", id: "s1", cue: "the triangle" },
        { op: "write", kind: "text", content: "Right angle", id: "s2", cue: "mark the right angle" },
        { op: "write", kind: "math", content: "A = \\frac{1}{2} b h", id: "s3", cue: "the formula for the area" },
      ] },
    ],
  };

  /** Speaking only: an introduction that needs no picture. The board must not change. */
  const speakOnly = {
    subject: "speak only",
    turns: [{ teacher: "Before we draw anything, let's talk about why graphs matter. A graph turns numbers into a picture you can reason about.", ops: [{ op: "moment", kind: "speak_only", note: "introduction, no picture needed" }] }],
  };

  /** Speaking and writing together: the formula is written while it is being said, not before. */
  const writeWhileSaying = {
    subject: "write while saying",
    turns: [{ teacher: "Let's start with an example. Imagine a triangle. Now the area is one half times the base times the height.", ops: [
      { op: "moment", kind: "write", note: "formula as it is said" },
      { op: "write", kind: "math", content: "A = \\frac{1}{2} b h", id: "area", cue: "the area is one half" },
    ] }],
  };

  /** Drawing a graph while explaining it, with a visual reference: "look at the vertex" must have been drawn by then. */
  const graphWithReference = {
    subject: "graph with a reference",
    turns: [{ teacher: "Let's draw the parabola y equals x squared. It curves up on both sides. Now look at the vertex, right here at the bottom. It sits at zero, zero.", ops: [
      { op: "moment", kind: "draw", note: "graph built as explained" },
      { op: "graph", id: "pg", w: 420, h: 300, xmin: -3, xmax: 3, ymin: -1, ymax: 9, xlabel: "x", ylabel: "y", cue: "draw the parabola" },
      { op: "plot", graph: "pg", fn: "x^2", color: "blue", label: "y = x²", id: "pcurve", cue: "curves up on both sides" },
      { op: "point", graph: "pg", px: 0, py: 0, label: "vertex", color: "red", id: "pvertex", cue: "the vertex", ref: "look at the vertex" },
      { op: "point_to", target: "pvertex", cue: "right here at the bottom" },
    ] }],
  };

  /** Pointing at something that is already on the board, at the moment the teacher refers to it. (Needs the maths lesson first.) */
  const pointAndExplain = {
    subject: "point and explain",
    turns: [{ teacher: "Notice the exponent here. It is the square. And now the minus four at the end, that is where the curve crosses the axis.", ops: [
      { op: "moment", kind: "point", note: "refer to existing writing" },
      { op: "point_to", target: "eq", cue: "the exponent here" },
      { op: "highlight", target: "eq", color: "amber", cue: "minus four at the end" },
    ] }],
  };

  /** A question to the student: nothing is drawn after it, and the answer is never written. */
  const question = {
    subject: "question",
    turns: [{ teacher: "What do you think happens to y when x is zero?", ops: [{ op: "moment", kind: "wait", note: "the student answers" }] }],
  };

  /** Something is drawn to ask the question, and the answer is not. */
  const questionAfterDrawing = {
    subject: "question after drawing",
    turns: [{ teacher: "Here is the line y equals two x. What is y when x is three?", ops: [
      { op: "write", kind: "math", content: "y = 2x", id: "lineq", cue: "the line y equals two x" },
      { op: "moment", kind: "wait", note: "question", cue: "What is y when x is three" },
      { op: "write", kind: "math", content: "y = 6", id: "leaked", cue: "What is y when x is three" },
    ] }],
  };

  /** A worked example, one step at a time: introduce verbally, write while naming the parts, ask, then one step per idea. */
  const derivative = {
    subject: "derivative, step by step",
    turns: [
      { teacher: "Let's try an example. I'll write a function on the board. We have x cubed, plus sine of x. Now, how would we find its derivative?", ops: [
        { op: "write", kind: "math", content: "f(x) = x^3 + \\sin(x)", id: "fx", calc: "d", cue: "I'll write a function" },
        { op: "moment", kind: "wait", note: "the teacher asks the student" },
      ] },
      { teacher: "Let's start with x cubed. Using the power rule, we bring down the three and reduce the exponent by one. Now, the derivative of sine x is cosine x. Putting the two results together gives us the derivative.", ops: [
        { op: "write", kind: "math", content: "\\frac{d}{dx}(x^3) = 3x^2", id: "d1", calc: "d", cue: "Using the power rule" },
        { op: "write", kind: "math", content: "\\frac{d}{dx}(\\sin x) = \\cos x", id: "d2", calc: "d", cue: "the derivative of sine x" },
        { op: "write", kind: "math", content: "f'(x) = 3x^2 + \\cos(x)", id: "d3", calc: "d", cue: "Putting the two results together" },
      ] },
    ],
  };

  /** A rhetorical question that opens a turn which then goes on: the question must not freeze the rest of the turn. */
  const rhetorical = {
    subject: "rhetorical opener",
    turns: [{ teacher: "Can you see this triangle on the board? It has three sides and three angles.", ops: [
      { op: "moment", kind: "wait", note: "(mistaken: decided from the first sentence alone)" },
      { op: "write", kind: "text", content: "Triangle: 3 sides", id: "rh1", cue: "three sides and three angles" },
    ] }],
  };

  /** A reference that the planner got wrong: the teacher says "look at the point" but nothing creates it. */
  const missingReference = {
    subject: "missing reference",
    turns: [{ teacher: "Look at the point I just drew. It is the vertex.", ops: [{ op: "moment", kind: "speak_only" }] }],
  };

  /** A showcase of everything the pen can do, for the slow-motion handwriting page. */
  const handwriting = {
    subject: "handwriting showcase",
    turns: [
      { teacher: "Watch the pen write words, numbers and equations.", ops: [
        { op: "write", kind: "text", size: "title", content: "Photosynthesis", id: "h1", cue: "Watch the pen" },
        { op: "write", kind: "text", content: "Plants make sugar from light", id: "h2", cue: "write words" },
        { op: "write", kind: "text", size: "small", content: "Água, coração, ñandú, Zürich", id: "h3", cue: "write words" },
        { op: "write", kind: "math", content: "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}", id: "h4", color: "blue", cue: "equations" },
        { op: "write", kind: "math", content: "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}", id: "h5", cue: "equations" },
        { op: "write", kind: "math", content: "6CO_2 + 6H_2O \\rightarrow C_6H_{12}O_6 + 6O_2", id: "h6", color: "green", cue: "equations" },
      ] },
      { teacher: "Now a graph: axes, numbers and curves are drawn too.", ops: [
        { op: "new_page", title: "Graph", cue: "Now a graph" },
        { op: "graph", id: "gg", w: 760, h: 480, xmin: -6.3, xmax: 6.3, ymin: -3, ymax: 3, xlabel: "x", ylabel: "y", grid: true, cue: "Now a graph" },
        { op: "plot", graph: "gg", fn: "sin(x)", color: "blue", label: "sin x", id: "sine", cue: "curves" },
        { op: "plot", graph: "gg", fn: "x/3", color: "red", label: "x / 3", id: "line", cue: "curves" },
        { op: "point", graph: "gg", px: 0, py: 0, label: "origin", color: "green", id: "o", cue: "curves" },
      ] },
      { teacher: "And a diagram: arrows, shapes and labels.", ops: [
        { op: "new_page", title: "Water cycle", cue: "And a diagram" },
        { op: "diagram", id: "cycle", title: "The water cycle", layout: "cycle", cue: "And a diagram", parts: [
          { node: "evap", label: "Evaporation", shape: "rounded", color: "violet", cue: "arrows" },
          { node: "cloud", label: "Cloud", shape: "ellipse", color: "ink", cue: "shapes" },
          { node: "rain", label: "Rain", shape: "circle", color: "blue", cue: "labels" },
          { node: "sea", label: "Ocean", shape: "rounded", color: "blue", cue: "labels" },
          { from: "evap", to: "cloud", label: "rises", cue: "arrows" },
          { from: "cloud", to: "rain", label: "cools", cue: "shapes" },
          { from: "rain", to: "sea", label: "falls", cue: "labels" },
          { from: "sea", to: "evap", label: "warms", cue: "labels" },
        ] },
      ] },
    ],
  };

  /**
   * A long lesson: `turns` turns, each adding a few lines, with no page changes asked for, so the notebook has to
   * start new pages by itself. Ids are unique across the whole lesson.
   */
  function longLesson(turns) {
    const topics = ["rivers", "volcanoes", "glaciers", "deserts", "forests", "oceans", "mountains", "islands", "lakes", "caves", "plains", "canyons"];
    return {
      subject: "long lesson",
      turns: Array.from({ length: turns }, (_, n) => {
        const topic = topics[n % topics.length] + " " + (n + 1);
        return { teacher: `Next we talk about ${topic}. It has a name, a size and a rule.`, ops: [
          { op: "write", kind: "text", size: "title", content: "About " + topic, id: "lt" + n, cue: "about " + topic },
          { op: "write", kind: "text", content: "Size is number " + (n + 1), id: "ls" + n, cue: "a size" },
          { op: "write", kind: "math", content: `x_{${n + 1}} = ${n + 1}^2 + \\frac{${n + 1}}{2}`, id: "lm" + n, cue: "a rule" },
        ] };
      }),
    };
  }

  /** A long lesson of small diagrams and notes: several pages, each diagram readable. */
  function longDiagrams(turns) {
    const layouts = ["row", "cycle", "grid", "column", "cycle", "row"];
    const names = [["Source", "River", "Delta"], ["Spring", "Summer", "Autumn", "Winter"], ["Cause", "Event", "Effect", "Result"], ["Seed", "Plant", "Fruit"], ["Plan", "Do", "Check", "Act"], ["Input", "Process", "Output"]];
    return {
      subject: "long diagrams",
      turns: Array.from({ length: turns }, (_, n) => {
        const kind = n % layouts.length, nodes = names[kind];
        const parts = nodes.map((label, i) => ({ node: "dn" + n + "_" + i, label, shape: ["box", "rounded", "ellipse", "circle"][(i + n) % 4], cue: label.toLowerCase() }));
        nodes.forEach((_, i) => { if (i + 1 < nodes.length) parts.push({ from: "dn" + n + "_" + i, to: "dn" + n + "_" + (i + 1), label: ["then", "leads to", "becomes"][i % 3], cue: nodes[i + 1].toLowerCase() }); });
        if (layouts[kind] === "cycle") parts.push({ from: "dn" + n + "_" + (nodes.length - 1), to: "dn" + n + "_0", label: "again", cue: nodes[0].toLowerCase() });
        return { teacher: `Now example ${n + 1}: ${nodes.join(", ").toLowerCase()}.`, ops: [
          { op: "diagram", id: "dg" + n, title: "Example " + (n + 1), layout: layouts[kind], parts, cue: "example " + (n + 1) },
          { op: "write", kind: "text", size: "small", content: "Remember example " + (n + 1), id: "dnote" + n, cue: nodes[nodes.length - 1].toLowerCase() },
        ] };
      }),
    };
  }

  return { mathematics, biology, history, topicChange, revisit, sentences, speakOnly, writeWhileSaying, graphWithReference, pointAndExplain, question, questionAfterDrawing, rhetorical, derivative, missingReference, handwriting, longLesson, longDiagrams, all: [mathematics, biology, history, topicChange, handwriting] };
});
