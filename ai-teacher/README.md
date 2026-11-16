# AI teacher (ElevenLabs version)

A talking teacher that runs in the browser. You talk to it like a phone call: it answers in a natural ElevenLabs voice, you can interrupt it mid-sentence, subtitles follow what it says, and a whiteboard shows what it is explaining.

## How it works
- **Voice + conversation:** an ElevenLabs agent (Claude is the agent's LLM). The page connects with `@elevenlabs/client`, using the agent's ID.
- **Whiteboard:** after each teacher turn, the page sends the recent conversation to the Anthropic API, and Claude returns a small HTML/SVG sketch for the board. If the ElevenLabs agent has a client tool called `show_on_board` (one string parameter, `content`), the agent can also draw directly.
- **Subtitles:** the agent's and the student's words, as the transcript comes in.

## Teaching notebook (the animated whiteboard)
The board is a multi-page notebook the teacher writes in by hand while talking, for any subject.

- **Real handwriting.** Letters, numbers, equations, graph labels, axes, curves, arrows and shapes are drawn as pen strokes with a visible pencil (`whiteboard-hand.js`, `whiteboard-font.js`). No external libraries.
- **No overlap, ever.** Claude never chooses positions. Every element is measured *before* it is drawn and placed in free space by a layout engine (`whiteboard-layout.js`): text and equations stack down a column, a graph or diagram may sit beside the previous element, an explanation can go beside its diagram (`near`/`side`), the lines of one calculation stay together (`calc`), and a title owns its whole row. Diagram parts are drawn inside a reserved frame (`group`) in local coordinates. Nothing is shrunk to fit: if a page has no room, a **new page is started before drawing**. Geometric tests (thousands of random placements, plus checks of real rendered ink) prove nothing overlaps or leaves the page.
- **Pages.** The notebook keeps every page; changing topic starts a new page and never erases an old one. Controls under the board: **Previous**, **Next**, numbered page buttons (the red dot marks where the teacher is writing, a ring marks pages with writing you have not seen), "Page 2 of 5" and **Return to live page**. The student can look at any page; the teacher keeps writing on the live page, and the student is never moved unless they are following the teacher.
- **The teacher can navigate.** Steps `new_page`, `go_to_page` (an id, `previous`, `next`, `first`, `latest`) and `point_to` (go to an earlier equation or diagram, circle it, and come back to the page being written). Pages (`p1`, `p2`, ...) and elements have stable ids, and the planner is shown a summary of the whole notebook, so it can refer to earlier content accurately.
- **Writing what is being said, when it is said.** A separate Claude call streams small steps, each tied to a **cue**: the words in the teacher's turn where that idea begins. A step is drawn when the teacher reaches its cue and never before, so future ideas are not written early and stale steps are dropped on interruption.
- **Fallback, and how to see it:** Setup > Whiteboard style > Classic gives the original whole-sketch board, which is also used automatically if the scripts do not load, Claude's steps cannot be used, or the planner call fails. Fallbacks, timing and every decision are shown in a **Board:** badge, the status line and the console (`[Whiteboard]` lines, also in `window.__whiteboardLog`).
- **The agent's `show_on_board` tool** is routed into the notebook instead of painting finished HTML.
- **Cost and speed:** one Claude call per teacher turn (two if the agent streams its text, see below), at most 6 short steps (12 for a diagram), and an interrupted request is cancelled. Under Setup > Whiteboard planner choose **Smarter** (Sonnet 5.5) or **Faster** (Haiku 5.5, starts writing sooner).

### How the writing is synchronised with the voice (and how reliable that is)
The board uses the best timing information it has, and says which one in the console (`Step write ... released: aligned | estimate | ...`):

1. **ElevenLabs audio alignment (exact, if available).** With a WebSocket connection, ElevenLabs sends the text being played, optionally with each character's start time (`onAudioAlignmentPlayback`). A step is released when its words are played, and, if per-character times are present, at the time its first word starts. Alignment is **not sent over WebRTC**, which this page uses only as a fallback when WebSocket fails.
2. **An estimate (always available).** The cue's position in the teacher's text at a typical speaking pace (about 2.6 words a second), counted from when the voice starts. It can drift by roughly a second over a long turn.
3. **Never stuck.** A step with no cue, a cue that is not in the teacher's words (reported as a warning), the end of the speech, or a voice that never reports starting all release it.

Starting earlier: if the agent's **client events** include `agent_chat_response_part` (an optional setting in the ElevenLabs agent; not changed by this project), the page starts the first plan from the first complete sentence while the reply is still being written, then plans only the rest. Without it, planning starts when the full reply text arrives.

What is **not** verified: all of the above has been tested with simulated ElevenLabs events and a fake Claude. Whether your agent sends alignment, the exact meaning of its per-character times, whether it streams text parts for voice, and how well Claude's cues match the spoken words, can only be confirmed with a real session.

## Tests
No packages to install.
- `node --test ai-teacher/test/core.test.js ai-teacher/test/hand.test.js ai-teacher/test/layout.test.js`: the schema and safe maths parser, the streamed planner, the speech clock (late, missing and out-of-order timing), the handwriting engine, and the layout engine (a geometric fuzz test: no overlap, always inside the page, pages added when needed).
- **Slow-motion handwriting test:** open `ai-teacher/test/handwriting.html` in Chrome, pick a speed (down to 0.15x) and watch the pen; "Colour each stroke" shows the stroke order. Add `?selftest` for its automatic checks.
- `ai-teacher/test/browser.html?selftest`: plays simulated lessons through the real renderer and measures the actual ink (maths, biology, history, long lessons with automatic pages, topic changes, student navigation, revisiting and pointing, interruptions, cues on time, early, late, missing and out of order, safety).
- `node ai-teacher/test/integration.mjs`: loads the real `index.html` in headless Chrome with a fake ElevenLabs SDK and a fake streaming Claude API and checks the whole flow, including the notebook controls, the `show_on_board` tool, early planning from streamed text, alignment with per-character times, every fallback, and Classic mode. Set `CHROME_PATH` if Chrome is not in the default Mac location and `SHOT_DIR=/some/folder` to save screenshots.
The simulated lessons live only in `ai-teacher/test/fixtures.js`. None of these tests call the real ElevenLabs or Anthropic services.

## Run it
1. Open `index.html` in Microsoft Edge or Chrome.
2. Click **Setup**, paste the ElevenLabs **Agent ID** and an **Anthropic API key**, and save. Both are stored only in that browser (localStorage). Nothing secret is in this file.
3. Press **Start lesson** and allow the microphone.

The Setup window also has the teacher's system prompt and first message, ready to copy into the ElevenLabs agent.

## Before students use it
This is a prototype for one person on their own laptop. For the public site:
- The Anthropic key must move to the server (the browser should never hold it).
- The ElevenLabs agent should be private, with the server handing out a short-lived signed URL per lesson, so nobody can use our minutes from outside the site.
