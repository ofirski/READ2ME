# Katalog Read Aloud (Piper TTS)

Reads the active editor aloud using offline [Piper](https://github.com/OHF-Voice/piper1-gpl)
neural TTS, highlighting the current **sentence** and sweeping the current **word**
as it speaks. Pairs with the `tts_server.py` + `.tts-venv` + `tts-voices/` setup in
the workspace root (see `README-TTS.md`).

## Controls

Status-bar buttons (bottom-right) plus hotkeys:

- **▶ Read / Resume** — `Ctrl+Cmd+R` — play from the sentence at the cursor (or the
  selection), or resume if paused.
- **⏸ Pause** — `Ctrl+Cmd+P` — stop audio, keep position (resume replays the current
  sentence).
- **⏹ Stop** — `Ctrl+Cmd+S` — stop and reset to the start.
- **− *value* +** — speed stepper: −/+ adjust by 0.25 (0.5x–3x), click the value to
  reset to 1x. Applies immediately to the current sentence; persists across sessions.
- **👤 *voice*** — pick a voice (also: *Katalog: Select voice*).

Works from the Markdown preview too (reads the source; highlight only shows if the
source editor is visible side-by-side — the preview webview can't be decorated).

## Voices

The picker lists every `*.onnx` (with a matching `*.onnx.json`) in the voices folder
(`katalogTts.voicesDir`, default `tts-voices/`). The selection persists; switching
mid-read restarts from the current sentence in the new voice.

## Settings (`katalogTts.*`)

| Setting | Default | Meaning |
|---------|---------|---------|
| `pythonPath` | `.tts-venv/bin/python` | Interpreter (relative to workspace or absolute). |
| `serverScript` | `tts_server.py` | The persistent synth server. |
| `model` / `config` | `tts-voices/en_US-lessac-high.onnx[.json]` | Voice files. |
| `rate` | `1.0` | Speech rate (>1 faster, <1 slower). |
| `wordHighlightColor` / `sentenceHighlightColor` | Rausch `#ff385c` tints | Highlight colors. |

## Note on word timing

`en_US-lessac-high` does not expose true per-word alignments, so **sentence**
boundaries are exact (anchored to each sentence's real audio duration) while the
**word** sweep within a sentence is estimated proportionally to word length. The
highlight always stays on the correct sentence and finishes exactly when the
sentence's audio ends.
