// The web viewer: loads a world and a player character from the game data and lets
// you walk around it with mouse clicks, like the client does.

import * as THREE from 'three';
import { TERRAIN_SCALE, TERRAIN_SIZE, TerrainFlag } from './formats.js';
import { loadModel, buildGeometries, computeBoneMatrices, createMaterial, AnimatedModel } from './bmd.js';
import { sampleHeight, sampleLight } from './terrain.js';
import { loadWorldData, createWorld } from './world.js';

THREE.ColorManagement.enabled = false;

const WORLD_NUMBER = 1; // Lorencia
const START_CELL = { x: 133, y: 126 };
const ACTION_STOP = 1;  // PLAYER_STOP_MALE
const ACTION_WALK = 15; // PLAYER_WALK_MALE
const KEYS_PER_SECOND = { [ACTION_STOP]: 6, [ACTION_WALK]: 9 };
const WALK_SPEED = 330; // units per second, about 3.3 cells
const BODY_PARTS = ['Helm', 'Armor', 'Pant', 'Glove', 'Boot'];
const FOG = { color: new THREE.Color(0x0a0d14), near: 2600, far: 4200 };
const CAMERA = { distance: 1250, minDistance: 500, maxDistance: 2600, pitch: 48 * Math.PI / 180, yaw: -45 * Math.PI / 180 };

const ui = {
  canvas: document.getElementById('view'),
  status: document.getElementById('status'),
  bar: document.getElementById('bar'),
  position: document.getElementById('position'),
  fps: document.getElementById('fps'),
  bodySet: document.getElementById('bodySet'),
};

const renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: true });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = FOG.color;
const camera = new THREE.PerspectiveCamera(35, 1, 10, 9000);

// The game uses x east, y north and z up; three.js uses y up.
const root = new THREE.Group();
root.rotation.x = -Math.PI / 2;
scene.add(root);

const state = { world: null, hero: null, heroPosition: new THREE.Vector2(), target: null, angle: 0, action: ACTION_STOP, time: 0 };

function setStatus(text, progress) {
  ui.status.textContent = text;
  if (progress !== undefined) ui.bar.style.width = `${Math.round(progress * 100)}%`;
}

function resize() {
  const { clientWidth: width, clientHeight: height } = ui.canvas.parentElement;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

function toScene(x, y, z) {
  return new THREE.Vector3(x, z, -y);
}

// ---------- hero ----------

async function createHero(bodySet) {
  const skeleton = await loadModel('Player', 'player.bmd');
  const pose = computeBoneMatrices(skeleton, ACTION_STOP, 0);
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

async function swapHero(bodySet) {
  const hero = await createHero(bodySet);
  if (state.hero) root.remove(state.hero.group);
  state.hero = hero;
  root.add(hero.group);
}

// ---------- movement ----------

function isWalkable(x, y) {
  const cx = Math.round(x / TERRAIN_SCALE), cy = Math.round(y / TERRAIN_SCALE);
  if (cx < 0 || cy < 0 || cx >= TERRAIN_SIZE || cy >= TERRAIN_SIZE) return false;
  return (state.world.flags[cy * TERRAIN_SIZE + cx] & (TerrainFlag.NOMOVE | TerrainFlag.NOGROUND)) === 0;
}

function stepHero(dt) {
  if (!state.target) return false;
  const delta = state.target.clone().sub(state.heroPosition);
  const distance = delta.length();
  if (distance < 5) { state.target = null; return false; }
  const step = delta.multiplyScalar(Math.min(1, (WALK_SPEED * dt) / distance));
  const next = state.heroPosition.clone().add(step);
  if (!isWalkable(next.x, next.y)) { state.target = null; return false; }
  state.angle = Math.atan2(step.x, -step.y); // CreateAngle in Engine/AI/AngleMath.cpp
  state.heroPosition.copy(next);
  return true;
}

const lightColor = new THREE.Color();

function updateHero(dt) {
  const moving = stepHero(dt);
  const action = moving ? ACTION_WALK : ACTION_STOP;
  if (action !== state.action) { state.action = action; state.time = 0; }
  state.time += dt * KEYS_PER_SECOND[action];
  const { x, y } = state.heroPosition;
  const z = sampleHeight(state.world.heights, x, y);
  const hero = state.hero;
  hero.group.position.set(x, y, z);
  hero.group.rotation.set(0, 0, state.angle);
  hero.pose(state.action, state.time);
  hero.setLight(sampleLight(state.world.light, x, y, lightColor));
  ui.position.textContent = `${Math.round(x / TERRAIN_SCALE)}, ${Math.round(y / TERRAIN_SCALE)}`;
}

// ---------- camera ----------

const view = { yaw: CAMERA.yaw, distance: CAMERA.distance, dragging: false, lastX: 0 };

function updateCamera() {
  const { x, y } = state.heroPosition;
  const z = sampleHeight(state.world.heights, x, y);
  const horizontal = Math.cos(CAMERA.pitch) * view.distance;
  const eye = toScene(x + Math.sin(view.yaw) * horizontal, y - Math.cos(view.yaw) * horizontal, z + Math.sin(CAMERA.pitch) * view.distance);
  camera.position.copy(eye);
  camera.lookAt(toScene(x, y, z + 100));
}

// ---------- input ----------

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function pickGround(event) {
  const rect = ui.canvas.getBoundingClientRect();
  pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(state.world.terrain, false)[0];
  if (!hit) return null;
  const local = root.worldToLocal(hit.point.clone());
  return new THREE.Vector2(local.x, local.y);
}

ui.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
ui.canvas.addEventListener('pointerdown', (event) => {
  if (!state.world) return;
  if (event.button === 2) { view.dragging = true; view.lastX = event.clientX; return; }
  const target = pickGround(event);
  if (target) state.target = target;
});
window.addEventListener('pointerup', () => { view.dragging = false; });
window.addEventListener('pointermove', (event) => {
  if (!view.dragging) return;
  view.yaw -= (event.clientX - view.lastX) * 0.006;
  view.lastX = event.clientX;
});
ui.canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  view.distance = THREE.MathUtils.clamp(view.distance * (event.deltaY > 0 ? 1.1 : 0.9), CAMERA.minDistance, CAMERA.maxDistance);
}, { passive: false });
ui.bodySet.addEventListener('change', () => swapHero(Number(ui.bodySet.value)));

// ---------- start ----------

let last = performance.now();
let frames = 0, fpsTime = 0;

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  frames++; fpsTime += dt;
  if (fpsTime >= 1) { ui.fps.textContent = `${frames} fps`; frames = 0; fpsTime = 0; }
  if (state.hero) updateHero(dt);
  updateCamera();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

async function start() {
  resize();
  setStatus('Loading Lorencia terrain…', 0.05);
  const data = await loadWorldData(WORLD_NUMBER);
  const world = await createWorld(data, FOG, (progress) => setStatus('Loading world objects…', 0.1 + progress * 0.8));
  state.world = { ...data, terrain: world.terrain };
  root.add(world.group);
  state.heroPosition.set(START_CELL.x * TERRAIN_SCALE, START_CELL.y * TERRAIN_SCALE);
  setStatus('Loading character…', 0.95);
  await swapHero(Number(ui.bodySet.value));
  setStatus(`Lorencia: ${data.objects.length} objects. Left-click to walk, right-drag to turn, wheel to zoom.`, 1);
  document.body.classList.add('ready');
  window.__viewerReady = true;
  requestAnimationFrame(frame);
}

start().catch((error) => {
  console.error(error);
  setStatus(`Loading failed: ${error.message}`);
});
