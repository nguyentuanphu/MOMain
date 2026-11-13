// Reads and writes packets using the generated definitions (packets.generated.js).
// Field indexes count from the start of the packet, header included, as in the server's XML.

import { PACKETS } from './packets.generated.js';

const HEADER_BYTES = { C1: 3, C3: 3, C2: 4, C4: 4 };
const HEADER_TYPE = { C1: 0xc1, C2: 0xc2, C3: 0xc3, C4: 0xc4 };
const textDecoder = new TextDecoder('utf-8');
const textEncoder = new TextEncoder();

export function packetLength(bytes) {
  return bytes[0] === 0xc2 || bytes[0] === 0xc4 ? (bytes[1] << 8) | bytes[2] : bytes[1];
}

export function packetCode(bytes) {
  const offset = bytes[0] === 0xc2 || bytes[0] === 0xc4 ? 3 : 2;
  return { code: bytes[offset], subCode: bytes[offset + 1] };
}

function findStructure(group, packet, name) {
  return packet?.structures?.[name] ?? PACKETS[group].structures[name];
}

// Size of one element of a structure; -1 when it isn't fixed.
function structureSize(structure) {
  if (structure.length) return structure.length;
  return -1;
}

function readBits(byte, field) {
  const bits = field.length ?? 8;
  return (byte >> (field.shift ?? 0)) & ((1 << bits) - 1);
}

function readString(bytes, start, length) {
  let end = start;
  const limit = Math.min(bytes.length, start + length);
  while (end < limit && bytes[end] !== 0) end++;
  return textDecoder.decode(bytes.subarray(start, end));
}

const FIXED_SIZES = { ShortLittleEndian: 2, ShortBigEndian: 2, IntegerLittleEndian: 4, IntegerBigEndian: 4, LongLittleEndian: 8, LongBigEndian: 8, Float: 4, Double: 8 };

function readField(context, field, base, end) {
  const { bytes, view } = context;
  const at = base + field.index;
  // A shorter variant of a packet (e.g. a failure answer) has no value for fields past its end.
  if (at >= end || at + (FIXED_SIZES[field.type] ?? 1) > end) return undefined;
  switch (field.type) {
    case 'Byte':
    case 'Enum':
      return field.length !== undefined && field.length < 8 ? readBits(bytes[at], field) : bytes[at];
    case 'Boolean':
      return ((bytes[at] >> (field.shift ?? 0)) & 1) === 1;
    case 'ShortLittleEndian': return view.getUint16(at, true);
    case 'ShortBigEndian': return view.getUint16(at, false);
    case 'IntegerLittleEndian': return view.getUint32(at, true);
    case 'IntegerBigEndian': return view.getUint32(at, false);
    case 'LongLittleEndian': return Number(view.getBigUint64(at, true));
    case 'LongBigEndian': return Number(view.getBigUint64(at, false));
    case 'Float': return view.getFloat32(at, true);
    case 'Double': return view.getFloat64(at, true);
    case 'String': return readString(bytes, at, field.length ?? end - at);
    case 'Binary': return bytes.slice(at, field.length !== undefined ? at + field.length : end);
    case 'Structure': {
      const structure = findStructure(context.group, context.packet, field.typeName);
      return readFields(context, structure.fields, at, structure.length ? at + structure.length : end);
    }
    default:
      return undefined;
  }
}

function readFields(context, fields, base, end) {
  const result = {};
  for (const field of fields) {
    if (field.type !== 'Structure[]') result[field.name] = readField(context, field, base, end);
  }
  for (const field of fields) {
    if (field.type !== 'Structure[]') continue;
    const structure = findStructure(context.group, context.packet, field.typeName);
    const size = structureSize(structure);
    const count = field.countField ? result[field.countField] : Math.floor((end - base - field.index) / Math.max(size, 1));
    const items = [];
    let offset = base + field.index;
    for (let i = 0; i < count && size > 0 && offset + size <= end; i++, offset += size) {
      items.push(readFields(context, structure.fields, offset, offset + size));
    }
    result[field.name] = items;
  }
  return result;
}

// Decodes a received packet with the named definition, e.g. read('ServerToClient', 'AddNpcsToScope', bytes).
export function read(group, name, bytes) {
  const packet = PACKETS[group].packets[name];
  if (!packet) throw new Error(`Unknown packet ${group}.${name}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return readFields({ bytes, view, group, packet }, packet.fields, 0, bytes.length);
}

// ---------- writing ----------

function writeBits(bytes, at, field, value) {
  const bits = field.length ?? 8;
  const shift = field.shift ?? 0;
  const mask = ((1 << bits) - 1) << shift;
  bytes[at] = (bytes[at] & ~mask) | ((Number(value) << shift) & mask);
}

function fieldEnd(field, values) {
  if (field.length !== undefined && field.type !== 'Byte' && field.type !== 'Enum' && field.type !== 'Boolean') return field.index + field.length;
  const value = values[field.name];
  if (field.type === 'Binary') return field.index + (value?.length ?? 0);
  if (field.type === 'String') return field.index + textEncoder.encode(value ?? '').length;
  const sizes = { ShortLittleEndian: 2, ShortBigEndian: 2, IntegerLittleEndian: 4, IntegerBigEndian: 4, LongLittleEndian: 8, LongBigEndian: 8, Float: 4, Double: 8 };
  return field.index + (sizes[field.type] ?? 1);
}

function writeField(view, bytes, field, value) {
  const at = field.index;
  switch (field.type) {
    case 'Byte':
    case 'Enum':
      if (field.length !== undefined && field.length < 8) writeBits(bytes, at, field, value);
      else bytes[at] = Number(value) & 0xff;
      break;
    case 'Boolean': writeBits(bytes, at, { length: 1, shift: field.shift }, value ? 1 : 0); break;
    case 'ShortLittleEndian': view.setUint16(at, value, true); break;
    case 'ShortBigEndian': view.setUint16(at, value, false); break;
    case 'IntegerLittleEndian': view.setUint32(at, value, true); break;
    case 'IntegerBigEndian': view.setUint32(at, value, false); break;
    case 'LongLittleEndian': view.setBigUint64(at, BigInt(value), true); break;
    case 'LongBigEndian': view.setBigUint64(at, BigInt(value), false); break;
    case 'Float': view.setFloat32(at, value, true); break;
    case 'Double': view.setFloat64(at, value, true); break;
    case 'String': {
      const encoded = textEncoder.encode(value);
      bytes.set(field.length !== undefined ? encoded.subarray(0, field.length) : encoded, at);
      break;
    }
    case 'Binary': bytes.set(field.length !== undefined ? value.subarray(0, field.length) : value, at); break;
    default: throw new Error(`Writing ${field.type} fields is not supported`);
  }
}

// Builds a packet to send, e.g. write('ClientToServer', 'WalkRequest', { SourceX: 1, ... }).
export function write(group, name, values = {}) {
  const packet = PACKETS[group].packets[name];
  if (!packet) throw new Error(`Unknown packet ${group}.${name}`);
  const headerBytes = HEADER_BYTES[packet.header];
  let length = packet.length ?? Math.max(headerBytes + (packet.hasSubCode ? 1 : 0), ...packet.fields.map((field) => fieldEnd(field, values)));
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  bytes[0] = HEADER_TYPE[packet.header];
  if (headerBytes === 3) bytes[1] = length;
  else view.setUint16(1, length, false);
  bytes[headerBytes - 1] = packet.code;
  if (packet.hasSubCode) bytes[headerBytes] = packet.subCode;
  for (const field of packet.fields) {
    const value = values[field.name] ?? (field.defaultValue !== undefined ? Number(field.defaultValue) : undefined);
    if (value !== undefined) writeField(view, bytes, field, value);
  }
  return bytes;
}

// Packets of a group indexed by code and sub code, for dispatching received packets.
export function indexPackets(group) {
  const byCode = new Map();
  for (const packet of Object.values(PACKETS[group].packets)) {
    const key = packet.hasSubCode ? `${packet.code}:${packet.subCode}` : `${packet.code}`;
    if (!byCode.has(key)) byCode.set(key, []);
    byCode.get(key).push(packet.name);
  }
  return byCode;
}
