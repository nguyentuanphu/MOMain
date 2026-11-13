// The web client: log in through the relay and play on the HNMO server, or explore
// Lorencia offline. Left-click walks, right-drag turns the camera, the wheel zooms.

import * as THREE from 'three';
import { TERRAIN_SCALE, TERRAIN_SIZE, TerrainFlag } from './formats.js';
import { sampleHeight } from './terrain.js';
import { loadWorldData, createWorld, mapName, KNOWN_MAPS } from './world.js';
import { createPlayerCharacter } from './game/characters.js';
import { findPath } from './game/pathfinding.js';
import { loadMonsterCatalog } from './game/monsterData.js';
import { loadItemCatalog, itemsWithModels, ItemGroup, ARMOR_GROUPS, WEAPON_GROUPS } from './game/items.js';
import { OnlineWorld } from './game/online.js';
import { Chat } from './game/chat.js';
import { loadGlowColors } from './game/itemGlow.js';
import { fetchServerList, fetchGameServerAddress, login, fetchCharacters, enterWorld, createCharacter, CLASSES } from './net/session.js';

THREE.ColorManagement.enabled = false;

const OFFLINE_START = { map: 0, x: 133, y: 126 };
const FOG = { color: new THREE.Color(0x0a0d14), near: 2600, far: 4200 };
const CAMERA = { distance: 1250, minDistance: 500, maxDistance: 2600, pitch: 48 * Math.PI / 180, yaw: -45 * Math.PI / 180 };
const LABEL_RANGE_CELLS = 18;
const MAX_FRAME_SECONDS = 0.5; // a hidden tab still catches up on walks, but not on minutes
const SETTINGS_KEY = 'hnmo-login';

const $ = (id) => document.getElementById(id);
const ui = {
  canvas: $('view'), status: $('status'), bar: $('bar'), position: $('position'), fps: $('fps'),
  login: $('login'), loginForm: $('loginForm'), loginError: $('loginError'), servers: $('servers'), characters: $('characters'),
  offline: $('offline'), hud: $('hud'), heroName: $('heroName'), labels: $('labels'), wardrobe: $('wardrobe'), bodySet: $('bodySet'),
  armorSet: $('armorSet'), rightHand: $('rightHand'), leftHand: $('leftHand'), wings: $('wings'), previousSet: $('previousSet'), nextSet: $('nextSet'),
  holdWeapons: $('holdWeapons'), itemLevel: $('itemLevel'), excellent: $('excellent'), ancient: $('ancient'), mapPicker: $('mapPicker'), mapSelect: $('mapSelect'),
};

const chat = new Chat({ log: $('chatLog'), form: $('chatForm'), input: $('chatInput') });

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
  setStatus(`Loading ${mapName(mapNumber)}…`, 0.05);
  const data = await loadWorldData(mapNumber);
  const world = await createWorld(data, FOG, (progress) => setStatus('Loading world objects…', 0.1 + progress * 0.8));
  state.world = { ...data, terrain: world.terrain };
  state.worldGroup = world.group;
  state.mapNumber = mapNumber;
  root.add(world.group);
}

async function placeHero({ id, name, bodySet, equipment, x, y }) {
  setStatus('Loading character…', 0.95);
  const hero = await createPlayerCharacter({ id, name, bodySet, equipment });
  if (state.hero) root.remove(state.hero.group);
  state.hero = hero;
  hero.holdWeapons = !state.online && ui.holdWeapons.checked;
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

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const NEW_CHARACTER = { create: true };
const MAX_CHARACTERS = 5;

// The character list, with a form to create one (the client's CharacterScene).
// The server sends the list once; a created character is added from the server's answer,
// as the client's CharacterScene does.
async function chooseCharacter(connection) {
  const characters = await fetchCharacters(connection);
  for (;;) {
    const choices = characters.length < MAX_CHARACTERS ? [...characters, NEW_CHARACTER] : characters;
    const choice = await chooseFrom(ui.characters, choices, (c) => (c.create ? '+ Create a character<small>Dark Wizard, Dark Knight, Fairy Elf, …</small>' : `${escapeHtml(c.name)}<small>Level ${c.level} ${CLASSES[c.classIndex]}</small>`));
    if (!choice.create) return choice;
    const created = await askNewCharacter();
    if (!created) continue;
    try {
      const result = await createCharacter(connection, created.name, created.classIndex);
      characters.push({ slot: result.CharacterSlot, name: result.CharacterName || created.name, level: result.Level ?? 1, classIndex: created.classIndex, equipment: {} });
    } catch (error) {
      showError(error);
    }
  }
}

function askNewCharacter() {
  ui.characters.replaceChildren();
  const form = document.createElement('div');
  form.className = 'choices';
  form.innerHTML = `
    <label class="row"><span>Character name</span><input id="newName" maxlength="10" required autocomplete="off"></label>
    <label class="row"><span>Class</span><select id="newClass">${CLASSES.map((name, index) => `<option value="${index}">${name}</option>`).join('')}</select></label>
    <div class="buttons"><button type="button" class="primary" id="createIt">Create</button><button type="button" id="cancelIt">Back</button></div>`;
  ui.characters.append(form);
  form.querySelector('#newName').focus();
  return new Promise((resolve) => {
    form.querySelector('#cancelIt').addEventListener('click', () => resolve(null), { once: true });
    form.querySelector('#createIt').addEventListener('click', () => {
      const name = form.querySelector('#newName').value.trim();
      if (name.length < 4 || name.length > 10) { showError(new Error('A character name has 4 to 10 letters or digits.')); return; }
      ui.loginError.hidden = true;
      resolve({ name, classIndex: Number(form.querySelector('#newClass').value) });
    });
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
  const character = await chooseCharacter(connection);
  ui.characters.hidden = true;
  await Promise.all([loadMonsterCatalog(), loadItemCatalog(), loadGlowColors()]);
  // The server sends who is in view right after the character information, while
  // the map is still loading: keep those packets and replay them once it's ready.
  const earlyPackets = [];
  const stopBuffering = connection.onPacket((bytes) => earlyPackets.push(bytes));
  const info = await enterWorld(connection, character.name);
  ui.login.hidden = true;
  await loadMap(info.MapId);
  await placeHero({ id: connection.playerId, name: character.name, bodySet: character.classIndex + 1, equipment: character.equipment, x: info.X, y: info.Y });
  stopBuffering();
  state.online = new OnlineWorld({
    connection, root, world: state.world, hero: state.hero, playerId: connection.playerId,
    onMessage: (text, kind) => chat.add(text, kind),
    onMapChanged: async (map, x, y) => {
      await loadMap(map);
      state.online.world = state.world;
      state.hero.placeAt(x, y);
      chat.add(`Welcome to ${mapName(map)}.`, 'system');
      setStatus(`${mapName(map)}. Enter opens the chat; /move <map> warps.`, 1);
    },
  });
  chat.enable((text) => state.online.say(text));
  chat.add(`Welcome to ${mapName(info.MapId)}. Try /move devias or /move noria.`, 'system');
  earlyPackets.forEach((bytes) => state.online.handle(bytes));
  connection.onClose = () => setStatus('Disconnected from the server. Reload the page to log in again.');
  setStatus(`${character.name} entered the world. Left-click to walk, right-drag to turn, wheel to zoom.`, 1);
}

// ---------- wardrobe (offline) ----------

const NOTHING = '';

function fillSelect(select, items, { none = true } = {}) {
  select.replaceChildren();
  if (none) select.append(new Option('Nothing', NOTHING));
  for (const item of items) select.append(new Option(`${item.name}`, `${item.group}:${item.number}`));
}

function selectedItem(select) {
  if (select.value === NOTHING) return null;
  const [group, number] = select.value.split(':').map(Number);
  return { group, number };
}

// An armour set is the same item number in the helm, armour, pants, gloves and boots groups.
function armorSetEquipment(number) {
  if (number === null) return {};
  const slots = ['helm', 'armor', 'pants', 'gloves', 'boots'];
  const equipment = {};
  ARMOR_GROUPS.forEach((group, index) => {
    if (itemsWithModels(group).some((item) => item.number === number)) equipment[slots[index]] = { group, number };
  });
  return equipment;
}

// The level and options every worn item gets, as the appearance bytes would carry them.
function wardrobeEquipment() {
  const armor = selectedItem(ui.armorSet);
  const options = { glowLevel: Number(ui.itemLevel.value), excellent: ui.excellent.checked, ancient: ui.ancient.checked };
  const withOptions = (item) => (item ? { ...item, ...options } : null);
  const equipment = {
    ...armorSetEquipment(armor ? armor.number : null),
    rightHand: selectedItem(ui.rightHand),
    leftHand: selectedItem(ui.leftHand),
    wings: selectedItem(ui.wings),
  };
  return Object.fromEntries(Object.entries(equipment).map(([slot, item]) => [slot, withOptions(item)]));
}

const WING_NAME = /wing|cape|cloak|mantle/i;

function initWardrobe() {
  fillSelect(ui.armorSet, itemsWithModels(ItemGroup.ARMOR).map((item) => ({ ...item, name: item.name.replace(/ Armor$/, '') })));
  fillSelect(ui.rightHand, WEAPON_GROUPS.flatMap((group) => itemsWithModels(group)));
  fillSelect(ui.leftHand, [ItemGroup.SHIELD, ...WEAPON_GROUPS].flatMap((group) => itemsWithModels(group)));
  fillSelect(ui.wings, itemsWithModels(ItemGroup.WING).filter((item) => WING_NAME.test(item.name)));
  ui.armorSet.selectedIndex = 1;
  ui.rightHand.selectedIndex = 1;
  ui.leftHand.value = `${ItemGroup.SHIELD}:0`;
  ui.wings.selectedIndex = 1;
  const redress = async () => {
    if (state.online || !state.hero) return;
    const { x, y } = state.hero.cell;
    await placeHero({ id: 0, name: 'Offline', bodySet: Number(ui.bodySet.value), equipment: wardrobeEquipment(), x, y });
  };
  for (let level = 0; level <= 15; level++) ui.itemLevel.append(new Option(`+${level}`, String(level)));
  for (const select of [ui.bodySet, ui.armorSet, ui.rightHand, ui.leftHand, ui.wings, ui.itemLevel, ui.excellent, ui.ancient]) select.addEventListener('change', redress);
  ui.holdWeapons.addEventListener('change', () => { if (state.hero) state.hero.holdWeapons = ui.holdWeapons.checked; });
  const step = (delta) => {
    const count = ui.armorSet.options.length;
    ui.armorSet.selectedIndex = (ui.armorSet.selectedIndex + delta + count) % count;
    redress();
  };
  ui.previousSet.addEventListener('click', () => step(-1));
  ui.nextSet.addEventListener('click', () => step(1));
}

// Where to stand on a map without a server: the walkable cell nearest the middle,
// preferring a safe zone (towns are safe zones).
function offlineStartCell(world) {
  const center = TERRAIN_SIZE / 2;
  let best = null;
  for (let y = 0; y < TERRAIN_SIZE; y++) {
    for (let x = 0; x < TERRAIN_SIZE; x++) {
      const flags = world.flags[y * TERRAIN_SIZE + x];
      if (flags & (TerrainFlag.NOMOVE | TerrainFlag.NOGROUND)) continue;
      const score = Math.hypot(x - center, y - center) - (flags & TerrainFlag.SAFEZONE ? 1000 : 0);
      if (!best || score < best.score) best = { x, y, score };
    }
  }
  return best ?? { x: center, y: center };
}

function initMapPicker() {
  for (const map of KNOWN_MAPS) ui.mapSelect.append(new Option(mapName(map), String(map)));
  ui.mapSelect.value = String(OFFLINE_START.map);
  ui.mapPicker.hidden = false;
  ui.mapSelect.addEventListener('change', async () => {
    const map = Number(ui.mapSelect.value);
    try {
      await loadMap(map);
      const cell = map === OFFLINE_START.map ? OFFLINE_START : offlineStartCell(state.world);
      state.hero.placeAt(cell.x, cell.y);
      setStatus(`Offline: ${mapName(map)}. Left-click to walk, right-drag to turn, wheel to zoom.`, 1);
    } catch (error) {
      setStatus(`${mapName(map)} couldn't be loaded: ${error.message}`);
    }
  });
}

async function playOffline() {
  ui.login.hidden = true;
  await Promise.all([loadItemCatalog(), loadGlowColors()]);
  initWardrobe();
  await loadMap(OFFLINE_START.map);
  await placeHero({ id: 0, name: 'Offline', bodySet: Number(ui.bodySet.value), equipment: wardrobeEquipment(), x: OFFLINE_START.x, y: OFFLINE_START.y });
  ui.wardrobe.hidden = false;
  initMapPicker();
  setStatus('Offline: Lorencia without a server. Left-click to walk, right-drag to turn, wheel to zoom.', 1);
}

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
  // HNMO.Web serves the page and the relay from the same address.
  const defaults = { relay: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/relay`, host: '127.0.0.1', port: 44406, username: '' };
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
