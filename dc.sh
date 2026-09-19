#!/usr/bin/env bash
# dc.sh — DroidClaw one-liner: send command JSON to bridge, print result.
# usage: ./dc.sh '{"type":"ping"}'  [timeout_ms]
BODY=${1:?command json required}
TMO=${2:-35000}
curl -s localhost:7335/command -d "{\"command\":$BODY,\"timeout\":$TMO}"
