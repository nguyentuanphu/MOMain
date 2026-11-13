#!/usr/bin/env bash
# Starts HNMO: the game server (with the admin panel) and the web client.
# Press Ctrl+C to stop both.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d Data/Monsters ]; then
  echo "The game data is missing. Copy the Data folder of the game into $(pwd)/Data."
  exit 1
fi

(cd server && ASPNETCORE_URLS=http://127.0.0.1:8095 ./MUnique.OpenMU.Startup -demo -autostart -resolveIP:loopback -deamon > ../server.log 2>&1) &
SERVER=$!
(cd web && ./HNMO.Web > ../web.log 2>&1) &
WEB=$!
trap 'kill $SERVER $WEB 2>/dev/null' EXIT INT TERM

echo "HNMO is starting (logs: server.log, web.log)."
echo "  Play:        http://localhost:8080/"
echo "  Admin panel: http://localhost:8095/   (only on this computer)"
echo "  Friends on your network: http://YOUR-PC-IP:8080/   (see README.txt)"
wait
