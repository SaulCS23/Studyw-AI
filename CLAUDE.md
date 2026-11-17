# Studyw-AI

> Shared context for every Claude session on this project (Claude Code, Cowork, etc.).
> Keep this file short and current. If you change how the project works, update this file in the same PR.

## What we're building
Studyw-AI is an online school. Students take live classes with an **AI teacher** now, and with **human teachers** later.

### Core pieces
1. **AI teacher**: a talking tutor that speaks in a natural voice, can be interrupted mid-sentence, shows live subtitles and explains with a whiteboard.
   - Status: a working laptop version exists. An **ElevenLabs** version with a more human voice is built and ready to test.
2. **Student website**: should look professional and friendly. Students can:
   - see their schedule by **day / week / month**
   - browse all classes
   - book a time slot and pick a teacher
   - The AI teacher is **always available**. Admins add human teachers.
3. **Accounts and roles**: everyone signs in with one of three roles.
   - **Admin**: Saul is the main admin and invites other admins and teachers.
   - **Teacher**: teaches their classes.
   - **Student**: can only see and use their own classes.
4. **Meetings (free)**: a class opens from the schedule or from a "Join meeting" button.
   - AI class → opens the talking AI teacher.
   - Human-teacher class → opens a **Jitsi Meet** room (free; no paid video service).

### Current priority
**Put the site online with real, secure logins so students can use it.**

### Product rules
- Keep it free to run where possible (e.g. Jitsi instead of paid video APIs).
- Enforce roles on the **server**, never only in the UI. A student must not reach another student's data, teacher pages or admin pages.
- Admins invite teachers and admins. Nobody can make themselves a teacher or admin.
- The AI teacher must keep feeling natural: low latency, interruptible, subtitles in sync with the voice.

## Team
| Person | GitHub | Owns |
|---|---|---|
| Saul | @SaulCS23 | _TBD_ |
| Daniel | @daniel-abadi-ap2324 | _TBD_ |
| Joseph | @Joseph-Eskenazi-AP2324 | _TBD_ |
| _TBD_ | _TBD_ | _TBD_ |

## Tech stack
<!-- TODO: fill in once decided -->
- Frontend:
- Backend:
- Database:
- Auth (secure logins + roles):
- AI teacher brain (LLM):
- Voice: ElevenLabs (new version), plus the existing laptop voice setup: _which?_
- Speech-to-text (for interruptions):
- Video for human teachers: Jitsi Meet
- Hosting:

## Project structure
<!-- TODO: update as folders are created -->
```
/            → root config, this file, README
/ai-teacher/          → talking AI teacher, ElevenLabs version (open index.html; see its README)
/ai-teacher/laptop/   → earlier version: Anthropic API + browser voices
/ai-teacher/whiteboard-font.js → single-stroke handwriting font data (Hershey, licence note inside)
/ai-teacher/whiteboard-hand.js → handwriting engine: text and maths as pen strokes, pen timeline
/ai-teacher/whiteboard-layout.js → page layout engine: places every element in free space, never overlaps, tells the board when to start a new page
/ai-teacher/whiteboard-diagram.js → diagram layout engine: nodes and links to padded shapes, routed connectors, labels beside lines; also graph label placement
/ai-teacher/PROPOSAL-teaching-coordinator.md → options for tighter voice/whiteboard coordination (needs approval)
/ai-teacher/whiteboard-core.js → animated whiteboard: schema check, safe maths parser, streaming Claude planner, speech clock (ties steps to the teacher's words)
/ai-teacher/whiteboard.js      → animated whiteboard: multi-page notebook renderer, pencil, drawing queue, interruption, page navigation
/ai-teacher/test/     → whiteboard tests and simulated lessons (not used by the product)
/student-website/     → clickable prototype of the school site (browser-only data, not secure yet)
```

## Commands
<!-- TODO: fill in once the project is scaffolded -->
- Install: ``
- Run locally: ``
- Test: `node --test ai-teacher/test/core.test.js ai-teacher/test/hand.test.js ai-teacher/test/layout.test.js ai-teacher/test/diagram.test.js` and `node ai-teacher/test/integration.mjs` (needs Chrome); in a browser open `ai-teacher/test/handwriting.html` (slow-motion pen test) and add `?selftest` to it or to `ai-teacher/test/browser.html`
- Lint / format: ``

## How we work (rules for humans AND Claude)
- **Never commit directly to `main`.** Create a branch: `yourname/short-description` (e.g. `saul/login-page`).
- **One feature per branch, one PR per feature.** Keep PRs small so they're easy to review.
- **Pull `main` before starting work** and before opening a PR, to avoid conflicts.
- **At least one other teammate reviews each PR** before it's merged.
- Write clear commit messages: what changed and why.
- Don't edit files in an area someone else owns without telling them first (see Team table).

## Rules for Claude
- Read this file and the README before making changes.
- Stay within the scope of the task you were given; don't refactor unrelated code.
- Ask before adding new dependencies, changing the tech stack, or changing the folder structure.
- Run the tests and linter before saying a task is done.
- **Never commit secrets.** API keys go in `.env` (which is gitignored). Update `.env.example` with the variable name, never the value.
- **This repo is public** — assume anything committed can be seen by anyone.
- If something in this file is out of date or wrong, say so and suggest the fix.

## Code style
<!-- TODO: adjust to the chosen language -->
- Prefer simple, readable code over clever code.
- Use descriptive names; avoid abbreviations.
- Comment the *why*, not the *what*.

## Decisions log
<!-- Add one line per important decision so everyone (and every Claude) knows why things are the way they are. -->
- 2026-11-09: Created repo; using branches + PRs, CLAUDE.md as shared context.
- 2026-11-09: Human-teacher classes use Jitsi Meet (free). AI teacher voice moving to ElevenLabs.
- 2026-11-09: Next milestone: deploy the site with real, secure, role-based logins.
- 2026-11-09: AI teacher prototype added in /ai-teacher: ElevenLabs agent (Claude as LLM) for voice and interruptions, Claude via the Anthropic API for the whiteboard. Keys are entered in the browser, never committed.
- 2026-11-10: Student website prototype added in /student-website. Data and roles live in the browser only, so it is a design reference until the real backend exists.
- 2026-11-16: Animated whiteboard added to the ElevenLabs teacher: a separate Claude call streams schema-checked drawing steps that are drawn by hand (pen strokes from a single-stroke font plus our own maths typesetter, pencil tip visible), no external libraries. The agent's `show_on_board` tool is routed into it instead of painting finished HTML. The classic whole-sketch board stays as the fallback and every fallback is shown (badge, status line, console). Voice sync is time-estimated unless the agent sends character timing.
- 2026-11-16: The whiteboard became a multi-page teaching notebook. A layout engine places every element (Claude no longer gives positions), starts a new page before drawing when one is full, and keeps all pages; the student can browse pages while the teacher keeps writing on the live page; the teacher can create pages, go to earlier pages and point at earlier content. Steps are tied to the teacher's words (cues) and drawn when those words are reached: exactly if ElevenLabs sends audio alignment (WebSocket only), estimated otherwise.
- 2026-11-16: The planner now chooses a teaching moment per turn (speak only, write, draw, point, wait), diagrams are described semantically (nodes, links, containers) and laid out by the board (no coordinates from Claude), and spoken references to visuals are scheduled so the picture is ready and the lateness is measured. Whether the existing ElevenLabs agent can fully guarantee voice/board sync is documented in `ai-teacher/PROPOSAL-teaching-coordinator.md`; no agent setting was changed.
- 2026-11-16: Pacing: the whiteboard measures the pencil against the voice and feeds it back to the planner; session-only teaching hints are sent to the agent with `sendContextualUpdate` (switchable in Setup; the agent's saved settings are untouched and live speech cannot be slowed or paused from the page). Larger coordination changes are in `ai-teacher/PROPOSAL-teaching-coordinator.md`, awaiting approval.
- 2026-11-16: Whiteboard writing changed from the cursive Hershey face to the printed single-stroke Hershey "futural" face (clear teacher-style printing), with a little more letter spacing and larger sizes everywhere (text 34 to 39, title 46 to 52, small 28 to 32, diagram labels 28 to 32, graph labels bigger). The pen animation is unchanged. Diagrams are now suggested at 5 nodes or fewer because larger writing is never shrunk.

