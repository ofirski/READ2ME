#!/usr/bin/env python3
"""Read a Markdown file aloud with Piper (offline neural TTS) on macOS.

Usage:
    ./.tts-venv/bin/python read_md.py path/to/file.md

Pipeline: Markdown -> HTML -> plain text (markdown syntax stripped, code blocks
replaced with a short spoken marker), then the text is split into small chunks
that are synthesized and played sequentially. The Piper model is loaded ONCE and
chunks are synthesized on a background thread while the previous chunk plays, so
audio starts within ~1 second instead of after the whole file is processed.

Playback uses macOS `afplay`. Ctrl+C stops cleanly (kills in-flight afplay).
"""

from __future__ import annotations

import os
import queue
import re
import signal
import subprocess
import sys
import tempfile
import threading
import wave
from pathlib import Path

# --------------------------------------------------------------------------- #
# CONFIGURATION — tweak these                                                  #
# --------------------------------------------------------------------------- #

# Default voice. Point this at any Piper .onnx you've put in ./tts-voices/.
# The matching .onnx.json must sit next to it (same name + ".json").
VOICE_MODEL = Path(__file__).resolve().parent / "tts-voices" / "en_US-lessac-high.onnx"

# Speech rate. 1.0 = the voice's natural speed. >1.0 = faster, <1.0 = slower.
# (Internally this becomes Piper's length_scale = 1 / SPEECH_RATE.)
SPEECH_RATE = 1.0

# Roughly how many characters to synthesize per chunk. Smaller = audio starts
# sooner and stops faster, but tiny gaps between chunks. ~280 is a good balance.
MAX_CHUNK_CHARS = 280

# How many chunks to synthesize ahead of playback. 2 keeps audio gapless without
# synthesizing the whole file up front.
PREFETCH = 2

# Spoken marker used in place of fenced/indented code blocks (we never read code).
CODE_MARKER = "code block."

# --------------------------------------------------------------------------- #
# Markdown -> speakable plain text                                             #
# --------------------------------------------------------------------------- #


def markdown_to_text(md_text: str) -> str:
    """Convert Markdown into clean, speakable plain text.

    Strips all markdown syntax (no "pound pound" / "star star") and replaces
    code blocks with a short spoken marker so raw code is never read aloud.
    """
    import markdown as md_lib
    from bs4 import BeautifulSoup

    html = md_lib.markdown(
        md_text,
        extensions=["fenced_code", "tables", "sane_lists"],
    )
    soup = BeautifulSoup(html, "html.parser")

    # Replace fenced/indented code blocks (<pre>...) with a spoken marker so we
    # don't read source code character by character.
    for pre in soup.find_all("pre"):
        pre.replace_with(CODE_MARKER + " ")

    # Drop anything explicitly hidden / non-spoken.
    for tag in soup.find_all(["script", "style"]):
        tag.decompose()

    # Use newlines between blocks so sentence/paragraph splitting works later.
    text = soup.get_text(separator="\n")

    # Tidy whitespace: collapse runs of spaces, trim each line, squeeze blank lines.
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in text.splitlines()]
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text


_SENTENCE_RE = re.compile(r"(?<=[.!?…])\s+")


def chunk_text(text: str) -> list[str]:
    """Split text into small speakable chunks (<= MAX_CHUNK_CHARS where possible).

    Splits on blank lines (paragraphs / headings / list items), then on sentence
    boundaries, then greedily regroups sentences up to the size cap.
    """
    chunks: list[str] = []
    for block in re.split(r"\n\s*\n", text):
        block = " ".join(block.split())  # flatten internal newlines
        if not block:
            continue
        if len(block) <= MAX_CHUNK_CHARS:
            chunks.append(block)
            continue
        current = ""
        for sentence in _SENTENCE_RE.split(block):
            sentence = sentence.strip()
            if not sentence:
                continue
            if current and len(current) + 1 + len(sentence) > MAX_CHUNK_CHARS:
                chunks.append(current)
                current = sentence
            else:
                current = f"{current} {sentence}".strip()
        if current:
            chunks.append(current)
    return chunks


# --------------------------------------------------------------------------- #
# Synthesis + playback                                                         #
# --------------------------------------------------------------------------- #


def load_voice():
    from piper import PiperVoice

    if not VOICE_MODEL.exists():
        sys.exit(f"Voice model not found: {VOICE_MODEL}\n"
                 f"Download one into ./tts-voices/ (see README-TTS.md).")
    config = VOICE_MODEL.with_suffix(VOICE_MODEL.suffix + ".json")
    if not config.exists():
        sys.exit(f"Voice config not found next to model: {config}")
    return PiperVoice.load(str(VOICE_MODEL), config_path=str(config))


def main() -> int:
    if len(sys.argv) < 2:
        sys.exit("Usage: read_md.py <file.md>")
    arg = sys.argv[1]
    if "${file}" in arg or not arg.strip():
        sys.exit(
            "No file was passed. VS Code/Cursor could not resolve ${file} — "
            "click into the Markdown SOURCE editor (not the preview, Explorer, "
            "or terminal) so a saved file is the active tab, then run again."
        )
    md_path = Path(arg)
    if not md_path.is_file():
        sys.exit(f"File not found: {md_path}")

    from piper import SynthesisConfig

    text = markdown_to_text(md_path.read_text(encoding="utf-8"))
    chunks = chunk_text(text)
    if not chunks:
        print("Nothing to read (file produced no speakable text).")
        return 0

    print(f"Reading {md_path.name}: {len(chunks)} chunk(s). Press Ctrl+C to stop.")

    voice = load_voice()
    syn_config = SynthesisConfig(length_scale=1.0 / SPEECH_RATE)

    tmp_dir = Path(tempfile.mkdtemp(prefix="read_md_"))
    stop = threading.Event()
    # Bounded queue => producer stays ~PREFETCH chunks ahead, not the whole file.
    wav_q: "queue.Queue[tuple[int, Path] | None]" = queue.Queue(maxsize=PREFETCH)

    def producer() -> None:
        try:
            for i, chunk in enumerate(chunks):
                if stop.is_set():
                    break
                wav_path = tmp_dir / f"chunk_{i:04d}.wav"
                try:
                    with wave.open(str(wav_path), "wb") as wf:
                        voice.synthesize_wav(chunk, wf, syn_config=syn_config)
                except Exception as exc:  # skip a bad chunk rather than abort
                    print(f"[skip chunk {i}: {exc}]", file=sys.stderr)
                    continue
                wav_q.put((i, wav_path))
        finally:
            wav_q.put(None)  # sentinel: no more audio

    worker = threading.Thread(target=producer, daemon=True)
    worker.start()

    current_proc: subprocess.Popen | None = None
    try:
        while True:
            item = wav_q.get()
            if item is None:
                break
            _, wav_path = item
            # afplay in its own process group so we can kill just it on Ctrl+C.
            current_proc = subprocess.Popen(["afplay", str(wav_path)])
            current_proc.wait()
            current_proc = None
            try:
                wav_path.unlink()
            except OSError:
                pass
    except KeyboardInterrupt:
        print("\nStopped.")
        stop.set()
        if current_proc and current_proc.poll() is None:
            current_proc.terminate()
            try:
                current_proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                current_proc.kill()
        # Drain any queued chunks so the producer thread can exit.
        try:
            while True:
                wav_q.get_nowait()
        except queue.Empty:
            pass
    finally:
        stop.set()
        # Best-effort cleanup of temp WAVs + dir.
        for leftover in tmp_dir.glob("*.wav"):
            try:
                leftover.unlink()
            except OSError:
                pass
        try:
            tmp_dir.rmdir()
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    # Default SIGINT handling is fine (raises KeyboardInterrupt), but make sure a
    # bare Ctrl+C never dumps a traceback.
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
