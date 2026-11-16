# Proposal: keeping the voice and the whiteboard in the same teaching moment

**Status: for your approval. Nothing in this document has been applied to the ElevenLabs agent.**

## The question
Can the current design, an ElevenLabs conversational agent that talks plus a separate Claude "planner" that decides what to draw, reliably give the experience you described? Specifically:

- the teacher says what it is writing, when it writes it;
- it never says "look at the point I just drew" before that point exists;
- it can speak without drawing, point, or stop drawing to ask a question.

## What the current design can and cannot guarantee

| Wanted | Can the current design guarantee it? | Why |
|---|---|---|
| The board never runs **ahead** of the voice | **Yes** | Each step waits for its cue (exact with ElevenLabs alignment, estimated otherwise). |
| Drawing stops cleanly on an interruption, outdated steps are dropped | **Yes** | Tested end to end. |
| Sometimes speak only, sometimes write, point, or wait | **Yes, as far as the planner chooses well** | The planner now has explicit teaching moments, and the board enforces `wait`. How well Claude chooses is only verifiable with real lessons. |
| Speech that refers to a visual does not run ahead of it | **Only partly** | See below. |
| The teacher never refers to something that will not be drawn | **No** | The speaker does not know what the planner will draw. |

**The ceiling.** The agent's LLM writes its words without knowing what is on the board or what will be drawn. The planner only starts once the teacher's text exists, then needs about 1 to 3 seconds before its first step. So a reference in the first moments of a turn ("Look at this point...") cannot have its picture ready: the voice has already started and cannot be held back (you ruled out artificially delaying it).

**What this change does about it, within the current design.**
- Gives the planner the list of visual references found in the teacher's words and asks for a `ref` on the step that creates each one. A step with a `ref` is released early by however long it takes to draw, so it is finished when the words are spoken. This works when the reference comes a few seconds into the turn.
- **Measures the result.** The page logs, for every referenced step, how many ms before or after the spoken reference it was finished ("too late" is flagged), plus a per-turn line `Sync so far: ... spoken references checked N, late M (worst X ms)`. This is the real timing data to decide on the options below with, instead of guessing.
- Reports, but cannot fix, a reference with nothing behind it.

## Options

**A. Keep the design; rely on measurement.** No external change. Good enough if the logs show references are rarely late.

**B. Teach the agent how to talk to a whiteboard (a prompt change, low risk).** Edit the agent's system prompt so its habits fit the board: introduce an idea first, say what it is about to write, name things instead of pointing ("the vertex", not "this"), pause after a question. This directly removes most "look at what I just drew" moments at the source. It needs your approval because it changes the agent's behaviour. Proposed text is below.

**C. Make the whiteboard an agent tool (medium effort, needs an agent change).** Give the ElevenLabs agent a client tool (for example `board_step`) so the *same* LLM that speaks also emits the board steps, in the same order as its words. One brain decides both, so speech and drawing describe the same moment by construction. The page already routes the agent's `show_on_board` tool into the notebook; this would send structured steps instead. The separate planner would stay as a fallback for agents without the tool. Requires adding a tool and prompt text to the agent (needs approval) and a real test, because the order of a tool call relative to audio playback is not documented precisely (the call can run ahead of the audio by its buffer, so the cue gating we already have would still decide the drawing time).

**D. One shared coordinator replacing the conversational agent (large).** A single LLM streams a script of "moments" (speech plus board actions) and we speak it with ElevenLabs text-to-speech and listen with speech-to-text. This gives complete control but means rebuilding turn-taking, interruption and echo handling that the ElevenLabs agent does well today. Not recommended unless B and C cannot meet the goal.

## Recommendation
1. **Now:** run real lessons with the current build and read the `Sync so far` and `Reference` lines. That gives the facts.
2. **Then B** (prompt text below), and look again at the same numbers.
3. **Only if references are still often late, C.** D only as a last resort.

## Proposed agent prompt addition (option B)
To append to the system prompt in the Setup dialog. It does not remove anything the agent does today.

```
You teach with a whiteboard that writes by hand while you speak. Whatever you say is written or drawn for the student at the moment you say it.
- Introduce an idea out loud first, then say what you are about to put on the board ("let me write that", "let's draw it") and keep talking while it is written.
- Do not point at the board before it exists. Never start an answer with "look at this" or "the point I just drew". Introduce, then refer.
- Name what you mean ("the vertex", "the minus four", "the arrow from the sun") instead of "this" or "here".
- When you ask the student a question, stop after the question and wait. Never say or write the answer before they try.
- Keep each turn to a few short sentences with one idea; say the key equation or term clearly once.
- Many turns need no picture at all: explain, encourage, or ask. Draw only when it helps.
```

## What I need from you
- Approval to apply **B** to your agent (or to supply a copy of the agent's current prompt so I can merge it properly), and/or
- Approval to design **C** (an agent tool) once the measurements are in.

## Update: speech pace against handwriting (what can and cannot be done)

**What the page can do without touching the agent**
- It cannot pause, slow or hold live speech. The ElevenLabs SDK gives the page no such control; the voice speed is an agent setting, and nothing here changes it.
- It can start the pencil a little early (at most 0.8 s) for long writing, hurry the pencil slightly when it keeps falling behind, and write one idea per step with a cue on the words that introduce it.
- It now **measures the pencil**: real writing time against the planned time, and whether the voice had already reached the next idea before the pencil finished (in ms and words). Logged as `The voice had moved on to ...` and `Pencil so far: ...`.
- It feeds those measurements to the planner (`Pacing:` note), so a pencil that keeps falling behind gets fewer, shorter steps, and one that keeps up is left alone.
- It sends the agent **session-only context messages** (`sendContextualUpdate`): a teaching-style note when the lesson starts (introduce first, one step at a time, say it before writing it, ask and wait) and a board status after each turn. These never edit the saved agent, never interrupt speech, and only shape what the agent says next. Setup has a Teaching hints on/off switch.

**What still needs your approval (not done)**
1. Option B above (a permanent prompt addition on the agent), now that the session-only version exists to compare against.
2. A slower or varied voice speed in the agent settings. It would be a fixed change for every sentence, which is what you asked us not to do.
3. Smallest architecture that really coordinates speech and pencil: option C. The agent's own LLM emits board steps as a client tool in the same order as its words, and the page releases the next spoken step only after the pencil reports done (the agent would be told by tool result "written" before it continues). It still cannot stop audio already generated, so it needs a prompt that makes the agent speak in short steps and wait for each tool result. Needs an agent change, so it waits for your approval.
