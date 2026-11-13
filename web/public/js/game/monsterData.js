// Monster and NPC looks from the client's data files (Data/Monsters/Monsters.json and
// Models.json, see docs/monster-data.md): which model a type number uses, its scale
// and its animation speeds.

const FRAMES_PER_SECOND = 25; // animation speeds in the data are keys per 25 FPS frame (ADR 0001)
const DEFAULT_PLAY_SPEED = 0.25;
const MONSTER_ACTIONS = ['stop1', 'stop2', 'walk', 'attack1', 'attack2', 'shock', 'die'];
export const MonsterAction = { STOP: 0, WALK: 2 };

let catalog = null;

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

export async function loadMonsterCatalog() {
  if (catalog) return catalog;
  const [monsters, models] = await Promise.all([fetchJson('/data/Monsters/Monsters.json'), fetchJson('/data/Monsters/Models.json')]);
  const modelsBySlot = new Map(models.models.map((model) => [model.slot, model]));
  const byNumber = new Map();
  for (const monster of monsters.monsters) {
    for (const entry of monster.numbers) byNumber.set(entry.number, monster);
  }
  catalog = { byNumber, modelsBySlot, unknown: monsters.unknownMonsters };
  return catalog;
}

// Where to load a type's model from, and how to play it. Returns null for types drawn
// with the player model (guards, some NPCs), which need the player's body parts.
export function describeMonster(number) {
  const monster = catalog.byNumber.get(number);
  const slot = monster?.model ?? catalog.unknown.model;
  const name = monster?.name?.en ?? `Monster ${number}`;
  if (slot === 'player') return { name, usesPlayerModel: true, scale: monster?.scale ?? 1, kind: monster?.kind };
  const model = catalog.modelsBySlot.get(slot) ?? catalog.modelsBySlot.get(catalog.unknown.model);
  const file = model.file.replace(/^Data\//, '');
  const dir = file.slice(0, file.lastIndexOf('/'));
  const speeds = MONSTER_ACTIONS.map((action) => (model.animations?.[action] ?? DEFAULT_PLAY_SPEED) * FRAMES_PER_SECOND);
  return {
    name,
    kind: monster?.kind ?? 'monster',
    usesPlayerModel: false,
    dir,
    fileName: file.slice(dir.length + 1),
    textureDir: model.textureFolders?.[0] ?? dir,
    scale: monster?.scale ?? model.scale ?? 1,
    keysPerSecond: speeds,
  };
}
