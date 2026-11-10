# AI teacher (ElevenLabs version)

A talking teacher that runs in the browser. You talk to it like a phone call: it answers in a natural ElevenLabs voice, you can interrupt it mid-sentence, subtitles follow what it says, and a whiteboard shows what it is explaining.

## How it works
- **Voice + conversation:** an ElevenLabs agent (Claude is the agent's LLM). The page connects with `@elevenlabs/client`, using the agent's ID.
- **Whiteboard:** after each teacher turn, the page sends the recent conversation to the Anthropic API, and Claude returns a small HTML/SVG sketch for the board. If the ElevenLabs agent has a client tool called `show_on_board` (one string parameter, `content`), the agent can also draw directly.
- **Subtitles:** the agent's and the student's words, as the transcript comes in.

## Run it
1. Open `index.html` in Microsoft Edge or Chrome.
2. Click **Setup**, paste the ElevenLabs **Agent ID** and an **Anthropic API key**, and save. Both are stored only in that browser (localStorage). Nothing secret is in this file.
3. Press **Start lesson** and allow the microphone.

The Setup window also has the teacher's system prompt and first message, ready to copy into the ElevenLabs agent.

## Before students use it
This is a prototype for one person on their own laptop. For the public site:
- The Anthropic key must move to the server (the browser should never hold it).
- The ElevenLabs agent should be private, with the server handing out a short-lived signed URL per lesson, so nobody can use our minutes from outside the site.
