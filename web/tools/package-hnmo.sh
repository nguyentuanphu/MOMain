#!/usr/bin/env bash
# Builds the HNMO folder: the game server with its admin panel, the web client and
# HNMO.Web (web server + relay), ready to start with one click. Nothing has to be
# installed on the computer that runs it: .NET is included.
#
# Usage: web/tools/package-hnmo.sh <path to the server source (the HNMO server)> [runtime] [output folder] [--no-data]
#   runtime: win-x64 (default), linux-x64, osx-arm64, ...
#   --no-data: leave the game data out (copy src/bin/Data into HNMO/Data yourself)
# Environment:
#   POSTGRES_DIR: a portable PostgreSQL (with bin/, lib/, share/) to put into the folder,
#     e.g. the extracted Windows binaries zip of EnterpriseDB. Without it, the folder
#     uses POSTGRES_BIN (default /usr/lib/postgresql/16/bin), a PostgreSQL installed on the computer.
set -euo pipefail

SERVER_SOURCE="${1:?Give the path of the server source (the the HNMO server repository)}"
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
# The save game database: bundled, or one installed on the computer
POSTGRES_BIN_IN_FOLDER="../postgres/bin"
if [ -n "${POSTGRES_DIR:-}" ]; then
  mkdir -p "$OUT/postgres"
  for part in bin lib share; do cp -r "$POSTGRES_DIR/$part" "$OUT/postgres/$part"; done
else
  POSTGRES_BIN_IN_FOLDER="${POSTGRES_BIN:-/usr/lib/postgresql/16/bin}"
fi

# The game server talks to the folder's own database on its own port
sed -i 's/Port=5432;/Port=55432;/g' "$OUT/server/ConnectionSettings.xml"

cat > "$OUT/web/appsettings.json" <<JSON
{
  "Urls": "http://0.0.0.0:8080",
  "Logging": { "LogLevel": { "Default": "Information", "Microsoft.AspNetCore": "Warning" } },
  "HNMO": { "WebRoot": "wwwroot", "DataPath": "../Data", "VendorPath": "vendor" },
  "Relay": { "AllowedHosts": [ "127.0.0.1", "localhost" ], "AllowLoopback": true, "ConnectTimeoutSeconds": 10 },
  "Launcher": {
    "Enabled": true,
    "PostgresPath": "$POSTGRES_BIN_IN_FOLDER",
    "SavePath": "../save",
    "DatabasePort": 55432,
    "ServerPath": "../server",
    "AdminUrl": "http://127.0.0.1:8095",
    "OpenBrowserUrl": "http://localhost:8080/"
  }
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
if [ -n "${POSTGRES_DIR:-}" ]; then
  echo "PostgreSQL is released under the PostgreSQL License: https://www.postgresql.org/about/licence/" > "$OUT/licenses/postgresql-LICENSE.txt"
fi
cp "$WEB/tools/hnmo/README.txt" "$OUT/README.txt"
cp "$WEB/tools/hnmo/start-hnmo.sh" "$WEB/tools/hnmo/Start HNMO.bat" "$OUT/"
chmod +x "$OUT/start-hnmo.sh"

echo "Done: $OUT"
