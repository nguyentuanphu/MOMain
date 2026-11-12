// Loads a world: terrain, walkability and the static objects placed on it.
// Lorencia's object types follow the model table of MapManager.cpp (world 0);
// the other worlds name their models Object01.bmd, Object02.bmd, ... by type + 1.

import * as THREE from 'three';
import { parseTerrainMapping, parseTerrainAttributes, parseTerrainHeight, parseWorldObjects } from './formats.js';
import { fetchBytes, loadModel, computeBoneMatrices, buildGeometries, createMaterial } from './bmd.js';
import { createTerrain, loadLightMap, sampleLight } from './terrain.js';

const LORENCIA_MODELS = [
  ['Tree', 0, 13], ['Grass', 20, 8], ['Stone', 30, 5], ['StoneStatue', 40, 3], ['SteelStatue', 43, 1],
  ['Tomb', 44, 3], ['FireLight', 50, 2], ['Bonfire', 52, 1], ['DoungeonGate', 55, 1], ['MerchantAnimal', 56, 2],
  ['TreasureDrum', 58, 1], ['TreasureChest', 59, 1], ['Ship', 60, 1], ['SteelWall', 65, 3], ['SteelDoor', 68, 1],
  ['StoneWall', 69, 6], ['StoneMuWall', 75, 4], ['Bridge', 80, 1], ['Fence', 81, 4], ['BridgeStone', 85, 1],
  ['StreetLight', 90, 1], ['Cannon', 91, 3], ['Curtain', 95, 1], ['Sign', 96, 2], ['Carriage', 98, 4],
  ['Straw', 102, 2], ['Waterspout', 105, 1], ['Well', 106, 4], ['Hanging', 110, 1], ['Stair', 111, 1],
  ['House', 115, 5], ['Tent', 120, 1], ['HouseWall', 121, 6], ['HouseEtc', 127, 3], ['Light', 130, 3],
  ['PoseBox', 133, 1], ['Furniture', 140, 7], ['Candle', 150, 1], ['Beer', 151, 3],
];

const MAX_WORLD_OBJECTS = 160;
const DEGREES = Math.PI / 180;

function modelFileName(name, number) {
  return `${name}${String(number).padStart(2, '0')}.bmd`;
}

export function worldModelFiles(worldNumber) {
  const files = new Map();
  if (worldNumber === 1) {
    for (const [name, firstType, count] of LORENCIA_MODELS) {
      for (let i = 0; i < count; i++) files.set(firstType + i, modelFileName(name, i + 1));
    }
  } else {
    for (let type = 0; type < MAX_WORLD_OBJECTS; type++) files.set(type, modelFileName('Object', type + 1));
  }
  return files;
}

export async function loadWorldData(worldNumber) {
  const dir = `World${worldNumber}`;
  const [mapBytes, attBytes, objBytes, heightBytes, light] = await Promise.all([
    fetchBytes(`/data/${dir}/EncTerrain${worldNumber}.map`),
    fetchBytes(`/data/${dir}/EncTerrain${worldNumber}.att`),
    fetchBytes(`/data/${dir}/EncTerrain${worldNumber}.obj`),
    fetchBytes(`/data/${dir}/TerrainHeight.OZB`),
    loadLightMap(`${dir}/TerrainLight.jpg`),
  ]);
  return {
    worldNumber,
    dir,
    mapping: parseTerrainMapping(mapBytes),
    flags: parseTerrainAttributes(attBytes),
    heights: parseTerrainHeight(heightBytes),
    objects: parseWorldObjects(objBytes).objects,
    light,
  };
}

function objectMatrix(object) {
  const [x, y, z] = object.position;
  const rotation = new THREE.Euler(object.angle[0] * DEGREES, object.angle[1] * DEGREES, object.angle[2] * DEGREES, 'ZYX');
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(rotation),
    new THREE.Vector3(object.scale, object.scale, object.scale),
  );
}

// One instanced mesh per model mesh, so the 2,000+ objects of a map draw in a few hundred calls.
async function buildObjectType(objectDir, fileName, placements, light) {
  let model;
  try {
    model = await loadModel(objectDir, fileName);
  } catch (error) {
    console.warn('Model missing:', `${objectDir}/${fileName}`, error.message);
    return [];
  }
  const parts = buildGeometries(model, computeBoneMatrices(model, 0, 0));
  const color = new THREE.Color();
  return Promise.all(parts.map(async (part) => {
    const material = await createMaterial(objectDir, part.textureName);
    const mesh = new THREE.InstancedMesh(part.geometry, material, placements.length);
    placements.forEach((object, index) => {
      mesh.setMatrixAt(index, objectMatrix(object));
      mesh.setColorAt(index, sampleLight(light, object.position[0], object.position[1], color));
    });
    mesh.computeBoundingSphere();
    mesh.userData.model = fileName;
    return mesh;
  }));
}

export async function createWorld(data, fog, onProgress) {
  const group = new THREE.Group();
  const terrain = await createTerrain({ worldDir: data.dir, heights: data.heights, mapping: data.mapping, light: data.light, fog });
  group.add(terrain);

  const files = worldModelFiles(data.worldNumber);
  const byType = new Map();
  for (const object of data.objects) {
    if (!files.has(object.type)) continue;
    if (!byType.has(object.type)) byType.set(object.type, []);
    byType.get(object.type).push(object);
  }
  const objectDir = `Object${data.worldNumber}`;
  let done = 0;
  await Promise.all([...byType].map(async ([type, placements]) => {
    const meshes = await buildObjectType(objectDir, files.get(type), placements, data.light);
    meshes.forEach((mesh) => group.add(mesh));
    onProgress?.(++done / byType.size);
  }));
  return { group, terrain };
}
