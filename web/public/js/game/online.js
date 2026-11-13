// Keeps the map in sync with the game server: who is in view, where they walk, and
// sends the player's own walks. Mirrors the client's handlers in WSclient.cpp
// (ReceiveCreateMonsterViewport, ReceiveCreatePlayerViewportExtended,
// ReceiveDeleteCharacterViewport, ReceiveMoveCharacter).

import { read, packetCode } from '../net/packets.js';
import { classOfAppearance } from '../net/session.js';
import { parseAppearance } from './items.js';
import { createMonsterCharacter, createPlayerCharacter } from './characters.js';
import { findPath, directionBetween } from './pathfinding.js';

const ID_MASK = 0x7fff;          // the high bit marks "just created" (WSclient.cpp: Key &= 0x7FFF)
const MAX_STEPS_PER_WALK = 15;   // the step count is a 4-bit field
const PING_INTERVAL_MS = 20000;

const Code = { ADD_PLAYERS: 0x12, ADD_NPCS: 0x13, OUT_OF_SCOPE: 0x14, MOVED: 0x15, WALKED: 0xd4, PING_REQUEST: 0x71 };

export class OnlineWorld {
  constructor({ connection, root, world, hero, playerId, onChange }) {
    this.connection = connection;
    this.root = root;
    this.world = world;
    this.hero = hero;
    this.playerId = playerId & ID_MASK;
    this.characters = new Map();
    this.pending = new Set();
    this.onChange = onChange;
    this.unsubscribe = connection.onPacket((bytes) => this.handle(bytes));
    this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
  }

  handle(bytes) {
    const { code } = packetCode(bytes);
    try {
      if (code === Code.ADD_NPCS && bytes[0] === 0xc2) this.addNpcs(read('ServerToClient', 'AddNpcsToScope', bytes));
      else if (code === Code.ADD_PLAYERS && bytes[0] === 0xc2) this.addPlayer(read('ServerToClient', 'AddCharacterToScopeExtended', bytes));
      else if (code === Code.OUT_OF_SCOPE && bytes[0] === 0xc1) this.remove(read('ServerToClient', 'MapObjectOutOfScope', bytes));
      else if (code === Code.WALKED && bytes[0] === 0xc1) this.walked(read('ServerToClient', 'ObjectWalkedExtended', bytes));
      else if (code === Code.MOVED && bytes[0] === 0xc1) this.moved(read('ServerToClient', 'ObjectMoved', bytes));
      else if (code === Code.PING_REQUEST && bytes[0] === 0xc1) this.connection.send('ClientToServer', 'PingResponse');
    } catch (error) {
      console.warn('Packet not handled:', error);
    }
  }

  async spawn(id, create, placement) {
    if (id === this.playerId || this.characters.has(id) || this.pending.has(id)) return;
    this.pending.add(id);
    try {
      const character = await create();
      if (!this.pending.has(id)) return; // went out of view while loading
      character.placeAt(placement.x, placement.y, placement.rotation);
      if (placement.targetX !== placement.x || placement.targetY !== placement.y) character.walkStraightTo(placement.targetX, placement.targetY);
      this.characters.set(id, character);
      this.root.add(character.group);
      this.onChange?.();
    } catch (error) {
      console.warn(`Couldn't show object ${id}:`, error.message);
    } finally {
      this.pending.delete(id);
    }
  }

  addNpcs(packet) {
    for (const npc of packet.NPCs) {
      const id = npc.Id & ID_MASK;
      this.spawn(id, () => createMonsterCharacter({ id, type: npc.TypeNumber }), {
        x: npc.CurrentPositionX, y: npc.CurrentPositionY, targetX: npc.TargetPositionX, targetY: npc.TargetPositionY, rotation: npc.Rotation,
      });
    }
  }

  addPlayer(player) {
    const id = player.Id & ID_MASK;
    const bodySet = classOfAppearance(player.AppearanceAndEffects) + 1;
    const { equipment } = parseAppearance(player.AppearanceAndEffects);
    this.spawn(id, () => createPlayerCharacter({ id, name: player.Name, bodySet, equipment }), {
      x: player.CurrentPositionX, y: player.CurrentPositionY, targetX: player.TargetPositionX, targetY: player.TargetPositionY, rotation: player.Rotation,
    });
  }

  remove(packet) {
    for (const { Id } of packet.Objects) {
      const id = Id & ID_MASK;
      this.pending.delete(id);
      const character = this.characters.get(id);
      if (!character) continue;
      this.root.remove(character.group);
      this.characters.delete(id);
    }
    this.onChange?.();
  }

  walked(packet) {
    const character = this.characters.get(packet.ObjectId & ID_MASK);
    character?.walkStraightTo(packet.TargetX, packet.TargetY);
  }

  moved(packet) {
    const id = packet.ObjectId & ID_MASK;
    if (id === this.playerId) this.goal = null;
    const character = id === this.playerId ? this.hero : this.characters.get(id);
    character?.placeAt(packet.PositionX, packet.PositionY);
  }

  // Walks the player to a cell and tells the server, as the client's SendRequestMove does.
  // A walk packet holds at most 15 steps; longer walks continue when a part ends.
  walkTo(cell) {
    this.goal = { x: cell.x, y: cell.y };
    return this.walkNextPart();
  }

  walkNextPart() {
    const cell = this.goal;
    if (!cell || (cell.x === this.hero.cell.x && cell.y === this.hero.cell.y)) { this.goal = null; return false; }
    const path = findPath(this.world.flags, this.hero.cell, cell).slice(0, MAX_STEPS_PER_WALK);
    if (!path.length) { this.goal = null; return false; }
    const directions = new Uint8Array(Math.ceil(path.length / 2));
    let previous = this.hero.cell;
    path.forEach((step, index) => {
      const direction = directionBetween(previous, step);
      directions[index >> 1] |= index % 2 === 0 ? direction << 4 : direction;
      previous = step;
    });
    const last = directionBetween(path.length > 1 ? path[path.length - 2] : this.hero.cell, path[path.length - 1]);
    this.connection.send('ClientToServer', 'WalkRequest', {
      SourceX: this.hero.cell.x, SourceY: this.hero.cell.y, StepCount: path.length, TargetRotation: last, Directions: directions,
    });
    this.hero.walk(path);
    return true;
  }

  ping() {
    this.connection.send('ClientToServer', 'Ping', { TickCount: Math.floor(performance.now()) >>> 0, AttackSpeed: 0, MagicSpeed: 0 });
  }

  update(dt) {
    if (this.goal && !this.hero.isWalking) this.walkNextPart();
    for (const character of this.characters.values()) character.update(dt, this.world);
  }

  dispose() {
    clearInterval(this.pingTimer);
    this.unsubscribe();
    for (const character of this.characters.values()) this.root.remove(character.group);
    this.characters.clear();
  }
}
