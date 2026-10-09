/**
 * JSON file stores — ported from `server con APIS/src/json-store.js`.
 * Each store is one file under DATA_DIR (mount a Railway volume at /data so the
 * device tokens, filters and seen-maps survive redeploys).
 */
import { mkdirSync, readFileSync, promises as fsp } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(import.meta.dirname, '..', 'data'));

export class JsonStore {
  #file;
  #data;
  #writing = false;
  #pending = false;

  constructor(name) {
    mkdirSync(DATA_DIR, { recursive: true });
    this.#file = path.join(DATA_DIR, `${name}.json`);
    this.#data = this.#read();
  }

  #read() {
    try {
      return JSON.parse(readFileSync(this.#file, 'utf8'));
    } catch {
      return {};
    }
  }

  /** Async single-flight write: coalesces bursts, then writes atomically (tmp + rename). */
  #write() {
    this.#pending = true;
    if (this.#writing) return;
    this.#writing = true;
    setImmediate(async () => {
      while (this.#pending) {
        this.#pending = false;
        try {
          const tmp = this.#file + '.tmp';
          await fsp.writeFile(tmp, JSON.stringify(this.#data, null, 2), 'utf8');
          await fsp.rename(tmp, this.#file);
        } catch (err) {
          console.error(`[json-store] write error ${this.#file}:`, err.message);
          break;
        }
      }
      this.#writing = false;
    });
  }

  get(key) {
    return this.#data[key] ?? null;
  }

  getAll() {
    return this.#data;
  }

  set(key, value) {
    this.#data[key] = value;
    this.#write();
  }

  delete(key) {
    delete this.#data[key];
    this.#write();
  }

  has(key) {
    return key in this.#data;
  }
}

export class JsonArrayStore {
  #file;
  #data;
  #writing = false;
  #pending = false;

  constructor(name) {
    mkdirSync(DATA_DIR, { recursive: true });
    this.#file = path.join(DATA_DIR, `${name}.json`);
    this.#data = this.#read();
  }

  #read() {
    try {
      return JSON.parse(readFileSync(this.#file, 'utf8'));
    } catch {
      return [];
    }
  }

  #write() {
    this.#pending = true;
    if (this.#writing) return;
    this.#writing = true;
    setImmediate(async () => {
      while (this.#pending) {
        this.#pending = false;
        try {
          const tmp = this.#file + '.tmp';
          await fsp.writeFile(tmp, JSON.stringify(this.#data, null, 2), 'utf8');
          await fsp.rename(tmp, this.#file);
        } catch (err) {
          console.error(`[json-store] write error ${this.#file}:`, err.message);
          break;
        }
      }
      this.#writing = false;
    });
  }

  getAll() {
    return this.#data;
  }

  getById(id) {
    return this.#data.find((item) => item.id === id) ?? null;
  }

  filter(predicate) {
    return this.#data.filter(predicate);
  }

  add(item) {
    const maxId = this.#data.reduce((max, item) => Math.max(max, item.id || 0), 0);
    const newItem = { ...item, id: maxId + 1 };
    this.#data.push(newItem);
    this.#write();
    return newItem;
  }

  delete(predicate) {
    const idx = this.#data.findIndex(predicate);
    if (idx === -1) return false;
    this.#data.splice(idx, 1);
    this.#write();
    return true;
  }
}
