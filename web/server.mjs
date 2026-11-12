// Serves the web viewer and the client's game data (src/bin/Data) to a browser.
//
// The data files keep their names and folders. Two things are adapted on the fly:
//  - names are matched case-insensitively, as on Windows, because models and maps
//    reference their files with whatever case the original authors used;
//  - .OZJ and .OZT are unwrapped to the JPEG and TGA they contain, and a request for
//    "x.jpg" / "x.tga" falls back to "x.OZJ" / "x.OZT", the names models refer to.
//
// The game data belongs to Webzen: this server binds to localhost by default and is
// not meant to be exposed to the internet.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.MU_DATA_DIR || path.join(HERE, '..', 'src', 'bin', 'Data'));
const PUBLIC_DIR = path.join(HERE, 'public');
const THREE_DIR = path.join(HERE, 'node_modules', 'three');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 8080;

const OZJ_PREFIX_BYTES = 24;
const OZT_PREFIX_BYTES = 4;
const DATA_FALLBACK_EXTENSIONS = { '.jpg': '.ozj', '.jpeg': '.ozj', '.tga': '.ozt' };
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

const directoryIndex = new Map();

async function listDirectory(dir) {
  if (!directoryIndex.has(dir)) {
    try {
      const names = await fs.readdir(dir);
      directoryIndex.set(dir, new Map(names.map((name) => [name.toLowerCase(), name])));
    } catch {
      directoryIndex.set(dir, null);
    }
  }
  return directoryIndex.get(dir);
}

// Resolves a relative path below root, ignoring case. Returns null for anything
// that does not exist or tries to leave root.
async function resolveIgnoringCase(root, relativePath) {
  let current = root;
  for (const part of relativePath.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return null;
    const entries = await listDirectory(current);
    const realName = entries?.get(part.toLowerCase());
    if (!realName) return null;
    current = path.join(current, realName);
  }
  return current;
}

async function resolveDataFile(relativePath) {
  const direct = await resolveIgnoringCase(DATA_DIR, relativePath);
  if (direct) return direct;
  const extension = path.extname(relativePath).toLowerCase();
  const fallback = DATA_FALLBACK_EXTENSIONS[extension];
  if (!fallback) return null;
  return resolveIgnoringCase(DATA_DIR, relativePath.slice(0, -extension.length) + fallback);
}

function startsWithJpegMarker(buffer, offset) {
  return buffer.length > offset + 1 && buffer[offset] === 0xff && buffer[offset + 1] === 0xd8;
}

function unwrapDataFile(file, buffer) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.ozj') {
    const body = startsWithJpegMarker(buffer, OZJ_PREFIX_BYTES) ? buffer.subarray(OZJ_PREFIX_BYTES) : buffer;
    return { body, type: 'image/jpeg' };
  }
  if (extension === '.ozt') return { body: buffer.subarray(OZT_PREFIX_BYTES), type: 'image/x-tga' };
  if (extension === '.tga') return { body: buffer, type: 'image/x-tga' };
  return { body: buffer, type: CONTENT_TYPES[extension] || 'application/octet-stream' };
}

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
}

async function serveData(relativePath, res) {
  const file = await resolveDataFile(relativePath);
  if (!file) return send(res, 404, `Not found in game data: ${relativePath}`, 'text/plain');
  const { body, type } = unwrapDataFile(file, await fs.readFile(file));
  return send(res, 200, body, type);
}

async function serveStatic(root, relativePath, res) {
  const file = await resolveIgnoringCase(root, relativePath);
  if (!file) return send(res, 404, 'Not found', 'text/plain');
  const stat = await fs.stat(file);
  if (stat.isDirectory()) return serveStatic(root, path.posix.join(relativePath, 'index.html'), res);
  return send(res, 200, await fs.readFile(file), CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    const decoded = decodeURIComponent(pathname);
    if (decoded.startsWith('/data/')) return await serveData(decoded.slice('/data/'.length), res);
    if (decoded.startsWith('/vendor/three/')) return await serveStatic(THREE_DIR, decoded.slice('/vendor/three/'.length), res);
    return await serveStatic(PUBLIC_DIR, decoded, res);
  } catch (error) {
    console.error(error);
    return send(res, 500, 'Server error', 'text/plain');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MuMain web viewer: http://${HOST}:${PORT}/`);
  console.log(`Game data: ${DATA_DIR}`);
});
