# AI teacher (ElevenLabs version)

A talking teacher that runs in the browser. You talk to it like a phone call: it answers in a natural ElevenLabs voice, you can interrupt it mid-sentence, subtitles follow what it says, and a whiteboard shows what it is explaining.

## How it works
- **Voice + conversation:** an ElevenLabs agent (Claude is the agent's LLM). The page connects with `@elevenlabs/client`, using the agent's ID.
- **Whiteboard:** after each teacher turn, the page sends the recent conversation to the Anthropic API, and Claude returns a small HTML/SVG sketch for the board. If the ElevenLabs agent has a client tool called `show_on_board` (one string parameter, `content`), the agent can also draw directly.
- **Subtitles:** the agent's and the student's words, as the transcript comes in.

## Animated whiteboard
The board writes and draws by hand while the teacher talks, for any subject, and adds to what is already there instead of replacing it.

- **Real handwriting, not a reveal.** Letters, numbers, equations, graph labels, axes, curves, arrows and shapes are all drawn as pen strokes. A pencil tip travels along each stroke, goes pale while it lifts and moves to the next one, and a half-written letter really is half drawn. Text uses a single-stroke handwriting font (`whiteboard-font.js`, Hershey data, see its licence note); `whiteboard-hand.js` lays out words (with accents: Portuguese, Spanish, French, German) and a small maths typesetter (fractions, roots, powers, indices, sums, integrals, brackets, vectors, Greek letters, common symbols) as strokes. No external libraries are needed.
- **How a turn is drawn:** after each teacher message a separate Claude call (`whiteboard-core.js`) streams drawing steps, one JSON object per line. Each step is checked against a strict schema (bad ones are dropped one by one, nothing from the AI is ever inserted as HTML) and handed to the pen the moment it arrives, so writing starts after Claude's *first* line, not its last. Only the last 6 turns and a one-line-per-item board summary are sent, and an interrupted request is cancelled so it stops costing tokens.
- **The agent's `show_on_board` tool:** if your ElevenLabs agent has this tool, its finished HTML is *not* painted (that would show a completed board at once). What it asks for is passed to the animated board, which draws it by hand. If that fails, the classic board shows the agent's HTML.
- **Interruptions:** when the student speaks or types, or the agent is cut off, the pen finishes the stroke it is on, the rest of the queue is dropped, the board keeps what is drawn (an unfinished line is marked "(unfinished)" for the planner) and a plan still being written is cancelled.
- **Sync with the voice (honest version):** pacing is *estimated*. While the teacher is still talking the hand slows down or speeds up (between 0.65x and 1.4x of a normal writing speed) so it finishes about when the speech does; it never appears all at once. If the ElevenLabs agent sends character timing (`onAudioAlignmentPlayback`), steps with a `cue` wait until those words are spoken; if it doesn't, cues are ignored. The board still starts a moment after the voice because Claude has to write its first step first. Not verified against a live agent yet.
- **Fallback, and how to see it:** choose **Classic** under Setup > Whiteboard style for the original whole-sketch board. The classic board is also used automatically when the drawing scripts do not load, Claude's steps cannot be used, or the planner call fails. Every one of these is announced: a red **Board:** badge at the top of the page, a line in the status area, and a `[Whiteboard]` line in the browser console (Cmd+Option+J). The console keeps the full story (turn received, planning, first step after N ms, steps drawn, rejected steps, tool calls); the same log is in `window.__whiteboardLog`.
- **Cost:** one extra Claude call per teacher turn (model set by `PLANNER_MODEL` in `whiteboard-core.js`), capped at 1200 output tokens and 8 steps of short, key-word writing.

## Tests
No packages to install.
- `node --test ai-teacher/test/core.test.js ai-teacher/test/hand.test.js` checks the schema, the safe maths parser, the streamed planner (including that steps arrive while the stream is still open and that cancelling stops it), the handwriting engine, the typesetter and the pen timeline.
- **Slow-motion handwriting test:** open `ai-teacher/test/handwriting.html` in Chrome. Pick a speed (down to 0.15x), press a button, and watch the pen write. "Colour each stroke" shows the stroke order; the panel under the board counts strokes and shows whether the pen is down or lifted. Add `?selftest` to run its automatic checks.
- `ai-teacher/test/browser.html` plays simulated lessons (maths, biology, history, a topic change, a handwriting showcase) through the real renderer; add `?selftest` for its automatic checks (queue, interruption, voice cues, safety, layout).
- `node ai-teacher/test/integration.mjs` loads the real `index.html` in headless Chrome with a fake ElevenLabs SDK and a fake streaming Claude API. It checks subtitles, handwriting on the real page, interruptions, follow-ups, topic change, the `show_on_board` tool in both modes, every fallback (badge, status line, console) and Classic mode. Set `CHROME_PATH` if Chrome is not in the default Mac location, and `SHOT_DIR=/some/folder` to save screenshots.
The simulated lessons live only in `ai-teacher/test/fixtures.js`; the product reads no hardcoded lessons. None of these tests call the real ElevenLabs or Anthropic services.

## Run it
1. Open `index.html` in Microsoft Edge or Chrome.
2. Click **Setup**, paste the ElevenLabs **Agent ID** and an **Anthropic API key**, and save. Both are stored only in that browser (localStorage). Nothing secret is in this file.
3. Press **Start lesson** and allow the microphone.

The Setup window also has the teacher's system prompt and first message, ready to copy into the ElevenLabs agent.

## Before students use it
This is a prototype for one person on their own laptop. For the public site:
- The Anthropic key must move to the server (the browser should never hold it).
- The ElevenLabs agent should be private, with the server handing out a short-lived signed URL per lesson, so nobody can use our minutes from outside the site.
