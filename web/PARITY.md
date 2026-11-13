# Web client: parity with the desktop client

The goal is a web client that matches the desktop client (`src/source`) one to one.
This list follows the client's source folders and is worked through top to bottom:
each item is done when it behaves like the desktop client against OpenMU.

Status: ✅ done · 🟡 partly · ⬜ not started

## 1. Connection and login (`Network/`, `Dotnet/`, `Scenes/LoginScene`, `Scenes/CharacterScene`)

| Feature | Status | Notes |
|---|---|---|
| Relay between browser and server (WebSocket ↔ TCP, SimpleModulus + Xor32) | ✅ | `web/bridge`, uses OpenMU's own network library like `ClientLibrary` |
| All packet definitions | ✅ | Generated from OpenMU's XML: 609 packets (`tools/generate-packets.mjs`) |
| Server list, game server address | ✅ | |
| Login (Xor3 credentials, version `20404`, serial) | ✅ | Error texts for each login result |
| Character list | ✅ | Name, level, class |
| Enter the world with a character | ✅ | Map and position from the server |
| Ping and ping answers | ✅ | |
| Character creation and deletion | ⬜ | |
| Login and character screens with the original 3D scenes and UI | ⬜ | Plain HTML forms for now |
| Reconnect after a lost connection (`Network/Reconnect`) | ⬜ | |
| Server messages, notices, disconnect reasons | ⬜ | |

## 2. World (`World/`, `Render/Terrain`, `Engine/Object`)

| Feature | Status | Notes |
|---|---|---|
| Terrain: heights, two texture layers, alpha, light map | ✅ | |
| Static objects with light-map tint | ✅ | Lorencia's model table, generic `ObjectNN.bmd` for other maps (untested) |
| Walkability (`.att`) | ✅ | |
| Other maps and map changes (warps, gates, `F3 1C`) | ⬜ | |
| Water, grass sway, animated objects (fountain, flags, birds, leaves) | ⬜ | |
| Map-specific behavior (`World/GameMaps`: Atlans water, Icarus sky, …) | ⬜ | |
| Day light mood, fog per map (`Data/Maps/LightMood.json`) | ⬜ | Fixed fog for now |
| Enhanced look (`Render/Look`, `Render/PostProcessing`) | ⬜ | |
| Minimap | ⬜ | |

## 3. Characters and monsters (`Character/`, `GameLogic/Monsters`, `Engine/AI`)

| Feature | Status | Notes |
|---|---|---|
| Own character: class body set, stand and walk animations | ✅ | |
| Other players in view (`12`), out of view (`14`), walking (`D4`), moved (`15`) | ✅ | Others walk straight to their target |
| NPCs and monsters in view (`13`) with models from `Data/Monsters` | ✅ | Scale and animation speeds from the data |
| Pathfinding and walk packets (15 steps per packet, continued) | ✅ | Verified: another player sees the same cell |
| Name labels | 🟡 | Players and NPCs, always shown; the client shows them on hover |
| Armour on characters from the appearance bytes (helm, armour, pants, gloves, boots) | ✅ | Models from `Data/Items/Models`; class body where nothing is worn |
| Weapons and shields in the hands, on the back in safe zones | ✅ | Bones 33, 42 and 47 with the back placements of `PlaceLinkedPart`; crossbow and a few special placements not yet |
| Wings | ✅ | Bone 47, animated, glowing meshes drawn additively |
| Capes (Dark Lord, Rage Fighter) as cloth | 🟡 | Drawn stiff on the back bone; the client hangs them from bone 19 as cloth |
| Pets and mounts (Guardian Angel, Imp, Horn of Fenrir, Dark Horse, …) | ⬜ | Read from the appearance, not drawn |
| Item glow by level, excellent and ancient shine | ⬜ | Read from the appearance, not drawn |
| Wardrobe (offline): try on any class, armour set, weapon and wings | ✅ | A developer tool, like the client's item previews |
| NPCs drawn with the player model (guards, …) with their equipment | 🟡 | Drawn with a default body set |
| Others' exact walking steps (`StepData`) | ⬜ | |
| Actions: attack, skills, die, emotes, sit (`18`, `19`, `1E`, `17`) | ⬜ | |
| Monster special setups (`hooks`, `glowMesh`, `stateVariants`, …) | ⬜ | |
| Shadows | ⬜ | |

## 4. Gameplay (`GameLogic/`)

| Feature | Status | Notes |
|---|---|---|
| Attack monsters, damage numbers, health bars | ⬜ | Next up |
| Skills and buffs (`GameLogic/Skills`, `Buffs`) | ⬜ | |
| Experience, level up, stats and points | ⬜ | |
| Items: drops, pick up, inventory, equip, use | ⬜ | |
| NPC dialogs, shops, buy and sell, repair | ⬜ | |
| Vault, trade, personal shop, chaos machine | ⬜ | |
| Party, guild, friends, messenger | ⬜ | |
| Quests | ⬜ | |
| Events (Blood Castle, Devil Square, Chaos Castle, …) | ⬜ | |
| MU Helper | ⬜ | |
| Cash shop | ⬜ | |

## 5. Interface (`UI/`, `Render/RmlUi`)

| Feature | Status | Notes |
|---|---|---|
| HUD: health, mana, experience bar, skill bar | ⬜ | |
| Chat window, whisper, party and guild chat, chat commands | ⬜ | |
| Inventory, character, skill tree and option windows | ⬜ | |
| Tooltips | ⬜ | |
| Themes and UI scaling | ⬜ | |
| Translations (`src/Localization`) | ⬜ | |

## 6. Effects and sound (`Render/Effects`, `Audio/`)

| Feature | Status | Notes |
|---|---|---|
| Skill effects, particles, sprites | ⬜ | |
| Item glow by level, excellent and ancient effects | ⬜ | |
| Sound effects and music | ⬜ | The sound files are not in the repository |

## 7. Models and formats

| Feature | Status | Notes |
|---|---|---|
| BMD versions 10 and 12 | ✅ | |
| BMD version 14 | ⬜ | Needed for newer models |
| Texture scripts (`_R` bright, `_H` hidden, `_N` no blending), `hid…` textures | ✅ | Hair is drawn as hair, not bright |
| Item glow meshes (`glowingMesh`, `pulsingGlow`, `noneBlendMeshes`) | 🟡 | Drawn additively; the pulsing and render styles (chrome, Flamberge fire, …) not yet. Staff of Resurrection still shows a black plane |
| Texture folders: first folder that has the texture | ✅ | |
| GLB models (`Data/Models/ModelFiles.json`) | ⬜ | |
