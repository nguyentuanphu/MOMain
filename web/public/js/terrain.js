// The terrain: a 256x256 height grid with two texture layers per cell, blended by a
// per-vertex alpha and lit by the map's baked light map (TerrainLight).
// A tile texture repeats every (texture width / 64) cells, as in ZzzLodTerrain.cpp.

import * as THREE from 'three';
import { TERRAIN_SIZE, TERRAIN_SCALE, NO_LAYER } from './formats.js';
import { fetchBytes } from './bmd.js';

const ATLAS_COLUMNS = 8;
const ATLAS_ROWS = 4;
const ATLAS_SLOT = 256;
const TILE_TEXELS_PER_CELL = 64;
const MAX_TILES = ATLAS_COLUMNS * ATLAS_ROWS;

// The order of BITMAP_MAPTILE + n in MapManager.cpp.
export function tileFileNames(worldDir) {
  const names = ['TileGrass01', 'TileGrass02', 'TileGround01', 'TileGround02', 'TileGround03', 'TileWater01',
    'TileWood01', 'TileRock01', 'TileRock02', 'TileRock03', 'TileRock04', 'TileRock05', 'TileRock06', 'TileRock07'];
  for (let i = 1; i <= 16; i++) names.push(`ExtTile${String(i).padStart(2, '0')}`);
  return names.map((name) => `${worldDir}/${name}.jpg`);
}

async function loadBitmap(url) {
  try {
    const bytes = await fetchBytes(`/data/${url}`);
    return await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  } catch {
    return null;
  }
}

async function buildAtlas(urls, usedTiles) {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLUMNS * ATLAS_SLOT;
  canvas.height = ATLAS_ROWS * ATLAS_SLOT;
  const context = canvas.getContext('2d');
  context.fillStyle = '#555';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const scales = new Float32Array(MAX_TILES).fill(TILE_TEXELS_PER_CELL / ATLAS_SLOT);
  const bitmaps = await Promise.all(urls.slice(0, MAX_TILES).map((url, index) => (usedTiles.has(index) ? loadBitmap(url) : null)));
  bitmaps.forEach((bitmap, index) => {
    if (!bitmap) return;
    const x = (index % ATLAS_COLUMNS) * ATLAS_SLOT;
    const y = Math.floor(index / ATLAS_COLUMNS) * ATLAS_SLOT;
    context.drawImage(bitmap, x, y, ATLAS_SLOT, ATLAS_SLOT);
    scales[index] = TILE_TEXELS_PER_CELL / bitmap.width;
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = false;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  return { texture, scales };
}

export async function loadLightMap(url) {
  const bitmap = await loadBitmap(url);
  const light = new Float32Array(TERRAIN_SIZE * TERRAIN_SIZE * 3).fill(1);
  if (!bitmap) return light;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TERRAIN_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, TERRAIN_SIZE, TERRAIN_SIZE);
  const { data } = context.getImageData(0, 0, TERRAIN_SIZE, TERRAIN_SIZE);
  for (let i = 0; i < TERRAIN_SIZE * TERRAIN_SIZE; i++) {
    light[i * 3] = data[i * 4] / 255;
    light[i * 3 + 1] = data[i * 4 + 1] / 255;
    light[i * 3 + 2] = data[i * 4 + 2] / 255;
  }
  return light;
}

function byteTexture(bytes, linear) {
  const texture = new THREE.DataTexture(bytes, TERRAIN_SIZE, TERRAIN_SIZE, THREE.RedFormat, THREE.UnsignedByteType);
  texture.magFilter = texture.minFilter = linear ? THREE.LinearFilter : THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

function lightTexture(light) {
  const bytes = new Uint8Array(TERRAIN_SIZE * TERRAIN_SIZE * 4);
  for (let i = 0; i < TERRAIN_SIZE * TERRAIN_SIZE; i++) {
    bytes[i * 4] = light[i * 3] * 255;
    bytes[i * 4 + 1] = light[i * 3 + 1] * 255;
    bytes[i * 4 + 2] = light[i * 3 + 2] * 255;
    bytes[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(bytes, TERRAIN_SIZE, TERRAIN_SIZE, THREE.RGBAFormat);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function buildGeometry(heights) {
  const count = TERRAIN_SIZE * TERRAIN_SIZE;
  const positions = new Float32Array(count * 3);
  const cells = new Float32Array(count * 2);
  for (let y = 0; y < TERRAIN_SIZE; y++) {
    for (let x = 0; x < TERRAIN_SIZE; x++) {
      const i = y * TERRAIN_SIZE + x;
      positions.set([x * TERRAIN_SCALE, y * TERRAIN_SCALE, heights[i]], i * 3);
      cells.set([x, y], i * 2);
    }
  }
  const indices = new Uint32Array((TERRAIN_SIZE - 1) * (TERRAIN_SIZE - 1) * 6);
  let p = 0;
  for (let y = 0; y < TERRAIN_SIZE - 1; y++) {
    for (let x = 0; x < TERRAIN_SIZE - 1; x++) {
      const a = y * TERRAIN_SIZE + x, b = a + 1, c = a + TERRAIN_SIZE, d = c + 1;
      indices.set([a, b, d, a, d, c], p);
      p += 6;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('cell', new THREE.BufferAttribute(cells, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

const vertexShader = /* glsl */ `
  attribute vec2 cell;
  varying vec2 vCell;
  varying float vDepth;
  void main() {
    vCell = cell;
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    vDepth = -viewPosition.z;
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D atlas;
  uniform sampler2D layer1Map;
  uniform sampler2D layer2Map;
  uniform sampler2D alphaMap;
  uniform sampler2D lightMap;
  uniform float tileScale[${MAX_TILES}];
  uniform float brightness;
  uniform vec3 fogColor;
  uniform float fogNear;
  uniform float fogFar;
  varying vec2 vCell;
  varying float vDepth;

  vec3 tileColor(float index, vec2 position) {
    int i = int(index);
    vec2 local = fract(position * tileScale[i]);
    vec2 slot = vec2(mod(index, ${ATLAS_COLUMNS}.0), floor(index / ${ATLAS_COLUMNS}.0));
    vec2 uv = (slot + 0.004 + local * 0.992) / vec2(${ATLAS_COLUMNS}.0, ${ATLAS_ROWS}.0);
    return texture2D(atlas, uv).rgb;
  }

  void main() {
    vec2 cellUv = (floor(vCell) + 0.5) / ${TERRAIN_SIZE}.0;
    vec2 vertexUv = (vCell + 0.5) / ${TERRAIN_SIZE}.0;
    float layer1 = floor(texture2D(layer1Map, cellUv).r * 255.0 + 0.5);
    float layer2 = floor(texture2D(layer2Map, cellUv).r * 255.0 + 0.5);
    vec3 color = tileColor(min(layer1, ${MAX_TILES - 1}.0), vCell);
    if (layer2 < ${NO_LAYER}.0) {
      float alpha = texture2D(alphaMap, vertexUv).r;
      color = mix(color, tileColor(min(layer2, ${MAX_TILES - 1}.0), vCell), alpha);
    }
    color *= texture2D(lightMap, vertexUv).rgb * brightness;
    float fog = smoothstep(fogNear, fogFar, vDepth);
    gl_FragColor = vec4(mix(color, fogColor, fog), 1.0);
    #include <colorspace_fragment>
  }
`;

function usedTileIndices(mapping) {
  const used = new Set(mapping.layer1);
  for (const index of mapping.layer2) if (index !== NO_LAYER) used.add(index);
  return used;
}

export async function createTerrain({ worldDir, heights, mapping, light, fog }) {
  const { texture, scales } = await buildAtlas(tileFileNames(worldDir), usedTileIndices(mapping));
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      atlas: { value: texture },
      layer1Map: { value: byteTexture(mapping.layer1, false) },
      layer2Map: { value: byteTexture(mapping.layer2, false) },
      alphaMap: { value: byteTexture(mapping.alpha, true) },
      lightMap: { value: lightTexture(light) },
      tileScale: { value: Array.from(scales) },
      brightness: { value: 1.0 },
      fogColor: { value: fog.color },
      fogNear: { value: fog.near },
      fogFar: { value: fog.far },
    },
  });
  const mesh = new THREE.Mesh(buildGeometry(heights), material);
  mesh.name = 'terrain';
  return mesh;
}

// Height at a world position (MU units), interpolated between the four corners of its cell.
export function sampleHeight(heights, x, y) {
  const fx = Math.min(Math.max(x / TERRAIN_SCALE, 0), TERRAIN_SIZE - 1.001);
  const fy = Math.min(Math.max(y / TERRAIN_SCALE, 0), TERRAIN_SIZE - 1.001);
  const xi = Math.floor(fx), yi = Math.floor(fy);
  const tx = fx - xi, ty = fy - yi;
  const h = (cx, cy) => heights[cy * TERRAIN_SIZE + cx];
  const top = h(xi, yi) * (1 - tx) + h(xi + 1, yi) * tx;
  const bottom = h(xi, yi + 1) * (1 - tx) + h(xi + 1, yi + 1) * tx;
  return top * (1 - ty) + bottom * ty;
}

export function sampleLight(light, x, y, out) {
  const xi = Math.min(Math.max(Math.round(x / TERRAIN_SCALE), 0), TERRAIN_SIZE - 1);
  const yi = Math.min(Math.max(Math.round(y / TERRAIN_SCALE), 0), TERRAIN_SIZE - 1);
  const i = (yi * TERRAIN_SIZE + xi) * 3;
  return out.setRGB(light[i], light[i + 1], light[i + 2]);
}
