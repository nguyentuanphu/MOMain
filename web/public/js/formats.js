// Parsers for the client's binary data formats, ported from the C++ loaders:
//   MapFileDecrypt / BuxConvert   Render/Terrain/ZzzLodTerrain.h, Core/Globals/_crypt.h
//   EncTerrainN.map / .att        Render/Terrain/ZzzLodTerrain.cpp (OpenTerrainMapping, OpenTerrainAttribute)
//   EncTerrainN.obj               Engine/Object/ZzzObject.cpp (OpenObjectsEnc)
//   TerrainHeight.OZB             Render/Terrain/ZzzLodTerrain.cpp (OpenTerrainHeight)
//   *.bmd (version 10 and 12)     Render/Models/ZzzBMD.cpp (BMD::Open2)

export const TERRAIN_SIZE = 256;
export const TERRAIN_SCALE = 100;
export const NO_LAYER = 255;

const MAP_XOR_KEY = [0xd1, 0x73, 0x52, 0xf6, 0xd2, 0x9a, 0xcb, 0x27, 0x3e, 0xaf, 0x59, 0x31, 0x37, 0xb3, 0xe7, 0xa2];
const MAP_KEY_START = 0x5e;
const MAP_KEY_STEP = 0x3d;
const BUX_CODE = [0xfc, 0xcf, 0xab];

export function mapFileDecrypt(source) {
  const out = new Uint8Array(source.length);
  let key = MAP_KEY_START;
  for (let i = 0; i < source.length; i++) {
    out[i] = ((source[i] ^ MAP_XOR_KEY[i % 16]) - key) & 0xff;
    key = (source[i] + MAP_KEY_STEP) & 0xff;
  }
  return out;
}

export function buxConvert(buffer) {
  for (let i = 0; i < buffer.length; i++) buffer[i] ^= BUX_CODE[i % 3];
  return buffer;
}

const CELLS = TERRAIN_SIZE * TERRAIN_SIZE;

// EncTerrainN.map: version, map number, two texture layers and the blend alpha per cell.
export function parseTerrainMapping(encrypted) {
  const data = mapFileDecrypt(encrypted);
  let p = 2;
  const layer1 = data.slice(p, p + CELLS); p += CELLS;
  const layer2 = data.slice(p, p + CELLS); p += CELLS;
  const alpha = data.slice(p, p + CELLS);
  return { mapNumber: data[1], layer1, layer2, alpha };
}

// EncTerrainN.att: walkability flags per cell (one byte, or a WORD in the extended format).
export function parseTerrainAttributes(encrypted) {
  const data = buxConvert(mapFileDecrypt(encrypted));
  const flags = new Uint16Array(CELLS);
  const wide = data.length === CELLS * 2 + 4;
  const view = new DataView(data.buffer);
  for (let i = 0; i < CELLS; i++) flags[i] = wide ? view.getUint16(4 + i * 2, true) : data[4 + i];
  return flags;
}

export const TerrainFlag = { SAFEZONE: 0x01, NOMOVE: 0x04, NOGROUND: 0x08, WATER: 0x10 };

const OZB_PREFIX_BYTES = 4;
const BMP_HEADER_BYTES = 1080;
const HEIGHT_FACTOR = 1.5;

// TerrainHeight.OZB: an 8-bit grayscale BMP after a 4-byte prefix; each level is 1.5 units.
export function parseTerrainHeight(bytes) {
  const heights = new Float32Array(CELLS);
  const start = OZB_PREFIX_BYTES + BMP_HEADER_BYTES;
  for (let i = 0; i < CELLS; i++) heights[i] = bytes[start + i] * HEIGHT_FACTOR;
  return heights;
}

const OBJECT_RECORD_BYTES = 2 + 12 + 12 + 4;

// EncTerrainN.obj: the static world objects, each a model type with position, angles (degrees) and scale.
export function parseWorldObjects(encrypted) {
  const data = mapFileDecrypt(encrypted);
  const view = new DataView(data.buffer);
  const count = view.getInt16(2, true);
  const objects = [];
  let p = 4;
  for (let i = 0; i < count && p + OBJECT_RECORD_BYTES <= data.length; i++, p += OBJECT_RECORD_BYTES) {
    objects.push({
      type: view.getInt16(p, true),
      position: [view.getFloat32(p + 2, true), view.getFloat32(p + 6, true), view.getFloat32(p + 10, true)],
      angle: [view.getFloat32(p + 14, true), view.getFloat32(p + 18, true), view.getFloat32(p + 22, true)],
      scale: view.getFloat32(p + 26, true),
    });
  }
  return { mapNumber: data[1], objects };
}

// ---------- BMD models ----------

const BMD_VERSION_PLAIN = 0x0a;
const BMD_VERSION_ENCRYPTED = 0x0c;
const NAME_BYTES = 32;
const VERTEX_BYTES = 16;     // short Node, (pad), vec3 Position
const NORMAL_BYTES = 20;     // short Node, (pad), vec3 Normal, short BindVertex, (pad)
const TEXCOORD_BYTES = 8;    // float U, float V
const TRIANGLE_BYTES = 64;   // sizeof(Triangle_t2), the record size on disk

function readName(bytes, offset) {
  let end = offset;
  while (end < offset + NAME_BYTES && bytes[end] !== 0) end++;
  return new TextDecoder('latin1').decode(bytes.subarray(offset, end));
}

function bmdBody(fileBytes) {
  if (fileBytes[0] !== 0x42 || fileBytes[1] !== 0x4d || fileBytes[2] !== 0x44) throw new Error('Not a BMD file');
  const version = fileBytes[3];
  if (version === BMD_VERSION_PLAIN) return fileBytes.subarray(4);
  if (version === BMD_VERSION_ENCRYPTED) {
    const size = new DataView(fileBytes.buffer, fileBytes.byteOffset).getInt32(4, true);
    return mapFileDecrypt(fileBytes.subarray(8, 8 + size));
  }
  throw new Error(`BMD version ${version} is not supported yet`);
}

export function parseBMD(fileBytes) {
  const bytes = bmdBody(fileBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const name = readName(bytes, p); p += NAME_BYTES;
  const numMeshes = view.getInt16(p, true); p += 2;
  const numBones = view.getInt16(p, true); p += 2;
  const numActions = view.getInt16(p, true); p += 2;

  const meshes = [];
  for (let m = 0; m < numMeshes; m++) {
    const numVertices = view.getInt16(p, true);
    const numNormals = view.getInt16(p + 2, true);
    const numTexCoords = view.getInt16(p + 4, true);
    const numTriangles = view.getInt16(p + 6, true);
    const texture = view.getInt16(p + 8, true);
    p += 10;
    const vertices = [];
    for (let i = 0; i < numVertices; i++, p += VERTEX_BYTES) {
      vertices.push({ node: view.getInt16(p, true), position: [view.getFloat32(p + 4, true), view.getFloat32(p + 8, true), view.getFloat32(p + 12, true)] });
    }
    const normals = [];
    for (let i = 0; i < numNormals; i++, p += NORMAL_BYTES) {
      normals.push({ node: view.getInt16(p, true), normal: [view.getFloat32(p + 4, true), view.getFloat32(p + 8, true), view.getFloat32(p + 12, true)] });
    }
    const texCoords = [];
    for (let i = 0; i < numTexCoords; i++, p += TEXCOORD_BYTES) texCoords.push([view.getFloat32(p, true), view.getFloat32(p + 4, true)]);
    const triangles = [];
    for (let i = 0; i < numTriangles; i++, p += TRIANGLE_BYTES) {
      const corners = view.getInt8(p);
      const tri = { corners, vertex: [], normal: [], texCoord: [] };
      for (let k = 0; k < 4; k++) {
        tri.vertex.push(view.getInt16(p + 2 + k * 2, true));
        tri.normal.push(view.getInt16(p + 10 + k * 2, true));
        tri.texCoord.push(view.getInt16(p + 18 + k * 2, true));
      }
      triangles.push(tri);
    }
    const textureName = readName(bytes, p); p += NAME_BYTES;
    meshes.push({ texture, textureName, vertices, normals, texCoords, triangles });
  }

  const actions = [];
  for (let a = 0; a < numActions; a++) {
    const numKeys = view.getInt16(p, true);
    const lockPositions = bytes[p + 2] !== 0;
    p += 3;
    if (lockPositions && numKeys > 0) p += numKeys * 12;
    actions.push({ numKeys });
  }

  const bones = [];
  for (let b = 0; b < numBones; b++) {
    const dummy = bytes[p] !== 0; p += 1;
    if (dummy) { bones.push({ dummy: true, parent: -1, frames: [] }); continue; }
    const boneName = readName(bytes, p); p += NAME_BYTES;
    const parent = view.getInt16(p, true); p += 2;
    const frames = [];
    for (let a = 0; a < numActions; a++) {
      const keys = actions[a].numKeys;
      const positions = new Float32Array(keys * 3);
      const rotations = new Float32Array(keys * 3);
      for (let k = 0; k < keys * 3; k++) positions[k] = view.getFloat32(p + k * 4, true);
      p += keys * 12;
      for (let k = 0; k < keys * 3; k++) rotations[k] = view.getFloat32(p + k * 4, true);
      p += keys * 12;
      frames.push({ positions, rotations });
    }
    bones.push({ dummy: false, name: boneName, parent, frames });
  }

  return { name, meshes, actions, bones };
}

// ---------- TGA ----------

const TGA_UNCOMPRESSED_TRUECOLOR = 2;
const TGA_RLE_TRUECOLOR = 10;
const TGA_ORIGIN_TOP = 0x20;

// Decodes a truecolor TGA into top-down RGBA rows.
export function decodeTGA(bytes) {
  const idLength = bytes[0];
  const imageType = bytes[2];
  const width = bytes[12] | (bytes[13] << 8);
  const height = bytes[14] | (bytes[15] << 8);
  const bitsPerPixel = bytes[16];
  const descriptor = bytes[17];
  if (imageType !== TGA_UNCOMPRESSED_TRUECOLOR && imageType !== TGA_RLE_TRUECOLOR) throw new Error(`TGA type ${imageType} is not supported`);
  const pixelBytes = bitsPerPixel / 8;
  const pixels = new Uint8Array(width * height * 4);
  let src = 18 + idLength;
  let dst = 0;
  const putPixel = (at) => {
    pixels[dst] = bytes[at + 2];
    pixels[dst + 1] = bytes[at + 1];
    pixels[dst + 2] = bytes[at];
    pixels[dst + 3] = pixelBytes === 4 ? bytes[at + 3] : 255;
    dst += 4;
  };
  const total = width * height * 4;
  if (imageType === TGA_UNCOMPRESSED_TRUECOLOR) {
    while (dst < total) { putPixel(src); src += pixelBytes; }
  } else {
    while (dst < total) {
      const header = bytes[src++];
      const run = (header & 0x7f) + 1;
      if (header & 0x80) { for (let i = 0; i < run; i++) putPixel(src); src += pixelBytes; }
      else { for (let i = 0; i < run; i++) { putPixel(src); src += pixelBytes; } }
    }
  }
  if (!(descriptor & TGA_ORIGIN_TOP)) flipRows(pixels, width, height);
  return { width, height, pixels };
}

function flipRows(pixels, width, height) {
  const row = width * 4;
  const temp = new Uint8Array(row);
  for (let y = 0; y < height >> 1; y++) {
    const a = y * row, b = (height - 1 - y) * row;
    temp.set(pixels.subarray(a, a + row));
    pixels.copyWithin(a, b, b + row);
    pixels.set(temp, b);
  }
}
