# AI teacher (laptop version)

The first full version of the talking teacher. It runs entirely in the browser:
- **Brain:** Claude, called directly through the Anthropic API using the user's own key.
- **Voice:** the browser's built-in voices (Microsoft Edge's "Natural" voices sound best), with an optional ElevenLabs voice.
- **Listening:** the browser's speech recognition, hands-free, with interruptions.
- **Whiteboard + subtitles:** Claude writes `<board>…</board>` blocks that the page draws, and the subtitles follow the speech.

Open `index.html` in Edge or Chrome, click **Settings**, and paste an Anthropic API key (it is saved only in that browser).

The ElevenLabs version in the parent folder (`../index.html`) sounds more human and handles interruptions better. Use this one for comparison or as a fallback.
