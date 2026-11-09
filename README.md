# Studyw-AI

An online school where students take live classes with an **AI teacher** now, and with human teachers later.

See [CLAUDE.md](CLAUDE.md) for the full project plan, team rules and tech stack.

## What's here today

`ai-teacher/index.html` is the talking AI teacher. It's a single web page that:

- listens to the student through the microphone and answers out loud
- can be interrupted mid-sentence, by talking over it or by pressing <kbd>Space</kbd>
- shows live subtitles and draws on a whiteboard while it talks
- uses Claude as its brain, and either the browser's built-in voices (free) or ElevenLabs (more human-sounding)

## Try it

1. Open `ai-teacher/index.html` in **Chrome** or **Microsoft Edge**. Other browsers can't do speech recognition.
2. Click **Settings** and paste your Anthropic API key.
3. Optional: pick **ElevenLabs** as the voice engine and paste your ElevenLabs API key.
4. Click the microphone and start talking. Headphones stop the teacher from hearing itself.

Keys are saved only in that browser on that computer. They are never stored in this repo.

> **Not ready for the public site yet:** the page calls Claude and ElevenLabs directly from the browser with the user's own keys. Before students use it online, those calls need to go through our server, which keeps the keys in `.env` (see `.env.example`).

## Contributing

Never commit to `main`. Make a branch (`yourname/short-description`), open a PR and get a teammate to review it. Never commit `.env` or any API key.
