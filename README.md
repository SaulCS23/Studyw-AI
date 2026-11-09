# Studyw-AI

An online school where students take live classes with an **AI teacher** now, and with human teachers later.

See [CLAUDE.md](CLAUDE.md) for the full project plan, team rules and tech stack.

## What's here today

The talking AI teacher comes in two versions, each a single web page. Both listen to the student, answer out loud, can be interrupted mid-sentence, show live subtitles and draw on a whiteboard while they talk.

| File | How it works |
|---|---|
| `ai-teacher/index.html` | **Laptop version.** Claude is the brain. The voice is the browser's built-in voices (free) or ElevenLabs text-to-speech. Speech recognition is the browser's own. |
| `ai-teacher/live.html` | **ElevenLabs Live version (newer, more human).** An ElevenLabs voice agent handles listening, talking and interruptions like a phone call, with Claude as the agent's brain. A separate Claude call sketches the whiteboard. |

## Try it

**Laptop version** (`index.html`)
1. Open it in **Chrome** or **Microsoft Edge**. Other browsers can't do speech recognition.
2. Click **Settings** and paste your Anthropic API key.
3. Optional: pick **ElevenLabs** as the voice engine and paste your ElevenLabs API key.
4. Click the microphone and start talking. Headphones stop the teacher from hearing itself.

**Live version** (`live.html`)
1. Open it in Chrome or Edge. The **Setup** window walks you through creating an ElevenLabs agent (the free plan has about 15 minutes of talking a month).
2. Paste the agent's **Agent ID** and, for the whiteboard, your Anthropic API key.
3. Press **Start lesson** and talk.

Keys and the Agent ID are saved only in that browser on that computer. They are never stored in this repo.

> **Not ready for the public site yet:** the page calls Claude and ElevenLabs directly from the browser with the user's own keys. Before students use it online, those calls need to go through our server, which keeps the keys in `.env` (see `.env.example`).

## Contributing

Never commit to `main`. Make a branch (`yourname/short-description`), open a PR and get a teammate to review it. Never commit `.env` or any API key.
