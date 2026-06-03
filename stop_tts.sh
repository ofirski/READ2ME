#!/usr/bin/env bash
# Stop any in-progress "Read MD aloud" playback.
# Kills the read_md.py reader and any afplay child it spawned.
set -u

killed=0

# Kill the python reader(s). pkill -f matches the full command line.
if pkill -f "read_md.py" 2>/dev/null; then
  killed=1
fi

# Kill afplay directly in case a chunk is mid-playback.
if pkill -x afplay 2>/dev/null; then
  killed=1
fi

if [ "$killed" -eq 1 ]; then
  echo "TTS playback stopped."
else
  echo "No TTS playback was running."
fi
