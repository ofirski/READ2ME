# Read Markdown aloud with Piper (offline neural TTS)

A free, fully offline, high-quality neural text-to-speech setup for reading the
currently-open Markdown file aloud from inside Cursor / VS Code on macOS. Uses
[Piper](https://github.com/OHF-Voice/piper1-gpl) for synthesis and macOS
`afplay` for playback. No cloud, no API keys, no network needed after setup.

## What's in this folder

| Path | Purpose |
|------|---------|
| `.tts-venv/` | Dedicated Python virtualenv (kept separate from the project env). |
| `tts-requirements.txt` | Pinned, reproducible dependency list. |
| `tts-voices/` | Downloaded Piper voice models (`.onnx` + `.onnx.json`). |
| `read_md.py` | The reader: Markdown → speakable text → streamed synthesis + playback. |
| `tts_server.py` | Persistent synth server used by the Cursor extension (loads the voice once). |
| `tts-extension/` | Cursor/VS Code extension: read aloud **with sentence + word highlighting**. |
| `stop_tts.sh` | Kills any in-progress reading. |
| `.vscode/tasks.json` | "Read MD aloud" + "Stop reading" tasks. |
| `.vscode/keybindings.json` | Canonical copy of the hotkeys (see note below). |

## How I use it (the short version)

1. Open any `.md` file in Cursor and **click into the editor text** (not the
   rendered preview — see the `${file}` note below).
2. Press **Ctrl+Cmd+R** to start reading the current file. Audio begins within ~1s.
3. Press **Ctrl+Cmd+S** (or Ctrl+C in the task terminal) to stop.

From a terminal instead:

```bash
./.tts-venv/bin/python read_md.py path/to/file.md   # read
./stop_tts.sh                                        # stop
```

## Setup (already done, but here's how to reproduce it)

```bash
# 1. Dedicated virtualenv
python3 -m venv .tts-venv
./.tts-venv/bin/pip install -r tts-requirements.txt

# 2. Default English voice (en_US-lessac-high) into ./tts-voices/
mkdir -p tts-voices
base="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/high"
curl -L --fail -o tts-voices/en_US-lessac-high.onnx      "$base/en_US-lessac-high.onnx"
curl -L --fail -o tts-voices/en_US-lessac-high.onnx.json "$base/en_US-lessac-high.onnx.json"
```

The `.onnx` is ~109 MB; the `.onnx.json` is ~5 KB. Both must sit together in
`tts-voices/` with matching names (`NAME.onnx` + `NAME.onnx.json`).

Verified working on: macOS (Apple Silicon), Python 3.12.8, `piper-tts` 1.4.2.

## Hotkeys / Cursor integration

The tasks live in `.vscode/tasks.json` and run the venv's Python against
`${file}` with silent presentation. The keybindings are:

- **Ctrl+Cmd+R** → run task **"Read MD aloud"**
- **Ctrl+Cmd+S** → run task **"Stop reading"**

These use Control + Command (no Option/Alt key) and don't collide with any
default Cursor/VS Code or macOS shortcut.

> **One-time step for the hotkeys to work:** VS Code / Cursor do **not** read a
> workspace `.vscode/keybindings.json` automatically — keybindings are a *user*
> setting. Open the Command Palette (**Cmd+Shift+P** → *Preferences: Open
> Keyboard Shortcuts (JSON)*) and paste the two entries from
> `.vscode/keybindings.json` into your user `keybindings.json`. The tasks
> themselves (in `.vscode/tasks.json`) are picked up automatically and can also
> be run from **Cmd+Shift+P → Tasks: Run Task → Read MD aloud** without any
> keybinding setup.

> **"Variable ${file} can not be resolved" error:** `${file}` only resolves when
> the **active tab is a text editor showing a saved file**. It fails if focus is
> on the Explorer, the integrated terminal, or — most commonly — the **Markdown
> *preview*** (a webview, not a text editor). Click into the Markdown *source*
> text first, then run. The hotkey fires from wherever your editing cursor is,
> so it's the most reliable way to trigger it. (Untitled/unsaved buffers also
> can't resolve `${file}` — save the file first.)

## Word highlighting (the Cursor extension)

`tts-extension/` is a small Cursor/VS Code extension that reads the active editor
aloud **and highlights the current sentence + sweeps the current word** as Piper
speaks. It reuses the same `.tts-venv`, voice, and a persistent `tts_server.py`
(the model loads once, so sentences synthesize fast).

**It's already built and installed.** To (re)build and install it yourself:

```bash
cd tts-extension
npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository
/Applications/Cursor.app/Contents/Resources/app/bin/cursor \
  --install-extension katalog-tts-0.0.4.vsix
```

Then **reload Cursor** (Cmd+Shift+P → *Developer: Reload Window*) so it activates.

### Controls

Status-bar buttons appear at the bottom-right (click them), and there are hotkeys:

| Control | Button | Hotkey | Behavior |
|---------|--------|--------|----------|
| Play / Resume | ▶ Read / Resume | **Ctrl+Cmd+R** | Start from the sentence at your cursor (reads the selection if you have one), or resume if paused. |
| Pause | ⏸ Pause | **Ctrl+Cmd+P** | Stop audio but keep position (resume replays the current sentence). |
| Stop | ⏹ Stop | **Ctrl+Cmd+S** | Stop and reset to the start. |
| Speed | − *1.25x* + | — | Stepper: −/+ adjust by 0.25 (range 0.5x–3x); click the value to reset to 1x. Applies immediately to the current sentence. Persists across sessions. |
| Voice | 👤 *name* | — | Pick a voice (also: Cmd+Shift+P → *Katalog: Select voice*). |

### Voices

Five voices ship in `tts-voices/`: **en_US-lessac-high** (default), **en_US-ryan-high**,
**en_US-amy-medium**, **en_GB-alan-medium**, **en_GB-cori-high**. Click the voice
button (or run *Katalog: Select voice*) to switch — the choice persists, and if you
switch mid-read it restarts from the current sentence in the new voice. The picker
lists **any** `*.onnx` (with its `*.onnx.json`) found in `tts-voices/`, so adding a
voice is just dropping its two files there (see *Adding more voices* below).

### Markdown preview mode

Ctrl+Cmd+R also works when the **Markdown preview** is focused: it falls back to
the preview's source document and reads it. But the preview is a sandboxed
*webview*, so the highlight **cannot** be drawn inside it — highlighting only
renders in a real text editor. Practical guidance:

- **Source + preview side-by-side** (open preview with **Cmd+K V**): you get
  audio **and** the highlight in the source pane while you read either one.
- **Preview only:** you get **audio only** (a brief status-bar note explains why),
  with no highlight.

The hotkeys are wired to the extension commands `katalogTts.readWithHighlight` and
`katalogTts.stop` (in your user `keybindings.json`). Colors, rate, and voice paths
are configurable under **Settings → Katalog TTS** (`katalogTts.*`).

> **Word-timing caveat:** `en_US-lessac-high` does not expose true per-word
> alignments from Piper. So the extension anchors each **sentence** to its exact
> audio duration and *estimates* the per-word sweep within that sentence
> (proportional to word length). The sentence highlight is always accurate and
> finishes exactly when the sentence's audio ends; the word sweep is a smooth
> approximation, not phoneme-accurate karaoke.

This is separate from the terminal/`afplay` reader (`read_md.py`) above, which
remains available as an audio-only path.

## Changing the speech rate

Edit the constant near the top of `read_md.py`:

```python
SPEECH_RATE = 1.0   # 1.0 = natural; >1.0 = faster; <1.0 = slower
```

## Changing the default voice

Edit the `VOICE_MODEL` constant near the top of `read_md.py` to point at any
`.onnx` in `tts-voices/` (its `.onnx.json` must sit beside it).

## Adding more voices

Browse the official voice list: <https://huggingface.co/rhasspy/piper-voices>.
Each voice lives at `<lang>/<locale>/<name>/<quality>/` and ships a `.onnx`
plus `.onnx.json`. Download both into `tts-voices/`, e.g. a US English Ryan
medium voice:

```bash
base="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/medium"
curl -L --fail -o tts-voices/en_US-ryan-medium.onnx      "$base/en_US-ryan-medium.onnx"
curl -L --fail -o tts-voices/en_US-ryan-medium.onnx.json "$base/en_US-ryan-medium.onnx.json"
```

Then point `VOICE_MODEL` in `read_md.py` at the new file. You can preview voices
on the repo's voice samples page before downloading.

## Hebrew?

**Piper has no Hebrew voice.** The `rhasspy/piper-voices` repository (the
official model collection) ships ~45 languages — verified directly against the
repo on 2026-06-03 — and there is **no `he` / `he_IL`** entry. So Hebrew
Markdown can't be read with Piper today; nothing was invented or substituted. If
a Hebrew voice is added upstream later, download its `.onnx` + `.onnx.json` into
`tts-voices/` and switch `VOICE_MODEL` to it — no code changes needed.

(For Hebrew specifically, the macOS built-in `say -v Carmit` voice works
offline as a fallback, though it is not neural quality.)

## How it works

1. `read_md.py` renders the Markdown to HTML (`markdown`), then extracts plain
   text (`beautifulsoup4`). All markdown syntax is stripped (no "star star"),
   and fenced/indented **code blocks are replaced with a spoken "code block."
   marker** so source code is never read aloud. Inline `` `code` `` is kept as
   ordinary words.
2. The text is split into small chunks (~280 chars, on paragraph/sentence
   boundaries).
3. The Piper model is loaded **once**; a background thread synthesizes chunks to
   temp WAVs while the main thread plays the previous one with `afplay`, so audio
   starts within ~1 second instead of after the whole file. Temp WAVs are
   deleted right after they play.
4. **Ctrl+C** kills the in-flight `afplay` and exits cleanly (no stack trace).
   `stop_tts.sh` does the same from outside (used by the "Stop reading" task).
