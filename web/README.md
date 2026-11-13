# Web client (experimental)

A browser version of the client that reads the game data in `src/bin/Data`
directly and plays on an OpenMU server. It is being built up to match the desktop
client one to one; [PARITY.md](PARITY.md) tracks what works and what's next.

## What it does

- Logs in to OpenMU: server list, login, character list, entering the world.
- Draws the map the server puts you on: terrain, light map and all static objects.
- Shows the players, NPCs and monsters in view, with their models and animations
  from `Data/Monsters`, and keeps them in sync as they come, go and walk.
- Click to walk: the path avoids blocked cells and is sent to the server, so other
  players see you walk. Right-drag turns the camera, the mouse wheel zooms.
- "Explore offline" walks Lorencia without a server.

## Run it

You need Node.js 18+, the .NET 10 SDK and a running OpenMU server (for example
`dotnet MUnique.OpenMU.Startup.dll -demo -autostart -resolveIP:loopback`).

```bash
# 1. The relay between the browser and the game servers (port 8081)
cd web/bridge
dotnet run -c Release

# 2. The web client (port 8080), in a second terminal
cd web
npm install
npm start
```

Open <http://127.0.0.1:8080/> and log in, e.g. with OpenMU's test account
`test300` / `test300`. The connect server and relay addresses are under "Server".

Browsers can't open TCP connections, so everything goes through the relay. It only
connects to the hosts in `bridge/appsettings.json` (`Relay:AllowedHosts`, plus
loopback addresses), so it can't be used to reach anything else.

The web server binds to localhost on purpose: the game data is not ours to
publish, so don't expose it to the internet.

## Packets

`public/js/net/packets.generated.js` is generated from OpenMU's packet
definitions, so every packet the server knows can be read and written by name:

```bash
node tools/generate-packets.mjs <OpenMU>/src/Network/Packets
```

## How the files are read

The parsers in `public/js/formats.js` are ports of the client's loaders, and each
names the C++ function it follows:

| File | Format |
|---|---|
| `EncTerrainN.map` | Texture layers 1 and 2 and the blend alpha per cell, encrypted with `MapFileDecrypt` |
| `EncTerrainN.att` | Walkability flags per cell, `MapFileDecrypt` + `BuxConvert` |
| `EncTerrainN.obj` | Static objects: type, position, angles, scale |
| `TerrainHeight.OZB` | 8-bit BMP after a 4-byte prefix, 1.5 units per level |
| `TerrainLight.OZJ` | Baked light map (JPEG after a 24-byte prefix) |
| `*.bmd` | Models, versions 10 (plain) and 12 (`MapFileDecrypt`); version 14 is not supported yet |
| `*.OZJ` / `*.OZT` | JPEG / TGA with a prefix; the server unwraps them |

## Not done yet

See [PARITY.md](PARITY.md). Next up: attacking monsters (damage, health bars,
dying), then equipment on characters and the HUD.
