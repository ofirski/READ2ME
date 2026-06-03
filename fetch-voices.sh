#!/usr/bin/env bash
# Download the Piper voices used by READ2ME into ./tts-voices/.
# Voices are not committed to git (they're large); run this after cloning.
# Source: https://huggingface.co/rhasspy/piper-voices
set -euo pipefail

BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main"
DEST="$(cd "$(dirname "$0")" && pwd)/tts-voices"
mkdir -p "$DEST"

# voice-name  ->  repo path (under $BASE)
VOICES=(
  "en_US-lessac-high|en/en_US/lessac/high"
  "en_US-ryan-high|en/en_US/ryan/high"
  "en_US-amy-medium|en/en_US/amy/medium"
  "en_GB-alan-medium|en/en_GB/alan/medium"
  "en_GB-cori-high|en/en_GB/cori/high"
)

for entry in "${VOICES[@]}"; do
  name="${entry%%|*}"
  dir="${entry##*|}"
  for ext in onnx onnx.json; do
    out="$DEST/$name.$ext"
    if [ -s "$out" ]; then
      echo "✓ $name.$ext already present"
    else
      echo "↓ $name.$ext"
      curl -L --fail --silent --show-error -o "$out" "$BASE/$dir/$name.$ext"
    fi
  done
done

echo "Done. Voices in $DEST:"
ls -1 "$DEST"/*.onnx
