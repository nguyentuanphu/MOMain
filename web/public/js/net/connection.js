// A connection to a game server through the WebSocket relay (web/bridge).
// Each WebSocket message carries one whole, unencrypted packet; the relay
// encrypts and decrypts like the desktop client's ClientLibrary.

import { read, write, packetCode } from './packets.js';

const MAX_BACKLOG = 64;

export class Connection {
  constructor(relayUrl, { host, port, encrypted }) {
    this.url = `${relayUrl}?host=${encodeURIComponent(host)}&port=${port}&encrypted=${encrypted ? 1 : 0}`;
    this.handlers = new Set();
    this.waiters = [];
    this.backlog = []; // packets no waiter took yet, for a waiter that starts a moment later
    this.closed = false;
    this.onClose = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => resolve(this);
      socket.onerror = () => reject(new Error(`Couldn't reach the relay at ${this.url.split('?')[0]}`));
      socket.onmessage = (event) => this.dispatch(new Uint8Array(event.data));
      socket.onclose = () => {
        this.closed = true;
        for (const waiter of this.waiters) waiter.reject(new Error('The server closed the connection.'));
        this.waiters = [];
        this.onClose?.();
      };
      this.socket = socket;
    });
  }

  dispatch(bytes) {
    for (const handler of this.handlers) handler(bytes);
    const waiter = this.waiters.find((w) => w.matches(bytes));
    if (!waiter) {
      this.backlog.push(bytes);
      if (this.backlog.length > MAX_BACKLOG) this.backlog.shift();
      return;
    }
    clearTimeout(waiter.timer);
    this.waiters = this.waiters.filter((w) => w !== waiter);
    waiter.resolve(bytes);
  }

  onPacket(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // Waits for the next packet with this code (and sub code, if given).
  waitFor(code, subCode, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const matches = (bytes) => {
        const header = packetCode(bytes);
        return header.code === code && (subCode === undefined || header.subCode === subCode);
      };
      const early = this.backlog.findIndex(matches);
      if (early >= 0) {
        resolve(this.backlog.splice(early, 1)[0]);
        return;
      }
      const waiter = { matches, resolve, reject };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`No answer from the server (packet ${code.toString(16)}${subCode !== undefined ? ` ${subCode.toString(16)}` : ''}).`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  send(group, name, values) {
    if (this.closed) return;
    this.socket.send(write(group, name, values));
  }

  async request(group, name, values, answerGroup, answerName) {
    const { PACKETS } = await import('./packets.generated.js');
    const answer = PACKETS[answerGroup].packets[answerName];
    const waiting = this.waitFor(answer.code, answer.hasSubCode ? answer.subCode : undefined);
    this.send(group, name, values);
    return read(answerGroup, answerName, await waiting);
  }

  close() {
    this.closed = true;
    this.socket?.close();
  }
}
