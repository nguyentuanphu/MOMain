// Item definitions and their 3D models, from the client's data (Data/Items, see
// docs/item-data.md): an item is a group (0-15) and a number, and its model entry
// names the .bmd file and the folders of its textures.

const GROUP_FILES = ['Group00_Sword', 'Group01_Axe', 'Group02_Mace', 'Group03_Spear', 'Group04_Bow', 'Group05_Staff',
  'Group06_Shield', 'Group07_Helm', 'Group08_Armor', 'Group09_Pants', 'Group10_Gloves', 'Group11_Boots', 'Group12_Wing',
  'Group13_Helper', 'Group14_Potion', 'Group15_Etc'];

export const ItemGroup = { SWORD: 0, AXE: 1, MACE: 2, SPEAR: 3, BOW: 4, STAFF: 5, SHIELD: 6, HELM: 7, ARMOR: 8, PANTS: 9, GLOVES: 10, BOOTS: 11, WING: 12, HELPER: 13 };
export const ARMOR_GROUPS = [ItemGroup.HELM, ItemGroup.ARMOR, ItemGroup.PANTS, ItemGroup.GLOVES, ItemGroup.BOOTS];
export const WEAPON_GROUPS = [ItemGroup.SWORD, ItemGroup.AXE, ItemGroup.MACE, ItemGroup.SPEAR, ItemGroup.BOW, ItemGroup.STAFF];

let catalog = null;

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

function splitPath(file) {
  const path = file.replace(/^Data\//, '');
  const slash = path.lastIndexOf('/');
  return { dir: path.slice(0, slash), fileName: path.slice(slash + 1) };
}

const GLOW_EFFECTS = new Set(['glowingMesh', 'pulsingGlow']);

// Which meshes are drawn additively, like the client's BlendMesh: the item effect's
// glow mesh ("all" for every mesh), except the meshes listed in noneBlendMeshes.
// Meshes a glow style marks as its own (glow.hiddenMesh, e.g. Flamberge's fire) glow too.
function glowMeshRule(entry, model) {
  const noBlend = new Set(model.noneBlendMeshes ?? entry.noneBlendMeshes ?? []);
  const glowMesh = GLOW_EFFECTS.has(entry.itemEffect) ? entry.itemEffectValues?.glowMesh : undefined;
  const glowStyleMesh = entry.glow?.hiddenMesh;
  return (index) => !noBlend.has(index) && (glowMesh === 'all' || glowMesh === index || glowStyleMesh === index);
}

export async function loadItemCatalog() {
  if (catalog) return catalog;
  const [shared, ...groups] = await Promise.all([
    fetchJson('/data/Items/Models/SharedModels.json'),
    ...GROUP_FILES.map((name) => fetchJson(`/data/Items/Models/${name}.json`)),
  ]);
  const items = await Promise.all(GROUP_FILES.map((name) => fetchJson(`/data/Items/${name}.json`)));
  const sharedByName = new Map(shared.models.map((model) => [model.name, model]));
  const models = new Map();
  const names = new Map();
  groups.forEach((group, groupIndex) => {
    for (const entry of group.models) {
      const model = entry.model ? sharedByName.get(entry.model) : entry;
      if (!model?.file) continue;
      models.set(`${groupIndex}:${entry.number}`, {
        ...splitPath(model.file),
        textureDir: model.textureFolders?.length ? model.textureFolders : ['Item'],
        isGlowMesh: glowMeshRule(entry, model),
      });
    }
  });
  items.forEach((group, groupIndex) => {
    for (const item of group.items) if (item.name?.en) names.set(`${groupIndex}:${item.number}`, item.name.en);
  });
  catalog = { models, names };
  return catalog;
}

export function itemModel(group, number) {
  return catalog?.models.get(`${group}:${number}`) ?? null;
}

export function itemName(group, number) {
  return catalog?.names.get(`${group}:${number}`) ?? `Item ${group},${number}`;
}

// The items of a group that have both a name and a model, for pickers.
export function itemsWithModels(group) {
  const result = [];
  for (const key of catalog.models.keys()) {
    const [g, number] = key.split(':').map(Number);
    if (g === group && catalog.names.has(key)) result.push({ group, number, name: catalog.names.get(key) });
  }
  return result.sort((a, b) => a.number - b.number);
}

// ---------- appearance ----------

const NO_ITEM_GROUP = 0xf;
const NO_ITEM_NUMBER = 0xfff;

function shinyItem(bytes, at) {
  const group = bytes[at] >> 4;
  const number = ((bytes[at] & 0xf) << 8) | bytes[at + 1];
  if (group === NO_ITEM_GROUP && number === NO_ITEM_NUMBER) return null;
  return { group, number, glowLevel: bytes[at + 2] >> 4, excellent: (bytes[at + 2] & 0x08) !== 0, ancient: (bytes[at + 2] & 0x04) !== 0 };
}

function plainItem(bytes, at) {
  const group = bytes[at] >> 4;
  const number = ((bytes[at] & 0xf) << 8) | bytes[at + 1];
  if (group === NO_ITEM_GROUP && number === NO_ITEM_NUMBER) return null;
  return { group, number };
}

// OpenMU's extended appearance (AppearanceSerializerExtended, 27 bytes), which it
// sends to MuMain in character lists and when players come into view.
export function parseAppearance(bytes) {
  if (!bytes || bytes.length < 27) return { classNumber: bytes?.[0] ?? 0, equipment: {} };
  const items = 2;
  return {
    classNumber: bytes[0],
    equipment: {
      rightHand: shinyItem(bytes, items),       // inventory slot 0, drawn in the right hand
      leftHand: shinyItem(bytes, items + 3),    // inventory slot 1
      helm: shinyItem(bytes, items + 6),
      armor: shinyItem(bytes, items + 9),
      pants: shinyItem(bytes, items + 12),
      gloves: shinyItem(bytes, items + 15),
      boots: shinyItem(bytes, items + 18),
      wings: plainItem(bytes, items + 21),
      pet: plainItem(bytes, items + 23),
    },
  };
}
