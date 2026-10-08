/* In-memory mocks of the Apps Script services used by apps-script/*.gs.
 * Behaviour mirrors the real services where it matters for the app:
 *  - Range bounds are enforced (like "range outside the dimensions of the sheet")
 *  - a leading apostrophe is treated as Sheets' quote prefix (stripped on store)
 *  - Utilities byte arrays are signed (-128..127) like Java bytes in Apps Script
 *  - CacheService honours TTLs against a controllable clock
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createGas() {
  const clock = { offset: 0, now() { return Date.now() + this.offset; } };
  const stats = { unlockedWrites: 0, writes: 0, sleeps: [], sharingCalls: 0, sheetReads: {} };
  let lockHeld = 0;
  let idSeq = 0;
  const newId = (p) => p + '_' + (++idSeq) + '_' + crypto.randomBytes(4).toString('hex');

  const toSigned = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
  const toBuf = (bytes) => Buffer.from(bytes.map((b) => b & 0xff));

  // ------------------------------------------------------------ Sheets
  class Range {
    constructor(sheet, r, c, nr, nc) {
      if (r < 1 || c < 1 || nr < 1 || nc < 1 || r + nr - 1 > sheet.maxRows || c + nc - 1 > sheet.maxCols) {
        throw new Error(`Range (${r},${c},${nr},${nc}) is outside the dimensions of sheet ${sheet.name} (${sheet.maxRows}x${sheet.maxCols})`);
      }
      Object.assign(this, { sheet, r, c, nr, nc });
    }
    getValues() {
      const out = [];
      for (let i = 0; i < this.nr; i++) {
        const row = [];
        for (let j = 0; j < this.nc; j++) {
          const v = (this.sheet.data[this.r - 1 + i] || [])[this.c - 1 + j];
          row.push(v === undefined ? '' : v);
        }
        out.push(row);
      }
      return out;
    }
    setValues(values) {
      if (values.length !== this.nr || values.some((row) => row.length !== this.nc)) throw new Error('setValues: dimensions mismatch');
      stats.writes++;
      if (!lockHeld) stats.unlockedWrites++;
      values.forEach((row, i) => {
        const ri = this.r - 1 + i;
        this.sheet.data[ri] = this.sheet.data[ri] || [];
        row.forEach((v, j) => {
          if (typeof v === 'string' && v.length > 50000) throw new Error('Your input contains more than the maximum of 50000 characters in a single cell.');
          if (typeof v === 'string' && v.startsWith("'")) v = v.substring(1); // quote prefix
          this.sheet.data[ri][this.c - 1 + j] = v;
        });
      });
      return this;
    }
    clearContent() {
      stats.writes++;
      if (!lockHeld) stats.unlockedWrites++;
      for (let i = 0; i < this.nr; i++) {
        const row = this.sheet.data[this.r - 1 + i];
        if (row) for (let j = 0; j < this.nc; j++) if (this.c - 1 + j < row.length) row[this.c - 1 + j] = '';
      }
      return this;
    }
    setNumberFormat() { return this; }
    setFontWeight() { return this; }
  }

  class Sheet {
    constructor(name) { Object.assign(this, { name, data: [], maxRows: 1000, maxCols: 26, frozen: 0 }); }
    getName() { return this.name; }
    setName(n) { this.name = n; return this; }
    getLastRow() {
      for (let i = this.data.length - 1; i >= 0; i--) if ((this.data[i] || []).some((v) => v !== '' && v !== undefined)) return i + 1;
      return 0;
    }
    getLastColumn() {
      let m = 0;
      this.data.forEach((row) => (row || []).forEach((v, j) => { if (v !== '' && v !== undefined) m = Math.max(m, j + 1); }));
      return m;
    }
    getMaxRows() { return this.maxRows; }
    getMaxColumns() { return this.maxCols; }
    insertRowsAfter(after, n) { this.maxRows += n; return this; }
    insertColumnsAfter(after, n) { this.maxCols += n; return this; }
    getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
    getDataRange() {
      stats.sheetReads[this.name] = (stats.sheetReads[this.name] || 0) + 1;
      return new Range(this, 1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1));
    }
    deleteRow(r) {
      stats.writes++;
      if (!lockHeld) stats.unlockedWrites++;
      this.data.splice(r - 1, 1);
      this.maxRows--;
      return this;
    }
    setFrozenRows(n) { this.frozen = n; return this; }
  }

  class Spreadsheet {
    constructor(name) { this.id = newId('ss'); this.name = name; this.sheets = [new Sheet('Sheet1')]; }
    getId() { return this.id; }
    getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
    getSheets() { return this.sheets.slice(); }
    getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
    insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
  }
  const spreadsheets = new Map();
  const SpreadsheetApp = {
    create(name) { const s = new Spreadsheet(name); spreadsheets.set(s.id, s); return s; },
    openById(id) { const s = spreadsheets.get(id); if (!s) throw new Error('Spreadsheet not found: ' + id); return s; },
    flush() {}
  };

  // ------------------------------------------------------------ Drive
  class Blob {
    constructor(bytes, mime, name) { this.bytes = bytes; this.mime = mime || null; this.name = name || null; }
    getBytes() { return this.bytes.slice(); }
    getContentType() { return this.mime; }
    getName() { return this.name; }
    setName(n) { this.name = n; return this; }
  }
  const files = new Map();
  const folders = new Map();
  class File {
    constructor(blob, folder) { this.id = newId('file'); this.blob = blob; this.folder = folder; this.trashed = false; }
    getId() { return this.id; }
    getName() { return this.blob.getName(); }
    getMimeType() { return this.blob.getContentType(); }
    getBlob() { return new Blob(this.blob.getBytes(), this.blob.getContentType(), this.blob.getName()); }
    setTrashed(t) { this.trashed = !!t; return this; }
    isTrashed() { return this.trashed; }
    setSharing() { stats.sharingCalls++; return this; }
  }
  class Folder {
    constructor(name) { this.id = newId('folder'); this.name = name; }
    getId() { return this.id; }
    getUrl() { return 'https://drive.google.com/drive/folders/' + this.id; }
    createFile(blob) { const f = new File(blob, this); files.set(f.id, f); return f; }
    getFiles() { // like DriveApp's FileIterator (trashed files are still listed)
      const list = [...files.values()].filter((f) => f.folder === this);
      let i = 0;
      return { hasNext: () => i < list.length, next: () => { if (i >= list.length) throw new Error('No more items'); return list[i++]; } };
    }
  }
  const DriveApp = {
    createFolder(n) { const f = new Folder(n); folders.set(f.id, f); return f; },
    getFolderById(id) { const f = folders.get(id); if (!f) throw new Error('No folder ' + id); return f; },
    getFileById(id) { const f = files.get(id); if (!f) throw new Error('No item with the given ID could be found: ' + id); return f; },
    Access: {}, Permission: {}
  };

  // ------------------------------------------------------------ Properties / Cache / Lock
  const propStore = {};
  const scriptProps = {
    getProperty: (k) => (Object.prototype.hasOwnProperty.call(propStore, k) ? propStore[k] : null),
    setProperty: (k, v) => { propStore[k] = String(v); return scriptProps; },
    setProperties: (obj, deleteAll) => {
      if (deleteAll) Object.keys(propStore).forEach((k) => delete propStore[k]);
      Object.keys(obj).forEach((k) => { propStore[k] = String(obj[k]); });
      return scriptProps;
    },
    deleteProperty: (k) => { delete propStore[k]; return scriptProps; },
    getProperties: () => Object.assign({}, propStore)
  };
  const PropertiesService = { getScriptProperties: () => scriptProps };

  const cacheStore = new Map();
  const scriptCache = {
    get(k) {
      const e = cacheStore.get(k);
      if (!e) return null;
      if (clock.now() >= e.exp) { cacheStore.delete(k); return null; }
      return e.v;
    },
    put(k, v, ttl) {
      if (typeof v !== 'string') throw new Error('cache value must be a string');
      if (k.length > 250) throw new Error('cache key too long');
      if (Buffer.byteLength(v, 'utf8') > 100 * 1024) throw new Error('Argument too large: value'); // CacheService limit 100 KB
      ttl = Math.min(ttl || 600, 21600);
      cacheStore.set(k, { v, exp: clock.now() + ttl * 1000 });
    },
    remove(k) { cacheStore.delete(k); },
    getAll(keys) {
      const out = {};
      keys.forEach((k) => { const v = scriptCache.get(k); if (v !== null) out[k] = v; });
      return out;
    },
    putAll(values, ttl) { Object.keys(values).forEach((k) => scriptCache.put(k, values[k], ttl)); }
  };
  const CacheService = { getScriptCache: () => scriptCache };

  const lockObj = {
    tryLock() { lockHeld++; return true; },
    waitLock() { lockHeld++; },
    releaseLock() { if (lockHeld > 0) lockHeld--; },
    hasLock() { return lockHeld > 0; }
  };
  const LockService = { getScriptLock: () => lockObj };

  // ------------------------------------------------------------ Utilities
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const Utilities = {
    DigestAlgorithm: { SHA_256: 'sha256', MD5: 'md5', SHA_1: 'sha1' },
    Charset: { UTF_8: 'utf8' },
    computeDigest(alg, value, charset) {
      const input = typeof value === 'string' ? Buffer.from(value, charset || 'utf8') : toBuf(value);
      return toSigned(crypto.createHash(alg).update(input).digest());
    },
    base64Encode(v) { return (typeof v === 'string' ? Buffer.from(v, 'utf8') : toBuf(v)).toString('base64'); },
    base64Decode(s) { return toSigned(Buffer.from(String(s), 'base64')); },
    getUuid() { return crypto.randomUUID(); },
    sleep(ms) { stats.sleeps.push(ms); },
    newBlob(data, mime, name) {
      const bytes = typeof data === 'string' ? toSigned(Buffer.from(data, 'utf8')) : data.slice();
      return new Blob(bytes, mime, name);
    },
    formatDate(date, tz, fmt) {
      if (tz !== 'Asia/Bangkok') throw new Error('mock formatDate supports Asia/Bangkok only');
      const d = new Date(date.getTime() + 7 * 3600 * 1000);
      return fmt.replace(/yyyy|MM|dd|HH|mm|ss/g, (t) => ({
        yyyy: d.getUTCFullYear(), MM: pad(d.getUTCMonth() + 1), dd: pad(d.getUTCDate()),
        HH: pad(d.getUTCHours()), mm: pad(d.getUTCMinutes()), ss: pad(d.getUTCSeconds())
      })[t]);
    }
  };

  const ContentService = {
    MimeType: { JSON: 'application/json', JAVASCRIPT: 'application/javascript', TEXT: 'text/plain' },
    createTextOutput(s) {
      return { content: s, mime: null, setMimeType(m) { this.mime = m; return this; }, getContent() { return this.content; } };
    }
  };

  // ------------------------------------------------------------ ScriptApp (time-driven triggers)
  const triggers = [];
  class Trigger {
    constructor(fn, minutes) { this.id = newId('trigger'); this.fn = fn; this.minutes = minutes; }
    getHandlerFunction() { return this.fn; }
    getUniqueId() { return this.id; }
  }
  const scopeRequests = []; // ScriptApp.requireScopes calls (no-op: the mock has every scope)
  const ScriptApp = {
    AuthMode: { FULL: 'FULL', LIMITED: 'LIMITED', NONE: 'NONE' },
    requireScopes(mode, scopes) { scopeRequests.push({ mode, scopes: (scopes || []).slice() }); },
    newTrigger(fn) {
      let minutes = null;
      const b = {
        timeBased() { return b; },
        everyMinutes(n) {
          if ([1, 5, 10, 15, 30].indexOf(n) < 0) throw new Error('everyMinutes: 1, 5, 10, 15 or 30 only');
          minutes = n; return b;
        },
        create() {
          if (!minutes) throw new Error('trigger without a schedule');
          const t = new Trigger(fn, minutes); triggers.push(t); return t;
        }
      };
      return b;
    },
    getProjectTriggers() { return triggers.slice(); },
    deleteTrigger(t) { const i = triggers.indexOf(t); if (i < 0) throw new Error('no such trigger'); triggers.splice(i, 1); }
  };

  // ------------------------------------------------------------ UrlFetchApp (no network: records every call)
  // fetches: [{url, params}]; fetchMode.code = HTTP status to answer, fetchMode.throws = message to throw
  const fetches = [];
  const fetchMode = { code: 202, throws: null };
  const UrlFetchApp = {
    fetch(url, params) {
      fetches.push({ url: String(url), params: Object.assign({}, params || {}) });
      if (fetchMode.throws) throw new Error(fetchMode.throws);
      const code = fetchMode.code;
      return { getResponseCode: () => code, getContentText: () => '' };
    }
  };

  const logs = [];
  const context = {
    SpreadsheetApp, DriveApp, PropertiesService, CacheService, LockService, Utilities, ContentService, ScriptApp, UrlFetchApp,
    Logger: { log: (m) => logs.push(String(m)) },
    console: { log: (...a) => logs.push('LOG ' + a.join(' ')), warn: (...a) => logs.push('WARN ' + a.join(' ')), error: (...a) => logs.push('ERROR ' + a.join(' ')) },
    JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, encodeURIComponent, parseInt, parseFloat, isNaN
  };
  vm.createContext(context);

  return {
    context, clock, stats, propStore, cacheStore, files, folders, spreadsheets, logs, triggers, fetches, fetchMode, scopeRequests,
    load(dir, order) {
      order.forEach((f) => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), context, { filename: f }));
      // single clock source for the app (Code.gs now_()) follows the mock clock
      context.now_ = () => new Date(clock.now());
    },
    isLocked: () => lockHeld > 0
  };
}

module.exports = { createGas };
