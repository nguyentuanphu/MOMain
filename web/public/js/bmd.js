// Turns parsed BMD models into three.js geometry and materials.
// Bone math follows the client: each key's rotation is an Euler angle in radians
// turned into a quaternion as in AngleQuaternion (Core/Math), which matches
// three.js' 'ZYX' Euler order; a bone's matrix is its parent's times its own.

import * as THREE from 'three';
import { parseBMD, decodeTGA } from './formats.js';

const ALPHA_TEST = 0.25;

const fileCache = new Map();
const textureCache = new Map();

export async function fetchBytes(url) {
  if (!fileCache.has(url)) {
    fileCache.set(url, fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return new Uint8Array(await response.arrayBuffer());
    }));
  }
  return fileCache.get(url);
}

export async function loadModel(dir, fileName) {
  const bytes = await fetchBytes(`/data/${dir}/${fileName}`);
  return parseBMD(bytes);
}

// Texture scripts in the file name (TextureScript.cpp): the letters after the first
// "_" can be R (bright), H (hidden mesh), S (stream mesh) and N (no blending).
// Hair is drawn as hair, not bright, like the client's IsHair textures.
function textureKind(name) {
  const lower = name.toLowerCase();
  const underscore = name.indexOf('_');
  const script = underscore < 0 ? '' : name.slice(underscore + 1, underscore + 5).split('.')[0];
  const isHair = lower.startsWith('hair');
  return {
    isTga: lower.endsWith('.tga'),
    additive: script.includes('R') && !script.includes('N') && !isHair,
    hidden: script.includes('H'),
  };
}

async function decodeTexture(url, isTga) {
  const bytes = await fetchBytes(url);
  if (isTga) {
    const { width, height, pixels } = decodeTGA(bytes);
    const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat);
    texture.needsUpdate = true;
    return texture;
  }
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  const texture = new THREE.Texture(bitmap);
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

function loadTextureFrom(dir, name) {
  const url = `/data/${dir}/${name}`;
  if (!textureCache.has(url)) {
    const { isTga } = textureKind(name);
    textureCache.set(url, decodeTexture(url, isTga).then((texture) => {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      return texture;
    }).catch(() => null));
  }
  return textureCache.get(url);
}

// A texture comes from the first of the folders that has it (LoadTextureFromFolders).
export async function loadTexture(dirs, name) {
  const folders = Array.isArray(dirs) ? dirs : [dirs];
  for (const dir of folders) {
    const texture = await loadTextureFrom(dir, name);
    if (texture) return texture;
  }
  console.warn('Texture missing:', name, 'in', folders.join(', '));
  return null;
}

// Meshes whose texture name starts with "hid" are never drawn (Data::Items::IsHiddenTexture).
const HIDDEN_TEXTURE_PREFIX = 'hid';

export async function createMaterial(dir, textureName, { glow = false } = {}) {
  const { isTga, additive: additiveByName, hidden } = textureKind(textureName);
  const additive = glow || additiveByName;
  if (hidden || textureName.startsWith(HIDDEN_TEXTURE_PREFIX)) return new THREE.MeshBasicMaterial({ visible: false });
  const map = await loadTexture(dir, textureName);
  const material = new THREE.MeshBasicMaterial({ map, color: 0xffffff, side: THREE.DoubleSide });
  if (!map) material.color.set(0x808080);
  if (additive) {
    Object.assign(material, { blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
  } else if (isTga) {
    material.alphaTest = ALPHA_TEST;
  }
  return material;
}

// ---------- bones ----------

const tmpQuatA = new THREE.Quaternion();
const tmpQuatB = new THREE.Quaternion();
const tmpEuler = new THREE.Euler(0, 0, 0, 'ZYX');
const tmpPos = new THREE.Vector3();
const tmpPosB = new THREE.Vector3();
const unitScale = new THREE.Vector3(1, 1, 1);

function boneKey(frames, key, outPosition, outQuaternion) {
  const i = key * 3;
  outPosition.set(frames.positions[i], frames.positions[i + 1], frames.positions[i + 2]);
  tmpEuler.set(frames.rotations[i], frames.rotations[i + 1], frames.rotations[i + 2], 'ZYX');
  outQuaternion.setFromEuler(tmpEuler);
}

// World matrices of every bone for an action at a (fractional, looping) key.
export function computeBoneMatrices(model, actionIndex, time, out) {
  const action = model.actions[actionIndex] ? actionIndex : 0;
  const numKeys = Math.max(1, model.actions[action]?.numKeys || 1);
  const k0 = Math.floor(time) % numKeys;
  const k1 = (k0 + 1) % numKeys;
  const t = time - Math.floor(time);
  const matrices = out || model.bones.map(() => new THREE.Matrix4());
  model.bones.forEach((bone, index) => {
    const local = matrices[index];
    if (bone.dummy || !bone.frames[action] || bone.frames[action].positions.length === 0) {
      local.identity();
    } else {
      const frames = bone.frames[action];
      boneKey(frames, k0, tmpPos, tmpQuatA);
      boneKey(frames, k1, tmpPosB, tmpQuatB);
      tmpPos.lerp(tmpPosB, t);
      tmpQuatA.slerp(tmpQuatB, t);
      local.compose(tmpPos, tmpQuatA, unitScale);
    }
    if (bone.parent >= 0 && bone.parent < index) local.premultiply(matrices[bone.parent]);
  });
  return matrices;
}

// ---------- geometry ----------

const TRIANGLE_FAN = [[0, 1, 2], [0, 2, 3]];

// Expands a mesh's triangles and quads into flat vertex arrays. Keeps each vertex's
// bone and bind position (and normal), so an animated model can be re-posed every frame.
function expandMesh(mesh) {
  const nodes = [];
  const local = [];
  const normalNodes = [];
  const localNormals = [];
  const uvs = [];
  for (const tri of mesh.triangles) {
    const fans = tri.corners === 4 ? TRIANGLE_FAN : TRIANGLE_FAN.slice(0, 1);
    for (const fan of fans) {
      for (const corner of fan) {
        const vertex = mesh.vertices[tri.vertex[corner]];
        if (!vertex) continue;
        const uv = mesh.texCoords[tri.texCoord[corner]] || [0, 0];
        const normal = mesh.normals[tri.normal[corner]] || { node: vertex.node, normal: [0, 0, 1] };
        nodes.push(vertex.node);
        local.push(vertex.position[0], vertex.position[1], vertex.position[2]);
        normalNodes.push(normal.node);
        localNormals.push(normal.normal[0], normal.normal[1], normal.normal[2]);
        uvs.push(uv[0], uv[1]);
      }
    }
  }
  return {
    nodes: Int16Array.from(nodes), local: Float32Array.from(local),
    normalNodes: Int16Array.from(normalNodes), localNormals: Float32Array.from(localNormals),
    uvs: Float32Array.from(uvs),
  };
}

const tmpVec = new THREE.Vector3();
const tmpNormalMatrix = new THREE.Matrix3();

export function poseVertices(skin, boneMatrices, positions) {
  for (let i = 0; i < skin.nodes.length; i++) {
    tmpVec.set(skin.local[i * 3], skin.local[i * 3 + 1], skin.local[i * 3 + 2]);
    const bone = boneMatrices[skin.nodes[i]];
    if (bone) tmpVec.applyMatrix4(bone);
    positions[i * 3] = tmpVec.x;
    positions[i * 3 + 1] = tmpVec.y;
    positions[i * 3 + 2] = tmpVec.z;
  }
}

// Normals turn with their bone (rotation only), for the chrome glow passes.
export function poseNormals(skin, boneMatrices, normals) {
  for (let i = 0; i < skin.normalNodes.length; i++) {
    tmpVec.set(skin.localNormals[i * 3], skin.localNormals[i * 3 + 1], skin.localNormals[i * 3 + 2]);
    const bone = boneMatrices[skin.normalNodes[i]];
    if (bone) tmpVec.applyMatrix3(tmpNormalMatrix.setFromMatrix4(bone));
    normals[i * 3] = tmpVec.x;
    normals[i * 3 + 1] = tmpVec.y;
    normals[i * 3 + 2] = tmpVec.z;
  }
}

// One geometry per mesh of the model, posed with the given bone matrices.
export function buildGeometries(model, boneMatrices) {
  return model.meshes.map((mesh, meshIndex) => {
    const skin = expandMesh(mesh);
    const positions = new Float32Array(skin.local.length);
    const normals = new Float32Array(skin.localNormals.length);
    poseVertices(skin, boneMatrices, positions);
    poseNormals(skin, boneMatrices, normals);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(skin.uvs, 2));
    geometry.computeBoundingSphere();
    return { geometry, skin, textureName: mesh.textureName, meshIndex };
  });
}

// An animated model whose meshes follow a skeleton (its own, or a shared one such as Player.bmd).
// Glow passes are extra meshes on the same geometry (see game/itemGlow.js).
export class AnimatedModel {
  constructor(skeleton, parts, materials) {
    this.skeleton = skeleton;
    this.group = new THREE.Group();
    this.matrices = computeBoneMatrices(skeleton, 0, 0);
    this.parts = [];
    this.glows = [];
    this.lightFactor = null; // a function of time giving the light multiplier of the item level
    parts.forEach((part, index) => {
      const mesh = new THREE.Mesh(part.geometry, materials[index]);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.parts.push({ ...part, mesh });
    });
  }

  pose(actionIndex, time) {
    computeBoneMatrices(this.skeleton, actionIndex, time, this.matrices);
    const withNormals = this.glows.length > 0;
    for (const part of this.parts) {
      const attribute = part.geometry.getAttribute('position');
      poseVertices(part.skin, this.matrices, attribute.array);
      attribute.needsUpdate = true;
      if (withNormals) {
        const normals = part.geometry.getAttribute('normal');
        poseNormals(part.skin, this.matrices, normals.array);
        normals.needsUpdate = true;
      }
    }
  }

  addGlow(glow) {
    this.glows.push(glow);
    for (const mesh of glow.meshes) this.group.add(mesh);
  }

  setLight(color, seconds = 0) {
    for (const part of this.parts) {
      if (part.mesh.material.blending === THREE.AdditiveBlending) continue;
      part.mesh.material.color.copy(color);
      const factor = part.lightFactor?.(seconds);
      if (factor) part.mesh.material.color.multiply(factor);
    }
    for (const glow of this.glows) glow.update(seconds);
  }
}
