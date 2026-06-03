# READ2ME — read your editor aloud (offline neural TTS)

[![VS Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/ofirski.read2me?label=Marketplace&color=6c4ff6)](https://marketplace.visualstudio.com/items?itemName=ofirski.read2me)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/ofirski.read2me?color=6c4ff6)](https://marketplace.visualstudio.com/items?itemName=ofirski.read2me)
[![License: MIT](https://img.shields.io/badge/License-MIT-ff385c.svg)](LICENSE)

Reads the active editor aloud using offline [Piper](https://github.com/OHF-Voice/piper1-gpl)
neural text-to-speech, highlighting the current **sentence** and sweeping the current
**word** as it speaks. 100% offline — no cloud, no API keys, nothing leaves your machine.

> ### ⚠️ Requires a one-time local voice backend
> This extension is a front-end for a local Piper TTS backend (a Python virtualenv,
> `tts_server.py`, and downloaded voice models). **It will not speak until that backend
> is set up.** Follow the two-part install below — see also `README-TTS.md` in the
> [project repo](https://github.com/ofirski/READ2ME).

## Install

**1. Install the extension** — from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=ofirski.read2me),
the Extensions view (search "READ2ME"), or the CLI:

```bash
code --install-extension ofirski.read2me
```

**2. Set up the offline voice backend** (one time):

```bash
git clone https://github.com/ofirski/READ2ME.git
cd READ2ME

# Python env + dependencies
python3 -m venv .tts-venv
./.tts-venv/bin/pip install -r tts-requirements.txt

# Download the neural voices (~109 MB each)
./fetch-voices.sh
```

Then point the extension at these files via **Settings → READ2ME** (`read2me.*`).
Absolute paths work, so reading aloud works from any workspace once configured.

Verified on macOS (Apple Silicon), Python 3.12, `piper-tts` 1.4.2. Playback uses
the macOS `afplay` command.

## Controls

Status-bar buttons (bottom-right) plus hotkeys:

- **▶ Read / Resume** — `Ctrl+Cmd+R` — play from the sentence at the cursor (or the
  selection), or resume if paused.
- **⏸ Pause** — `Ctrl+Cmd+P` — stop audio, keep position (resume replays the current
  sentence).
- **⏹ Stop** — `Ctrl+Cmd+S` — stop and reset to the start.
- **− *value* +** — speed stepper: −/+ adjust by 0.25 (0.5x–3x), click the value to
  reset to 1x. Applies immediately to the current sentence; persists across sessions.
- **👤 *voice*** — pick a voice (also: *READ2ME: Select voice*).

Works from the Markdown preview too (reads the source; highlight only shows if the
source editor is visible side-by-side — the preview webview can't be decorated).

## Voices

The picker lists every `*.onnx` (with a matching `*.onnx.json`) in the voices folder
(`read2me.voicesDir`, default `tts-voices/`). The selection persists; switching
mid-read restarts from the current sentence in the new voice. Five English voices
ship in the repo; add more by dropping the two Piper files into the voices folder.

## Settings (`read2me.*`)

| Setting | Default | Meaning |
|---------|---------|---------|
| `pythonPath` | `.tts-venv/bin/python` | Interpreter (relative to workspace or absolute). |
| `serverScript` | `tts_server.py` | The persistent synth server. |
| `voicesDir` | `tts-voices` | Folder scanned for `.onnx` voices. |
| `model` / `config` | `tts-voices/en_US-lessac-high.onnx[.json]` | Default voice files. |
| `rate` | `1.0` | Base speech rate (>1 faster, <1 slower). |
| `wordHighlightColor` / `sentenceHighlightColor` | `#ff385c` tints | Highlight colors. |

## Note on word timing

`en_US-lessac-high` does not expose true per-word alignments, so **sentence**
boundaries are exact (anchored to each sentence's real audio duration) while the
**word** sweep within a sentence is estimated proportionally to word length. The
highlight always stays on the correct sentence and finishes exactly when the
sentence's audio ends.

## License

[MIT](LICENSE) © Ofir Kerker
