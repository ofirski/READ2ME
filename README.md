# READ2ME

Free, fully offline, high-quality neural **text-to-speech for reading Markdown
aloud** on macOS, using [Piper](https://github.com/OHF-Voice/piper1-gpl). Two ways
to use it:

1. **Cursor / VS Code extension** (`tts-extension/`) — reads the active editor aloud
   with **sentence + word highlighting** and status-bar controls (play / pause /
   stop / speed stepper / voice picker). This is the main way to use it.
2. **Terminal script** (`read_md.py`) — `./.tts-venv/bin/python read_md.py file.md`
   for audio-only reading without the editor.

➡️ **Full setup, hotkeys, controls, and voice instructions: [README-TTS.md](README-TTS.md).**

## Quick start (after cloning)

**macOS / Linux:**
```bash
# 1. Python env
python3 -m venv .tts-venv
./.tts-venv/bin/pip install -r tts-requirements.txt

# 2. Voice models (not committed — large binaries)
./fetch-voices.sh

# 3. Build + install the Cursor extension
cd tts-extension
npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository
/Applications/Cursor.app/Contents/Resources/app/bin/cursor --install-extension read2me-*.vsix
```

**Windows (PowerShell):**
```powershell
# 1. Python env
python -m venv .tts-venv
.\.tts-venv\Scripts\pip install -r tts-requirements.txt

# 2. Voice models — requires Git Bash
& "C:\Program Files\Git\bin\bash.exe" ".\fetch-voices.sh"

# 3. Build + install the VS Code extension
cd tts-extension
npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository
code --install-extension (Get-Item read2me-*.vsix).Name
```

Then set `read2me.pythonPath` in VS Code Settings to the absolute path of
`.tts-venv\Scripts\python.exe` (e.g. `C:\path\to\READ2ME\.tts-venv\Scripts\python.exe`).

The extension finds this project via absolute paths in your **Cursor user settings**
(`read2me.pythonPath`, `read2me.serverScript`, `read2me.voicesDir`,
`read2me.model`, `read2me.config`), so read-aloud works from any workspace,
not just this one. Update those settings if you move the repo.

## What's tracked vs. generated

- **Tracked:** `read_md.py`, `tts_server.py`, `stop_tts.sh`, `tts-requirements.txt`,
  `tts-extension/` (source), `fetch-voices.sh`, `.vscode/`, docs.
- **Git-ignored (regenerate locally):** `.tts-venv/`, `tts-voices/`, `*.vsix`.

## Note: Piper has no Hebrew voice

Verified against the `rhasspy/piper-voices` repo — there is no `he`/`he_IL` voice.
See README-TTS.md for details and the macOS `say -v Carmit` fallback.
