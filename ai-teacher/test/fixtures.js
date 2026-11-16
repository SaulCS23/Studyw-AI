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
        { op: "group", id: "leaf", w: 500, h: 320, cue: "sunlight" },
        { op: "shape", group: "leaf", shape: "circle", x: 80, y: 80, r: 40, color: "amber", fill: true, id: "sun", cue: "sunlight" },
        { op: "write", group: "leaf", kind: "text", size: "small", content: "sun", x: 52, y: 130, color: "amber", id: "sunl", cue: "sunlight" },
        { op: "shape", group: "leaf", shape: "arrow", points: [[125, 100], [230, 170]], color: "amber", id: "light", cue: "sunlight" },
        { op: "shape", group: "leaf", shape: "ellipse", x: 300, y: 200, rx: 130, ry: 80, color: "green", fill: true, id: "chloroplast", cue: "chloroplast" },
        { op: "write", group: "leaf", kind: "text", size: "small", content: "chloroplast", x: 235, y: 185, color: "green", id: "chlorol", cue: "chloroplast" },
        { op: "shape", group: "leaf", shape: "arrow", points: [[470, 60], [400, 150]], color: "blue", id: "co2", cue: "carbon dioxide" },
        { op: "write", kind: "math", content: "CO_2 + H_2O", near: "leaf", side: "right", color: "blue", id: "inputs", cue: "carbon dioxide and water" },
        { op: "shape", group: "leaf", shape: "arrow", points: [[300, 284], [300, 316]], color: "violet", dashed: true, id: "out", cue: "sugar and oxygen" },
        { op: "write", kind: "math", content: "C_6H_{12}O_6 + O_2", near: "inputs", side: "below", color: "violet", id: "outputs", cue: "sugar and oxygen" },
      ] },
    ],
  };

  const history = {
    subject: "history",
    turns: [
      { teacher: "Let's put the story of Rome on a timeline: Augustus in 27 BC, the split of the empire in 395, and the fall of the West in 475.", ops: [
        { op: "new_page", title: "Rome", cue: "put the story of Rome" },
        { op: "write", kind: "text", size: "title", content: "Rome: a timeline", id: "htitle", cue: "put the story of Rome" },
        { op: "group", id: "tl", w: 880, h: 220, cue: "timeline" },
        { op: "shape", group: "tl", shape: "arrow", points: [[10, 110], [870, 110]], id: "line", cue: "timeline" },
        { op: "shape", group: "tl", shape: "circle", x: 140, y: 110, r: 12, color: "red", fill: true, id: "m1", cue: "Augustus" },
        { op: "write", group: "tl", kind: "text", size: "small", content: "27 BC: Augustus", x: 60, y: 50, id: "t1", cue: "Augustus" },
        { op: "shape", group: "tl", shape: "circle", x: 440, y: 110, r: 12, color: "blue", fill: true, id: "m2", cue: "the split" },
        { op: "write", group: "tl", kind: "text", size: "small", content: "395: empire splits", x: 330, y: 140, id: "t2", cue: "the split" },
        { op: "shape", group: "tl", shape: "circle", x: 740, y: 110, r: 12, color: "green", fill: true, id: "m3", cue: "the fall" },
        { op: "write", group: "tl", kind: "text", size: "small", content: "475: West falls", x: 640, y: 50, id: "t3", cue: "the fall" },
      ] },
      { teacher: "Sorry, I misspoke. The usual date for the fall is 476, not 475.", ops: [
        { op: "correct", target: "t3", with: { op: "write", kind: "text", size: "small", content: "476: West falls", color: "red", id: "t3" }, cue: "476" },
        { op: "highlight", target: "t3", color: "amber", cue: "not 475" },
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
        { op: "group", id: "cellg", w: 400, h: 300, cue: "made of them" },
        { op: "shape", group: "cellg", shape: "ellipse", x: 200, y: 150, rx: 180, ry: 120, color: "green", id: "cell", cue: "made of them" },
        { op: "shape", group: "cellg", shape: "circle", x: 200, y: 150, r: 45, color: "violet", fill: true, id: "nucleus", cue: "made of them" },
        { op: "write", group: "cellg", kind: "text", size: "small", content: "nucleus", x: 160, y: 205, id: "nlabel", cue: "made of them" },
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
        { op: "write", kind: "text", size: "title", content: "Water cycle", id: "wc", cue: "And a diagram" },
        { op: "group", id: "cycle", w: 800, h: 400, cue: "arrows" },
        { op: "shape", group: "cycle", shape: "circle", x: 100, y: 90, r: 48, color: "amber", fill: true, id: "sun", cue: "arrows" },
        { op: "write", group: "cycle", kind: "text", size: "small", content: "sun", x: 76, y: 150, color: "amber", id: "sunl", cue: "arrows" },
        { op: "shape", group: "cycle", shape: "curve", points: [[40, 350], [220, 320], [410, 340], [600, 310]], color: "blue", id: "sea", cue: "shapes" },
        { op: "write", group: "cycle", kind: "text", size: "small", content: "sea", x: 300, y: 360, color: "blue", id: "seal", cue: "shapes" },
        { op: "shape", group: "cycle", shape: "arrow", points: [[420, 320], [420, 130]], color: "violet", id: "up", cue: "labels" },
        { op: "write", group: "cycle", kind: "text", size: "small", content: "evaporation", x: 440, y: 220, color: "violet", id: "upl", cue: "labels" },
        { op: "shape", group: "cycle", shape: "ellipse", x: 560, y: 80, rx: 110, ry: 50, color: "ink", id: "cloud", cue: "labels" },
        { op: "write", group: "cycle", kind: "text", size: "small", content: "cloud", x: 520, y: 60, id: "cloudl", cue: "labels" },
        { op: "shape", group: "cycle", shape: "arrow", points: [[600, 140], [640, 260]], color: "blue", dashed: true, id: "rain", cue: "labels" },
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

  return { mathematics, biology, history, topicChange, revisit, sentences, handwriting, longLesson, all: [mathematics, biology, history, topicChange, handwriting] };
});
