# HNMO web client (experimental)

A browser version of the client that reads the game data in `src/bin/Data`
directly and plays on the HNMO server. It is being built up to match the desktop
client one to one; [PARITY.md](PARITY.md) tracks what works and what's next.

## What it does

- Logs in to the HNMO server: server list, login, character list, entering the world.
- Draws the map the server puts you on: terrain, light map and all static objects.
- Shows the players, NPCs and monsters in view, with their models and animations
  from `Data/Monsters`, and keeps them in sync as they come, go and walk.
- Click to walk: the path avoids blocked cells and is sent to the server, so other
  players see you walk. Right-drag turns the camera, the mouse wheel zooms.
- "Explore offline" walks Lorencia without a server.

## Run it

### The HNMO folder (players)

`tools/package-hnmo.sh` builds one folder with the game server, its admin panel, the
web client and the game data; nothing has to be installed where it runs (.NET is
included). Start it with `Start HNMO.bat` (Windows) or `start-hnmo.sh`. Its
`README.txt` explains how friends join.

```bash
web/tools/package-hnmo.sh <path to the server repository> win-x64
```

The GitHub workflow "HNMO package" builds the Windows folder as a download.

### From source (developers)

You need the .NET 10 SDK, Node.js (for `npm install` only) and a running server,
e.g. the server program started with `-demo -autostart -resolveIP:loopback`.

```bash
cd web
npm install
npm start        # HNMO.Web: the client, the game data and the relay on port 8081
```

Open <http://127.0.0.1:8081/> and log in, e.g. with the test account `test300` /
`test300`.

`HNMO.Web` (`bridge/`) serves the page, the game data (`/data`) and the relay
(`/relay`) from one address. The relay only connects to the hosts in
`bridge/appsettings.json` (`Relay:AllowedHosts`, plus loopback addresses), so it can't
be used to reach anything else. Don't expose it to the internet: the game data is not
ours to publish.

## Packets

`public/js/net/packets.generated.js` is generated from the server's packet
definitions, so every packet the server knows can be read and written by name:

```bash
node tools/generate-packets.mjs <the HNMO server>/src/Network/Packets
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
