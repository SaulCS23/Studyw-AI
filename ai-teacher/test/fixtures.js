/* Simulated whiteboard instructions, written the way the planner would return them, for testing the renderer
 * without Claude or ElevenLabs. Test data only: the product never reads this file.
 * Each lesson is a list of turns; each turn is what the planner would send after one teacher reply.
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
        { op: "write", kind: "math", content: "y = x^2 - 4", id: "eq", color: "blue", cue: "y equals x squared" },
        { op: "graph", id: "g", x: 500, y: 90, w: 460, h: 400, xmin: -4, xmax: 4, ymin: -5, ymax: 10, xlabel: "x", ylabel: "y", grid: true, cue: "Let's draw it" },
        { op: "plot", id: "curve", graph: "g", fn: "x^2 - 4", color: "blue", label: "y = x² − 4" },
      ] },
      { teacher: "The lowest point is the vertex, right at zero, minus four. It crosses the x axis at plus and minus two.", ops: [
        { op: "point", id: "vertex", graph: "g", px: 0, py: -4, label: "vertex", color: "red", cue: "the vertex" },
        { op: "highlight", target: "eq", color: "amber" },
        { op: "write", kind: "math", content: "x = \\pm 2", id: "roots", color: "green", cue: "plus and minus two" },
      ] },
    ],
  };

  const biology = {
    subject: "biology",
    turns: [
      { teacher: "Plants use sunlight inside the chloroplast to turn carbon dioxide and water into sugar and oxygen.", ops: [
        { op: "write", kind: "text", size: "title", content: "Photosynthesis", id: "title" },
        { op: "shape", shape: "circle", x: 110, y: 190, r: 44, color: "amber", fill: true, id: "sun", cue: "sunlight" },
        { op: "write", kind: "text", size: "small", content: "sun", x: 88, y: 245, color: "amber", id: "sunlabel" },
        { op: "shape", shape: "arrow", points: [[165, 205], [330, 300]], color: "amber", id: "light" },
        { op: "shape", shape: "ellipse", x: 450, y: 350, rx: 140, ry: 85, color: "green", fill: true, id: "chloroplast", cue: "chloroplast" },
        { op: "write", kind: "text", size: "small", content: "chloroplast", x: 375, y: 335, color: "green", id: "chlorolabel" },
        { op: "shape", shape: "arrow", points: [[760, 260], [610, 330]], color: "blue", id: "co2arrow", cue: "carbon dioxide" },
        { op: "write", kind: "math", content: "CO_2 + H_2O", x: 700, y: 200, w: 260, color: "blue", id: "inputs" },
        { op: "shape", shape: "arrow", points: [[450, 440], [450, 540]], color: "violet", dashed: true, id: "out", cue: "sugar and oxygen" },
        { op: "write", kind: "math", content: "C_6H_{12}O_6 + O_2", x: 330, y: 545, w: 400, color: "violet", id: "outputs" },
      ] },
    ],
  };

  const history = {
    subject: "history",
    turns: [
      { teacher: "Let's put the story of Rome on a timeline: Augustus in 27 BC, the split of the empire in 395, and the fall of the West in 475.", ops: [
        { op: "write", kind: "text", size: "title", content: "Rome: a timeline", id: "title" },
        { op: "shape", shape: "arrow", points: [[60, 330], [940, 330]], id: "line", cue: "a timeline" },
        { op: "shape", shape: "circle", x: 180, y: 330, r: 12, color: "red", fill: true, id: "m1", cue: "Augustus" },
        { op: "write", kind: "text", size: "small", content: "27 BC: Augustus", x: 90, y: 270, id: "t1" },
        { op: "shape", shape: "circle", x: 500, y: 330, r: 12, color: "blue", fill: true, id: "m2", cue: "the split" },
        { op: "write", kind: "text", size: "small", content: "395: empire splits", x: 400, y: 380, id: "t2" },
        { op: "shape", shape: "circle", x: 820, y: 330, r: 12, color: "green", fill: true, id: "m3", cue: "the fall" },
        { op: "write", kind: "text", size: "small", content: "475: West falls", x: 720, y: 270, id: "t3" },
      ] },
      { teacher: "Sorry, I misspoke. The usual date for the fall is 476, not 475.", ops: [
        { op: "correct", target: "t3", with: { op: "write", kind: "text", size: "small", content: "476: West falls", color: "red", id: "t3" }, cue: "476" },
        { op: "highlight", target: "t3", color: "amber" },
      ] },
    ],
  };

  /** A later student question that changes the subject: clear, then draw something new. */
  const topicChange = {
    subject: "topic change after history",
    turns: [
      { teacher: "Switching to cells. Every living thing is made of them.", ops: [
        { op: "clear" },
        { op: "write", kind: "text", size: "title", content: "Cells", id: "title2" },
        { op: "shape", shape: "ellipse", x: 500, y: 330, rx: 200, ry: 130, color: "green", id: "cell", cue: "made of them" },
        { op: "shape", shape: "circle", x: 500, y: 330, r: 45, color: "violet", fill: true, id: "nucleus" },
        { op: "write", kind: "text", size: "small", content: "nucleus", x: 455, y: 400, id: "nlabel" },
      ] },
    ],
  };

  /** A showcase of everything the pen can do, for the slow-motion handwriting page. */
  const handwriting = {
    subject: "handwriting showcase",
    turns: [
      { teacher: "Watch the pen write words, numbers and equations.", ops: [
        { op: "write", kind: "text", size: "title", content: "Photosynthesis", id: "h1" },
        { op: "write", kind: "text", content: "Plants make sugar from light", id: "h2" },
        { op: "write", kind: "text", size: "small", content: "Água, coração, ñandú, Zürich", id: "h3" },
        { op: "write", kind: "math", content: "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}", id: "h4", color: "blue" },
        { op: "write", kind: "math", content: "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}", id: "h5" },
        { op: "write", kind: "math", content: "6CO_2 + 6H_2O \\rightarrow C_6H_{12}O_6 + 6O_2", id: "h6", color: "green" },
      ] },
      { teacher: "Now a graph: axes, numbers and curves are drawn too.", ops: [
        { op: "clear" },
        { op: "graph", id: "g", x: 120, y: 40, w: 760, h: 500, xmin: -6.3, xmax: 6.3, ymin: -3, ymax: 3, xlabel: "x", ylabel: "y", grid: true },
        { op: "plot", graph: "g", fn: "sin(x)", color: "blue", label: "sin x", id: "sine" },
        { op: "plot", graph: "g", fn: "x/3", color: "red", label: "x / 3", id: "line" },
        { op: "point", graph: "g", px: 0, py: 0, label: "origin", color: "green", id: "o" },
      ] },
      { teacher: "And a diagram: arrows, shapes and labels.", ops: [
        { op: "clear" },
        { op: "write", kind: "text", size: "title", content: "Water cycle", id: "wc" },
        { op: "shape", shape: "circle", x: 130, y: 150, r: 48, color: "amber", fill: true, id: "sun" },
        { op: "write", kind: "text", size: "small", content: "sun", x: 106, y: 210, color: "amber", id: "sunl" },
        { op: "shape", shape: "curve", points: [[250, 420], [400, 380], [560, 400], [760, 360]], color: "blue", id: "sea" },
        { op: "write", kind: "text", size: "small", content: "sea", x: 470, y: 440, color: "blue", id: "seal" },
        { op: "shape", shape: "arrow", points: [[560, 380], [560, 200]], color: "violet", id: "up" },
        { op: "write", kind: "text", size: "small", content: "evaporation", x: 580, y: 280, color: "violet", id: "upl" },
        { op: "shape", shape: "ellipse", x: 620, y: 150, rx: 110, ry: 50, color: "ink", id: "cloud" },
        { op: "write", kind: "text", size: "small", content: "cloud", x: 590, y: 130, id: "cloudl" },
        { op: "shape", shape: "arrow", points: [[760, 190], [790, 340]], color: "blue", dashed: true, id: "rain" },
      ] },
    ],
  };

  return { mathematics, biology, history, topicChange, handwriting, all: [mathematics, biology, history, topicChange, handwriting] };
});
