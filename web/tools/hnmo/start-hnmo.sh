#!/usr/bin/env bash
# Starts HNMO: the save game database, the game server with its admin panel, and the
# game, which opens in your browser. Press Ctrl+C to stop everything.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d Data/Monsters ]; then
  echo "The game data is missing. Copy the Data folder of the game into $(pwd)/Data."
  exit 1
fi
cd web
exec ./HNMO
