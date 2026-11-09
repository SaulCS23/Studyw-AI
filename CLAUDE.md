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
- Frontend: plain HTML, CSS and JavaScript, one self-contained file per AI teacher version, with no framework and no build step. `live.html` loads `@elevenlabs/client` from the jsDelivr CDN. The student website stack is _TBD_.
- Backend: _TBD_. None yet; the AI teacher calls the APIs straight from the browser.
- Database: _TBD_
- Auth (secure logins + roles): _TBD_
- AI teacher brain (LLM): Claude. In `index.html` it's called via the Anthropic Messages API, streamed, and you pick Opus 5.5, Sonnet 5.5 or Haiku 5.5 in Settings. In `live.html` it's the Claude model chosen in the ElevenLabs agent, and a separate Claude Opus 5.5 call draws the whiteboard.
- Voice: `live.html` uses an ElevenLabs Agent (conversational AI over a live connection, which handles interruptions and echo). `index.html` uses ElevenLabs text-to-speech (`eleven_flash_v2_5`) or the browser's built-in Web Speech API voices (free; "Natural"/"Online" voices in Edge sound best).
- Speech-to-text (for interruptions): the ElevenLabs Agent in `live.html`; the browser's Web Speech API (`SpeechRecognition`, Chrome/Edge only) in `index.html`.
- Video for human teachers: Jitsi Meet
- Hosting: _TBD_

> ⚠️ For now, API keys are typed into the AI teacher's Settings and saved in the browser's localStorage. That's fine for testing on a laptop but **not for the public site**: keys must move to a server that reads them from `.env`.

## Project structure
```
/              → root config, this file, README, .gitignore, .env.example
/ai-teacher/   → the talking AI teacher, one self-contained page per version
  index.html   → laptop version (Claude + browser or ElevenLabs text-to-speech)
  live.html    → ElevenLabs Live version (ElevenLabs voice agent + Claude whiteboard)
```

## Commands
- Install: nothing to install yet.
- Run locally: open `ai-teacher/index.html` or `ai-teacher/live.html` in Chrome or Edge, then add your keys in Settings / Setup.
- Test: no automated tests yet.
- Lint / format: no linter set up yet.

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
