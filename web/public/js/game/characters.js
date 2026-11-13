// Characters on the map: the player, other players, NPCs and monsters. Each one is an
// animated model that walks from cell to cell like the client's characters do.

import * as THREE from 'three';
import { TERRAIN_SCALE, TERRAIN_SIZE, TerrainFlag } from '../formats.js';
import { loadModel, buildGeometries, computeBoneMatrices, createMaterial, AnimatedModel } from '../bmd.js';
import { sampleHeight, sampleLight } from '../terrain.js';
import { describeMonster, MonsterAction } from './monsterData.js';
import { itemModel, ItemGroup } from './items.js';
import { addItemGlow } from './itemGlow.js';

export const PlayerAction = { STOP: 1, WALK: 15 }; // PLAYER_STOP_MALE, PLAYER_WALK_MALE
const PLAYER_KEYS_PER_SECOND = { [PlayerAction.STOP]: 6, [PlayerAction.WALK]: 9 };
const BODY_PARTS = ['Helm', 'Armor', 'Pant', 'Glove', 'Boot'];
export const WALK_CELLS_PER_SECOND = 3.3;
const DEGREES = Math.PI / 180;
const ROTATION_STEP_DEGREES = 45;

export function cellCenter(cell) {
  return (cell + 0.5) * TERRAIN_SCALE;
}

// The angle the client gives an object received with a packet rotation (WSclient.cpp).
export function angleFromRotation(rotation) {
  return (rotation - 1) * ROTATION_STEP_DEGREES * DEGREES;
}

// Each body part shows the worn item's model, or the class's own body without one.
const BODY_PART_SLOTS = { Helm: 'helm', Armor: 'armor', Pant: 'pants', Glove: 'gloves', Boot: 'boots' };

function bodyPartSource(part, bodySet, equipment) {
  const item = equipment?.[BODY_PART_SLOTS[part]];
  const model = item ? itemModel(item.group, item.number) : null;
  if (model) return { dir: model.dir, fileName: model.fileName, textureDir: model.textureDir, item, glow: model.glow };
  return { dir: 'Player', fileName: `${part}Class${String(bodySet).padStart(2, '0')}.bmd`, textureDir: 'Player' };
}

export async function createPlayerModel(bodySet, equipment) {
  const skeleton = await loadModel('Player', 'player.bmd');
  const pose = computeBoneMatrices(skeleton, PlayerAction.STOP, 0);
  const sources = BODY_PARTS.map((part) => bodyPartSource(part, bodySet, equipment));
  const loaded = await Promise.all(sources.map(async (source) => {
    try {
      const model = await loadModel(source.dir, source.fileName);
      const geometries = buildGeometries(model, pose);
      const materials = await Promise.all(geometries.map((geometry) => createMaterial(source.textureDir, geometry.textureName)));
      return { geometries, materials };
    } catch (error) {
      console.warn(`Body part ${source.dir}/${source.fileName} missing`, error.message);
      return { geometries: [], materials: [] };
    }
  }));
  const animated = new AnimatedModel(skeleton, loaded.flatMap((part) => part.geometries), loaded.flatMap((part) => part.materials));
  // Each worn item glows by its own level and options, on its own meshes.
  let first = 0;
  await Promise.all(loaded.map((part, index) => {
    const parts = animated.parts.slice(first, first + part.geometries.length);
    first += part.geometries.length;
    const source = sources[index];
    return source.item ? addItemGlow(animated, parts, source.glow, source.item) : null;
  }));
  return animated;
}

// ---------- weapons and wings ----------

// The player skeleton's bones parts hang from (ZzzCharacter.cpp: Weapon[].LinkBone, RenderCharacterBackItem).
const Bone = { RIGHT_HAND: 33, LEFT_HAND: 42, BACK: 47 };
const WING_KEYS_PER_SECOND = 0.25 * 25;

// AngleMatrix (Core/Math) with a translation: degrees around x, y and z, applied z, y, x.
function angleMatrix([x, y, z], [tx, ty, tz] = [0, 0, 0]) {
  const matrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(x * DEGREES, y * DEGREES, z * DEGREES, 'ZYX'));
  return matrix.setPosition(tx, ty, tz);
}

// How a weapon sits on the back in a safe zone (PlaceLinkedPart with Link = true).
function backPlacement(item, rightHand) {
  let translation = [-20, 5, 40];
  if (item.group === ItemGroup.SHIELD) translation = [-10, 0, 0];
  else if (item.group === ItemGroup.BOW) translation = [-10, 5, 10];
  const matrix = angleMatrix([70, 0, 90], translation);
  if (!rightHand && item.group !== ItemGroup.SHIELD) matrix.multiply(angleMatrix([145, 0, 275], [0, 10, -30]));
  return matrix;
}

async function createItemModel(item) {
  const source = itemModel(item.group, item.number);
  if (!source) return null;
  const model = await loadModel(source.dir, source.fileName);
  const parts = buildGeometries(model, computeBoneMatrices(model, 0, 0));
  const materials = await Promise.all(parts.map((part, index) => createMaterial(source.textureDir, part.textureName, { glow: source.isGlowMesh?.(index) })));
  const animated = new AnimatedModel(model, parts, materials);
  await addItemGlow(animated, animated.parts, source.glow, item);
  return animated;
}

class Attachment {
  constructor({ model, item, slot }) {
    this.model = model;
    this.item = item;
    this.slot = slot;
    this.model.group.matrixAutoUpdate = false;
    this.backMatrix = slot === 'wings' ? null : backPlacement(item, slot === 'rightHand');
  }

  place(boneMatrices, onBack, time) {
    const matrix = this.model.group.matrix;
    if (this.slot === 'wings') matrix.copy(boneMatrices[Bone.BACK]);
    else if (onBack) matrix.multiplyMatrices(boneMatrices[Bone.BACK], this.backMatrix);
    else matrix.copy(boneMatrices[this.slot === 'rightHand' ? Bone.RIGHT_HAND : Bone.LEFT_HAND]);
    this.model.group.matrixWorldNeedsUpdate = true;
    this.model.pose(0, this.slot === 'wings' ? time * WING_KEYS_PER_SECOND : 0);
  }
}

export async function createAttachments(equipment) {
  const slots = ['rightHand', 'leftHand', 'wings'].filter((slot) => equipment?.[slot]);
  const attachments = await Promise.all(slots.map(async (slot) => {
    try {
      const model = await createItemModel(equipment[slot]);
      return model ? new Attachment({ model, item: equipment[slot], slot }) : null;
    } catch (error) {
      console.warn(`Item ${equipment[slot].group},${equipment[slot].number} not drawn`, error.message);
      return null;
    }
  }));
  return attachments.filter(Boolean);
}

async function createMonsterModel(description) {
  const model = await loadModel(description.dir, description.fileName);
  const parts = buildGeometries(model, computeBoneMatrices(model, 0, 0));
  const materials = await Promise.all(parts.map((part) => createMaterial(description.textureDir, part.textureName)));
  return new AnimatedModel(model, parts, materials);
}

export class Character {
  constructor({ id, name, model, kind, scale = 1, actions, keysPerSecond }) {
    this.id = id;
    this.name = name;
    this.kind = kind;
    this.model = model;
    this.model.group.scale.setScalar(scale);
    this.actions = actions;
    this.keysPerSecond = keysPerSecond;
    this.position = new THREE.Vector2();
    this.cell = { x: 0, y: 0 };
    this.path = [];
    this.angle = 0;
    this.action = actions.stop;
    this.time = Math.random() * 10;
    this.light = new THREE.Color();
    this.attachments = [];
    this.weaponsOnBack = false;
    this.holdWeapons = false; // the wardrobe can show weapons in the hands in town
    this.clock = 0;
  }

  setAttachments(attachments) {
    for (const attachment of this.attachments) this.model.group.remove(attachment.model.group);
    this.attachments = attachments;
    for (const attachment of attachments) this.model.group.add(attachment.model.group);
  }

  get group() { return this.model.group; }

  placeAt(x, y, rotation) {
    this.cell = { x, y };
    this.position.set(cellCenter(x), cellCenter(y));
    this.path = [];
    if (rotation !== undefined) this.angle = angleFromRotation(rotation);
  }

  walk(cells) {
    this.path = cells.slice();
  }

  // Walks straight to a cell, used for others whose exact steps we don't simulate.
  walkStraightTo(x, y) {
    this.path = [{ x, y }];
  }

  get isWalking() { return this.path.length > 0; }

  update(dt, world) {
    this.advance(dt);
    const action = this.isWalking ? this.actions.walk : this.actions.stop;
    if (action !== this.action) { this.action = action; this.time = 0; }
    this.time += dt * this.keysPerSecond(action);
    const { x, y } = this.position;
    this.group.position.set(x, y, sampleHeight(world.heights, x, y));
    this.group.rotation.set(0, 0, this.angle);
    this.model.pose(this.action, this.time);
    this.clock += dt;
    const light = sampleLight(world.light, x, y, this.light);
    this.model.setLight(light, this.clock);
    // Players carry their weapons on the back in a safe zone (AreWeaponsOnBack).
    this.weaponsOnBack = !this.holdWeapons && (world.flags[this.cell.y * TERRAIN_SIZE + this.cell.x] & TerrainFlag.SAFEZONE) !== 0;
    for (const attachment of this.attachments) {
      attachment.place(this.model.matrices, this.weaponsOnBack, this.clock);
      attachment.model.setLight(light, this.clock);
    }
  }

  advance(dt) {
    let budget = WALK_CELLS_PER_SECOND * TERRAIN_SCALE * dt;
    while (budget > 0 && this.path.length) {
      const next = this.path[0];
      const target = new THREE.Vector2(cellCenter(next.x), cellCenter(next.y));
      const delta = target.clone().sub(this.position);
      const distance = delta.length();
      if (distance > 1) this.angle = Math.atan2(delta.x, -delta.y); // CreateAngle (Engine/AI/AngleMath.cpp)
      if (distance <= budget) {
        this.position.copy(target);
        this.cell = { x: next.x, y: next.y };
        this.path.shift();
        budget -= distance;
      } else {
        this.position.add(delta.multiplyScalar(budget / distance));
        budget = 0;
      }
    }
  }
}

export async function createPlayerCharacter({ id, name, bodySet, equipment, kind = 'player' }) {
  const [model, attachments] = await Promise.all([createPlayerModel(bodySet, equipment), createAttachments(equipment)]);
  const character = new Character({
    id, name, kind, model,
    actions: { stop: PlayerAction.STOP, walk: PlayerAction.WALK },
    keysPerSecond: (action) => PLAYER_KEYS_PER_SECOND[action],
  });
  character.setAttachments(attachments);
  character.equipment = equipment ?? {};
  return character;
}

const DEFAULT_NPC_BODY_SET = 2;

export async function createMonsterCharacter({ id, type }) {
  const description = describeMonster(type);
  if (description.usesPlayerModel) {
    const character = await createPlayerCharacter({ id, name: description.name, bodySet: DEFAULT_NPC_BODY_SET, kind: description.kind });
    character.group.scale.setScalar(description.scale);
    return character;
  }
  return new Character({
    id,
    name: description.name,
    kind: description.kind,
    model: await createMonsterModel(description),
    scale: description.scale,
    actions: { stop: MonsterAction.STOP, walk: MonsterAction.WALK },
    keysPerSecond: (action) => description.keysPerSecond[action],
  });
}
