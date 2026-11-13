// The web client: log in through the relay and play on an OpenMU server, or explore
// Lorencia offline. Left-click walks, right-drag turns the camera, the wheel zooms.

import * as THREE from 'three';
import { TERRAIN_SCALE } from './formats.js';
import { sampleHeight } from './terrain.js';
import { loadWorldData, createWorld } from './world.js';
import { createPlayerCharacter } from './game/characters.js';
import { findPath } from './game/pathfinding.js';
import { loadMonsterCatalog } from './game/monsterData.js';
import { OnlineWorld } from './game/online.js';
import { fetchServerList, fetchGameServerAddress, login, fetchCharacters, enterWorld, CLASSES } from './net/session.js';

THREE.ColorManagement.enabled = false;

const OFFLINE_START = { map: 0, x: 133, y: 126 };
const FOG = { color: new THREE.Color(0x0a0d14), near: 2600, far: 4200 };
const CAMERA = { distance: 1250, minDistance: 500, maxDistance: 2600, pitch: 48 * Math.PI / 180, yaw: -45 * Math.PI / 180 };
const LABEL_RANGE_CELLS = 18;
const MAX_FRAME_SECONDS = 0.5; // a hidden tab still catches up on walks, but not on minutes
const SETTINGS_KEY = 'mu-web-login';

const $ = (id) => document.getElementById(id);
const ui = {
  canvas: $('view'), status: $('status'), bar: $('bar'), position: $('position'), fps: $('fps'),
  login: $('login'), loginForm: $('loginForm'), loginError: $('loginError'), servers: $('servers'), characters: $('characters'),
  offline: $('offline'), hud: $('hud'), heroName: $('heroName'), labels: $('labels'), bodySetChip: $('bodySetChip'), bodySet: $('bodySet'),
};

const renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: true });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = FOG.color;
const camera = new THREE.PerspectiveCamera(35, 1, 10, 9000);
const root = new THREE.Group(); // game coordinates: x east, y north, z up
root.rotation.x = -Math.PI / 2;
scene.add(root);

const state = { world: null, hero: null, online: null, mapNumber: null };
window.__game = state; // for automated tests and debugging from the console

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

const toScene = (x, y, z) => new THREE.Vector3(x, z, -y);

// ---------- world ----------

async function loadMap(mapNumber) {
  if (state.mapNumber === mapNumber) return;
  if (state.worldGroup) root.remove(state.worldGroup);
  const worldNumber = mapNumber + 1;
  setStatus(`Loading map ${worldNumber}…`, 0.05);
  const data = await loadWorldData(worldNumber);
  const world = await createWorld(data, FOG, (progress) => setStatus('Loading world objects…', 0.1 + progress * 0.8));
  state.world = { ...data, terrain: world.terrain };
  state.worldGroup = world.group;
  state.mapNumber = mapNumber;
  root.add(world.group);
}

async function placeHero({ id, name, bodySet, x, y }) {
  if (state.hero) root.remove(state.hero.group);
  setStatus('Loading character…', 0.95);
  state.hero = await createPlayerCharacter({ id, name, bodySet });
  state.hero.placeAt(x, y);
  root.add(state.hero.group);
  ui.heroName.textContent = name;
}

// ---------- camera and input ----------

const view = { yaw: CAMERA.yaw, distance: CAMERA.distance, dragging: false, lastX: 0 };

function updateCamera() {
  const { x, y } = state.hero.position;
  const z = sampleHeight(state.world.heights, x, y);
  const horizontal = Math.cos(CAMERA.pitch) * view.distance;
  camera.position.copy(toScene(x + Math.sin(view.yaw) * horizontal, y - Math.cos(view.yaw) * horizontal, z + Math.sin(CAMERA.pitch) * view.distance));
  camera.lookAt(toScene(x, y, z + 100));
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function pickCell(event) {
  const rect = ui.canvas.getBoundingClientRect();
  pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(state.world.terrain, false)[0];
  if (!hit) return null;
  const local = root.worldToLocal(hit.point.clone());
  return { x: Math.floor(local.x / TERRAIN_SCALE), y: Math.floor(local.y / TERRAIN_SCALE) };
}

ui.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
ui.canvas.addEventListener('pointerdown', (event) => {
  if (!state.hero) return;
  if (event.button === 2) { view.dragging = true; view.lastX = event.clientX; return; }
  const cell = pickCell(event);
  if (!cell) return;
  if (state.online) state.online.walkTo(cell);
  else state.hero.walk(findPath(state.world.flags, state.hero.cell, cell));
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

// ---------- name labels ----------

const labelElements = new Map();

function updateLabels() {
  const visible = new Set();
  if (state.online) {
    const rect = ui.canvas.getBoundingClientRect();
    for (const character of state.online.characters.values()) {
      if (character.kind === 'monster') continue;
      const dx = character.cell.x - state.hero.cell.x, dy = character.cell.y - state.hero.cell.y;
      if (Math.hypot(dx, dy) > LABEL_RANGE_CELLS) continue;
      const point = toScene(character.position.x, character.position.y, sampleHeight(state.world.heights, character.position.x, character.position.y) + 220).project(camera);
      if (point.z > 1) continue;
      let element = labelElements.get(character);
      if (!element) {
        element = document.createElement('span');
        element.className = `label ${character.kind}`;
        element.textContent = character.name;
        ui.labels.append(element);
        labelElements.set(character, element);
      }
      element.style.transform = `translate(${(point.x + 1) / 2 * rect.width}px, ${(1 - point.y) / 2 * rect.height}px) translate(-50%, -100%)`;
      visible.add(character);
    }
  }
  for (const [character, element] of labelElements) {
    if (visible.has(character)) continue;
    element.remove();
    labelElements.delete(character);
  }
}

// ---------- frame loop ----------

let last = performance.now();
let frames = 0, fpsTime = 0;

function frame(now) {
  const dt = Math.min((now - last) / 1000, MAX_FRAME_SECONDS);
  last = now;
  frames++; fpsTime += dt;
  if (fpsTime >= 1) { ui.fps.textContent = `${frames} fps`; frames = 0; fpsTime = 0; }
  if (state.hero) {
    state.hero.update(dt, state.world);
    state.online?.update(dt);
    ui.position.textContent = `${state.hero.cell.x}, ${state.hero.cell.y}`;
    updateCamera();
    updateLabels();
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// ---------- login screens ----------

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {}; } catch { return {}; }
}

function saveSettings(settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private window */ }
}

function showError(error) {
  ui.loginError.textContent = error.message ?? String(error);
  ui.loginError.hidden = false;
}

function chooseFrom(container, items, describe) {
  container.replaceChildren();
  container.hidden = false;
  return new Promise((resolve) => {
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'choice';
      button.innerHTML = describe(item);
      button.addEventListener('click', () => resolve(item), { once: true });
      container.append(button);
    }
  });
}

async function playOnline(settings) {
  const connectServer = { host: settings.host, port: Number(settings.port) };
  setStatus('Asking the connect server for game servers…');
  const servers = await fetchServerList(settings.relay, connectServer);
  if (!servers.length) throw new Error('The connect server lists no game servers.');
  const server = servers.length === 1 ? servers[0] : await chooseFrom(ui.servers, servers, (s) => `Server ${s.id + 1}<small>${s.load}% load</small>`);
  ui.servers.hidden = true;
  const address = await fetchGameServerAddress(settings.relay, connectServer, server.id);
  setStatus(`Logging in to ${address.host}:${address.port}…`);
  const connection = await login(settings.relay, address, settings.username, settings.password);
  const characters = await fetchCharacters(connection);
  if (!characters.length) throw new Error('This account has no characters yet. Character creation is not in the web client yet.');
  const character = await chooseFrom(ui.characters, characters, (c) => `${c.name}<small>Level ${c.level} ${CLASSES[c.classIndex]}</small>`);
  ui.characters.hidden = true;
  await loadMonsterCatalog();
  // The server sends who is in view right after the character information, while
  // the map is still loading: keep those packets and replay them once it's ready.
  const earlyPackets = [];
  const stopBuffering = connection.onPacket((bytes) => earlyPackets.push(bytes));
  const info = await enterWorld(connection, character.name);
  ui.login.hidden = true;
  await loadMap(info.MapId);
  await placeHero({ id: connection.playerId, name: character.name, bodySet: character.classIndex + 1, x: info.X, y: info.Y });
  stopBuffering();
  state.online = new OnlineWorld({ connection, root, world: state.world, hero: state.hero, playerId: connection.playerId });
  earlyPackets.forEach((bytes) => state.online.handle(bytes));
  connection.onClose = () => setStatus('Disconnected from the server. Reload the page to log in again.');
  setStatus(`${character.name} entered the world. Left-click to walk, right-drag to turn, wheel to zoom.`, 1);
}

async function playOffline() {
  ui.login.hidden = true;
  await loadMap(OFFLINE_START.map);
  await placeHero({ id: 0, name: 'Offline', bodySet: Number(ui.bodySet.value), x: OFFLINE_START.x, y: OFFLINE_START.y });
  ui.bodySetChip.hidden = false;
  setStatus('Offline: Lorencia without a server. Left-click to walk, right-drag to turn, wheel to zoom.', 1);
}

ui.bodySet.addEventListener('change', async () => {
  if (state.online || !state.hero) return;
  const { x, y } = state.hero.cell;
  await placeHero({ id: 0, name: 'Offline', bodySet: Number(ui.bodySet.value), x, y });
});

function startGame(play) {
  ui.loginError.hidden = true;
  ui.loginForm.querySelector('fieldset').disabled = true;
  play().then(() => {
    document.body.classList.add('ready');
    ui.hud.hidden = false;
    window.__viewerReady = true;
  }).catch((error) => {
    console.error(error);
    ui.login.hidden = false;
    ui.servers.hidden = ui.characters.hidden = true;
    ui.loginForm.querySelector('fieldset').disabled = false;
    showError(error);
  });
}

function initLogin() {
  const saved = loadSettings();
  const defaults = { relay: `ws://${location.hostname}:8081/relay`, host: '127.0.0.1', port: 44406, username: '' };
  for (const [key, value] of Object.entries({ ...defaults, ...saved })) {
    const input = ui.loginForm.elements.namedItem(key);
    if (input) input.value = value;
  }
  ui.loginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(ui.loginForm));
    const { password, ...remembered } = form;
    saveSettings(remembered);
    startGame(() => playOnline(form));
  });
  ui.offline.addEventListener('click', () => startGame(playOffline));
  const autostart = new URLSearchParams(location.search).get('offline');
  if (autostart !== null) startGame(playOffline);
}

resize();
initLogin();
requestAnimationFrame(frame);
