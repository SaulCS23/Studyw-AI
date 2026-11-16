# AI teacher (ElevenLabs version)

A talking teacher that runs in the browser. You talk to it like a phone call: it answers in a natural ElevenLabs voice, you can interrupt it mid-sentence, subtitles follow what it says, and a whiteboard shows what it is explaining.

## How it works
- **Voice + conversation:** an ElevenLabs agent (Claude is the agent's LLM). The page connects with `@elevenlabs/client`, using the agent's ID.
- **Whiteboard:** after each teacher turn, the page sends the recent conversation to the Anthropic API, and Claude returns a small HTML/SVG sketch for the board. If the ElevenLabs agent has a client tool called `show_on_board` (one string parameter, `content`), the agent can also draw directly.
- **Subtitles:** the agent's and the student's words, as the transcript comes in.

## Animated whiteboard
The board writes and draws step by step while the teacher talks, for any subject, and adds to what is already there instead of replacing it.

- **How it works:** after each teacher turn a separate Claude call (`whiteboard-core.js`) returns a short list of drawing steps: write text or a LaTeX equation, draw axes and plot a function, draw shapes and arrows, highlight, erase or correct something. Steps are checked against a strict schema (bad ones are dropped one by one, text never becomes HTML) and drawn by `whiteboard.js` as SVG, with KaTeX for maths.
- **Interruptions:** when the student speaks or types, or the agent is cut off, the stroke in progress finishes, the rest of the queue is dropped and the board keeps what is drawn. A plan still being written is thrown away.
- **Sync with the voice (honest version):** timing is *estimated*. Steps are paced to the length of the teacher's turn, and the board usually starts a few seconds after the voice because Claude has to write the plan first. If the ElevenLabs agent sends character timing (`onAudioAlignmentPlayback`), steps with a `cue` wait until those words are spoken; if it doesn't, cues are ignored and pacing is time-based. Not verified against a live agent yet.
- **Fallback:** choose **Classic** under Setup > Whiteboard style to keep the original whole-sketch board. The classic board is also used automatically when the instructions can't be used or the planner call fails, and for the agent's own `show_on_board` tool.
- **Cost:** one extra Claude call per teacher turn (model set by `PLANNER_MODEL` in `whiteboard-core.js`), sending only the last 6 turns and a one-line-per-item summary of the board.

## Tests
No packages to install.
- `node --test ai-teacher/test/core.test.js` checks the schema, the safe maths parser, the planner request and the speech helpers.
- Open `ai-teacher/test/browser.html` to watch simulated lessons (maths, biology, history, a topic change) play through the real renderer. Add `?selftest` for the automatic browser checks.
- `node ai-teacher/test/integration.mjs` loads the real `index.html` in headless Chrome with a fake ElevenLabs SDK and a fake Claude API, and checks subtitles, progressive drawing, interruptions, follow-ups, topic changes and the fallbacks (set `CHROME_PATH` if Chrome is not in the default Mac location).
The simulated lessons live only in `ai-teacher/test/fixtures.js`; the product reads no hardcoded lessons.

## Run it
1. Open `index.html` in Microsoft Edge or Chrome.
2. Click **Setup**, paste the ElevenLabs **Agent ID** and an **Anthropic API key**, and save. Both are stored only in that browser (localStorage). Nothing secret is in this file.
3. Press **Start lesson** and allow the microphone.

The Setup window also has the teacher's system prompt and first message, ready to copy into the ElevenLabs agent.

## Before students use it
This is a prototype for one person on their own laptop. For the public site:
- The Anthropic key must move to the server (the browser should never hold it).
- The ElevenLabs agent should be private, with the server handing out a short-lived signed URL per lesson, so nobody can use our minutes from outside the site.
