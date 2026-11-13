// Characters on the map: the player, other players, NPCs and monsters. Each one is an
// animated model that walks from cell to cell like the client's characters do.

import * as THREE from 'three';
import { TERRAIN_SCALE } from '../formats.js';
import { loadModel, buildGeometries, computeBoneMatrices, createMaterial, AnimatedModel } from '../bmd.js';
import { sampleHeight, sampleLight } from '../terrain.js';
import { describeMonster, MonsterAction } from './monsterData.js';

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

export async function createPlayerModel(bodySet) {
  const skeleton = await loadModel('Player', 'player.bmd');
  const pose = computeBoneMatrices(skeleton, PlayerAction.STOP, 0);
  const number = String(bodySet).padStart(2, '0');
  const parts = [];
  const materials = [];
  for (const part of BODY_PARTS) {
    try {
      const model = await loadModel('Player', `${part}Class${number}.bmd`);
      for (const geometry of buildGeometries(model, pose)) {
        parts.push(geometry);
        materials.push(await createMaterial('Player', geometry.textureName));
      }
    } catch (error) {
      console.warn(`Body part ${part}Class${number} missing`, error.message);
    }
  }
  return new AnimatedModel(skeleton, parts, materials);
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
    this.model.setLight(sampleLight(world.light, x, y, this.light));
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

export async function createPlayerCharacter({ id, name, bodySet, kind = 'player' }) {
  return new Character({
    id, name, kind,
    model: await createPlayerModel(bodySet),
    actions: { stop: PlayerAction.STOP, walk: PlayerAction.WALK },
    keysPerSecond: (action) => PLAYER_KEYS_PER_SECOND[action],
  });
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
