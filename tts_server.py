#!/usr/bin/env python3
"""Persistent Piper synthesis server for the Katalog "Read aloud" Cursor extension.

Loads the voice ONCE, then services line-delimited JSON requests on stdin and
replies with line-delimited JSON on stdout. Keeping the process alive avoids
re-loading the ~109 MB model for every sentence, so sequential synthesis is fast.

Protocol (one JSON object per line):
    request : {"id": <int>, "text": <str>, "out": <wav path>, "rate": <float?>}
    reply   : {"id": <int>, "ok": true,  "duration": <seconds>}
            | {"id": <int>, "ok": false, "error": <str>}

Args: tts_server.py <model.onnx> <model.onnx.json>

The server emits {"ready": true} on stdout once the model is loaded.
"""

from __future__ import annotations

import json
import sys
import wave


def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"ready": False, "error": "usage: tts_server.py <model> <config>"}),
              flush=True)
        return 2

    model_path, config_path = sys.argv[1], sys.argv[2]

    try:
        from piper import PiperVoice, SynthesisConfig
        voice = PiperVoice.load(model_path, config_path=config_path)
    except Exception as exc:  # surface load failure to the extension
        print(json.dumps({"ready": False, "error": f"load failed: {exc}"}), flush=True)
        return 1

    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            print(json.dumps({"ok": False, "error": f"bad json: {exc}"}), flush=True)
            continue

        req_id = req.get("id")
        text = (req.get("text") or "").strip()
        out_path = req.get("out")
        rate = float(req.get("rate", 1.0)) or 1.0

        if not text or not out_path:
            print(json.dumps({"id": req_id, "ok": False, "error": "missing text/out"}),
                  flush=True)
            continue

        try:
            syn = SynthesisConfig(length_scale=1.0 / rate)
            sample_rate = voice.config.sample_rate
            total_samples = 0
            # synthesize() yields one chunk per sentence; concatenate to one WAV
            # and tally exact sample count for an exact duration.
            frames: list[bytes] = []
            for chunk in voice.synthesize(text, syn_config=syn):
                sample_rate = chunk.sample_rate
                frames.append(chunk.audio_int16_bytes)
                total_samples += len(chunk.audio_int16_array)

            with wave.open(out_path, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(sample_rate)
                wf.writeframes(b"".join(frames))

            duration = total_samples / float(sample_rate) if sample_rate else 0.0
            print(json.dumps({"id": req_id, "ok": True, "duration": duration}), flush=True)
        except Exception as exc:
            print(json.dumps({"id": req_id, "ok": False, "error": str(exc)}), flush=True)

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (KeyboardInterrupt, BrokenPipeError):
        sys.exit(0)
