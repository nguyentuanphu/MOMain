#!/usr/bin/env bash
# Builds the HNMO folder: the game server with its admin panel, the web client and
# HNMO.Web (web server + relay), ready to start with one click. Nothing has to be
# installed on the computer that runs it: .NET is included.
#
# Usage: web/tools/package-hnmo.sh <path to the server source (OpenMU)> [runtime] [output folder] [--no-data]
#   runtime: win-x64 (default), linux-x64, osx-arm64, ...
#   --no-data: leave the game data out (copy src/bin/Data into HNMO/Data yourself)
set -euo pipefail

SERVER_SOURCE="${1:?Give the path of the server source (the OpenMU repository)}"
RUNTIME="${2:-win-x64}"
WEB="$(cd "$(dirname "$0")/.." && pwd)"
CLIENT_REPO="$(cd "$WEB/.." && pwd)"
OUT="${3:-$CLIENT_REPO/dist/HNMO-$RUNTIME}"
WITH_DATA=1
for arg in "$@"; do [ "$arg" = "--no-data" ] && WITH_DATA=0; done

echo "Building HNMO for $RUNTIME into $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"

dotnet publish "$SERVER_SOURCE/src/Startup/MUnique.OpenMU.Startup.csproj" -c Release -r "$RUNTIME" --self-contained \
  -p:PublishSingleFile=false -o "$OUT/server" -v quiet
dotnet publish "$WEB/bridge/HNMO.Web.csproj" -c Release -r "$RUNTIME" --self-contained -o "$OUT/web" -v quiet

# The web client and its library
mkdir -p "$OUT/web/wwwroot" "$OUT/web/vendor/three"
cp -r "$WEB/public/." "$OUT/web/wwwroot/"
cp -r "$WEB/node_modules/three/build" "$OUT/web/vendor/three/build"
cat > "$OUT/web/appsettings.json" <<'JSON'
{
  "Urls": "http://0.0.0.0:8080",
  "Logging": { "LogLevel": { "Default": "Information", "Microsoft.AspNetCore": "Warning" } },
  "HNMO": { "WebRoot": "wwwroot", "DataPath": "../Data", "VendorPath": "vendor" },
  "Relay": { "AllowedHosts": [ "127.0.0.1", "localhost" ], "AllowLoopback": true, "ConnectTimeoutSeconds": 10 }
}
JSON

if [ "$WITH_DATA" = 1 ]; then
  echo "Copying the game data"
  cp -r "$CLIENT_REPO/src/bin/Data" "$OUT/Data"
else
  mkdir -p "$OUT/Data"
fi

mkdir -p "$OUT/licenses"
cp "$SERVER_SOURCE/LICENSE" "$OUT/licenses/server-LICENSE.txt"
cp "$WEB/node_modules/three/LICENSE" "$OUT/licenses/three.js-LICENSE.txt"
cp "$WEB/tools/hnmo/README.txt" "$OUT/README.txt"
cp "$WEB/tools/hnmo/start-hnmo.sh" "$WEB/tools/hnmo/Start HNMO.bat" "$OUT/"
chmod +x "$OUT/start-hnmo.sh"

echo "Done: $OUT"
