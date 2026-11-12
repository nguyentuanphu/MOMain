// Turns parsed BMD models into three.js geometry and materials.
// Bone math follows the client: each key's rotation is an Euler angle in radians
// turned into a quaternion as in AngleQuaternion (Core/Math), which matches
// three.js' 'ZYX' Euler order; a bone's matrix is its parent's times its own.

import * as THREE from 'three';
import { parseBMD, decodeTGA } from './formats.js';

const ADDITIVE_SUFFIX = '_r';
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

function textureKind(name) {
  const lower = name.toLowerCase();
  const base = lower.replace(/\.[^.]+$/, '');
  return { isTga: lower.endsWith('.tga'), additive: base.endsWith(ADDITIVE_SUFFIX) };
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

export function loadTexture(dir, name) {
  const url = `/data/${dir}/${name}`;
  if (!textureCache.has(url)) {
    const { isTga } = textureKind(name);
    textureCache.set(url, decodeTexture(url, isTga).then((texture) => {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      return texture;
    }).catch((error) => {
      console.warn('Texture missing:', url, error.message);
      return null;
    }));
  }
  return textureCache.get(url);
}

export async function createMaterial(dir, textureName) {
  const { isTga, additive } = textureKind(textureName);
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
// bone and bind position, so an animated model can be re-posed every frame.
function expandMesh(mesh) {
  const nodes = [];
  const local = [];
  const uvs = [];
  for (const tri of mesh.triangles) {
    const fans = tri.corners === 4 ? TRIANGLE_FAN : TRIANGLE_FAN.slice(0, 1);
    for (const fan of fans) {
      for (const corner of fan) {
        const vertex = mesh.vertices[tri.vertex[corner]];
        const uv = mesh.texCoords[tri.texCoord[corner]] || [0, 0];
        if (!vertex) continue;
        nodes.push(vertex.node);
        local.push(vertex.position[0], vertex.position[1], vertex.position[2]);
        uvs.push(uv[0], uv[1]);
      }
    }
  }
  return { nodes: Int16Array.from(nodes), local: Float32Array.from(local), uvs: Float32Array.from(uvs) };
}

const tmpVec = new THREE.Vector3();

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

// One geometry per mesh of the model, posed with the given bone matrices.
export function buildGeometries(model, boneMatrices) {
  return model.meshes.map((mesh) => {
    const skin = expandMesh(mesh);
    const positions = new Float32Array(skin.local.length);
    poseVertices(skin, boneMatrices, positions);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(skin.uvs, 2));
    geometry.computeBoundingSphere();
    return { geometry, skin, textureName: mesh.textureName };
  });
}

// An animated model whose meshes follow a skeleton (its own, or a shared one such as Player.bmd).
export class AnimatedModel {
  constructor(skeleton, parts, materials) {
    this.skeleton = skeleton;
    this.group = new THREE.Group();
    this.matrices = computeBoneMatrices(skeleton, 0, 0);
    this.parts = [];
    parts.forEach((part, index) => {
      const mesh = new THREE.Mesh(part.geometry, materials[index]);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.parts.push({ ...part, mesh });
    });
  }

  pose(actionIndex, time) {
    computeBoneMatrices(this.skeleton, actionIndex, time, this.matrices);
    for (const part of this.parts) {
      const attribute = part.geometry.getAttribute('position');
      poseVertices(part.skin, this.matrices, attribute.array);
      attribute.needsUpdate = true;
    }
  }

  setLight(color) {
    for (const part of this.parts) {
      if (part.mesh.material.blending !== THREE.AdditiveBlending) part.mesh.material.color.copy(color);
    }
  }
}
