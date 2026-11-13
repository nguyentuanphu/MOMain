// The login flow of the client (Scenes/LoginScene, CharacterScene): server list from
// the connect server, then login and character list on the chosen game server.

import { Connection } from './connection.js';
import { read } from './packets.js';
import { PACKETS } from './packets.generated.js';
import { parseAppearance } from '../game/items.js';

// The client identity MuMain sends (Network/Server/WSclient.cpp: Version, Serial).
const CLIENT_VERSION = new TextEncoder().encode('20404');
const CLIENT_SERIAL = new TextEncoder().encode('k1Pk2jcET48mxL3b');
const XOR3_KEYS = [0xfc, 0xcf, 0xab];
const USERNAME_BYTES = 10;
const PASSWORD_BYTES = 20;
const LOGIN_OK = 1;

const LOGIN_RESULTS = {
  0: 'Wrong password.',
  1: 'OK',
  2: 'That account doesn\'t exist.',
  3: 'This account is already logged in.',
  4: 'The server is full.',
  5: 'This account is blocked.',
  6: 'Your client version is too old for this server.',
  8: 'Too many failed logins. Try again later.',
};

function xor3Field(text, length) {
  const bytes = new Uint8Array(length);
  bytes.set(new TextEncoder().encode(text).subarray(0, length));
  for (let i = 0; i < length; i++) bytes[i] ^= XOR3_KEYS[i % 3];
  return bytes;
}

function packetOf(group, name) {
  const packet = PACKETS[group].packets[name];
  return [packet.code, packet.hasSubCode ? packet.subCode : undefined];
}

// Asks the connect server for its game servers.
export async function fetchServerList(relayUrl, connectServer) {
  const connection = await new Connection(relayUrl, { ...connectServer, encrypted: false }).open();
  try {
    await connection.waitFor(...packetOf('ConnectServer', 'Hello'));
    const list = await connection.request('ConnectServer', 'ServerListRequest', {}, 'ConnectServer', 'ServerListResponse');
    return list.Servers.map((server) => ({ id: server.ServerId, load: server.LoadPercentage }));
  } finally {
    connection.close();
  }
}

export async function fetchGameServerAddress(relayUrl, connectServer, serverId) {
  const connection = await new Connection(relayUrl, { ...connectServer, encrypted: false }).open();
  try {
    await connection.waitFor(...packetOf('ConnectServer', 'Hello'));
    const info = await connection.request('ConnectServer', 'ConnectionInfoRequest', { ServerId: serverId }, 'ConnectServer', 'ConnectionInfo');
    return { host: info.IpAddress, port: info.Port };
  } finally {
    connection.close();
  }
}

// Opens the game server connection and logs in. Resolves with the open connection.
export async function login(relayUrl, gameServer, username, password) {
  const connection = new Connection(relayUrl, { ...gameServer, encrypted: true });
  const entered = connection.waitFor(...packetOf('ServerToClient', 'GameServerEntered'));
  await connection.open();
  const welcome = read('ServerToClient', 'GameServerEntered', await entered);
  const response = await connection.request('ClientToServer', 'LoginLongPassword', {
    Username: xor3Field(username, USERNAME_BYTES),
    Password: xor3Field(password, PASSWORD_BYTES),
    TickCount: Math.floor(performance.now()) >>> 0,
    ClientVersion: CLIENT_VERSION,
    ClientSerial: CLIENT_SERIAL,
  }, 'ServerToClient', 'LoginResponse');
  if (response.Success !== LOGIN_OK) {
    connection.close();
    throw new Error(LOGIN_RESULTS[response.Success] ?? `Login refused (code ${response.Success}).`);
  }
  connection.playerId = welcome.PlayerId;
  return connection;
}

// Character classes by OpenMU's class number >> 2, with the body set the client draws.
export const CLASSES = ['Dark Wizard', 'Dark Knight', 'Fairy Elf', 'Magic Gladiator', 'Dark Lord', 'Summoner', 'Rage Fighter'];

export function classOfAppearance(appearance) {
  const baseClass = (appearance?.[0] ?? 0) >> 2;
  return Math.min(baseClass, CLASSES.length - 1);
}

export async function fetchCharacters(connection) {
  const list = await connection.request('ClientToServer', 'RequestCharacterList', { Language: 0 }, 'ServerToClient', 'CharacterListExtended');
  return list.Characters.map((character) => ({
    slot: character.SlotIndex,
    name: character.Name,
    level: character.Level,
    classIndex: classOfAppearance(character.Appearance),
    equipment: parseAppearance(character.Appearance).equipment,
  }));
}

export async function enterWorld(connection, characterName) {
  return connection.request('ClientToServer', 'SelectCharacter', { Name: characterName }, 'ServerToClient', 'CharacterInformationExtended');
}
