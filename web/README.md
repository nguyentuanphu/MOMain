# Web viewer (experimental)

A first step towards running the client in a browser: it reads the game data in
`src/bin/Data` directly and draws a world with three.js. It is a prototype of the
rendering side only; it does not connect to a server yet.

## What it does

- Lorencia: terrain heights, both texture layers with their blend, the baked
  light map, and all 2,870 static objects (houses, trees, walls, the fountain, …).
- A player character: the `player.bmd` skeleton with the five body parts of a
  class set, animated (standing and walking).
- Click to walk, stopping at cells the map marks as not walkable. Right-drag turns
  the camera, the mouse wheel zooms.

## Run it

Requires Node.js 18 or newer.

```bash
cd web
npm install
npm start
```

Then open <http://127.0.0.1:8080/>. `PORT`, `HOST` and `MU_DATA_DIR` (another
`Data` folder) can be set in the environment.

The server binds to localhost on purpose: the game data is not ours to publish,
so don't expose this server to the internet.

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

- Network: login, other players, monsters and NPCs from OpenMU. Browsers can't open
  TCP sockets, so this needs a WebSocket bridge to the server and the packet
  encryption in JavaScript.
- Other maps (only Lorencia's model table is in `world.js`), water and grass
  animation, object animation, effects, weapons, wings, the UI.
- BMD version 14 models.
