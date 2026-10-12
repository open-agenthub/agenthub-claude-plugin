// Reading and writing tar archives, because the session state the hub stores is whatever
// `tar czf` produced inside the pod and whatever `tar xzf` there will accept back. Hand-rolled
// on purpose: a plugin is installed as plain files, so `npm install` never runs for it, and a
// dependency that is not there at the moment of use is worse than 200 lines of format code.

const BLOCK = 512;
const LONG_NAME = 'L';   // GNU: the next entry's name, as its own entry's content
const LONG_LINK = 'K';
const PAX_NEXT = 'x';
const PAX_GLOBAL = 'g';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** @typedef {{ name: string, type: string, mode: number, mtime: number, data: Uint8Array }} TarEntry */

/** Parses a tar archive into entries, resolving GNU long names and pax `path` records. */
export function readTar(buffer) {
  const bytes = new Uint8Array(buffer);
  const entries = [];
  let offset = 0;
  let pendingName = null;

  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) break;      // end-of-archive marker
    offset += BLOCK;

    const size = parseOctal(header, 124, 12);
    const type = String.fromCharCode(header[156]) || '0';
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    const content = bytes.subarray(offset, offset + size);
    offset += padded;

    if (type === LONG_NAME) {
      pendingName = trimNul(decoder.decode(content));
      continue;
    }
    if (type === LONG_LINK || type === PAX_GLOBAL) continue;
    if (type === PAX_NEXT) {
      // bsdtar and newer GNU tar store an over-long path as a "path=" pax record instead.
      const path = paxAttribute(decoder.decode(content), 'path');
      if (path) pendingName = path;
      continue;
    }

    const prefix = trimNul(decoder.decode(header.subarray(345, 500)));
    const stored = trimNul(decoder.decode(header.subarray(0, 100)));
    const name = pendingName ?? (prefix ? `${prefix}/${stored}` : stored);
    pendingName = null;

    entries.push({
      name,
      type,
      mode: parseOctal(header, 100, 8),
      mtime: parseOctal(header, 136, 12),
      data: content.slice()
    });
  }
  return entries;
}

/**
 * Serialises entries back to a tar archive. Over-long names get a GNU long-name header rather
 * than the ustar prefix split: a session transcript path is
 * `.claude/projects/<slug>/<uuid>/subagents/<uuid>.jsonl`, which passes 100 characters while no
 * single path component comes close, so the split has nowhere legal to put the break.
 */
export function writeTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const name = entry.name;
    const nameBytes = encoder.encode(name);
    if (nameBytes.length > 100) {
      const marker = encoder.encode(`${name}\0`);
      blocks.push(header({ name: '././@LongLink', type: LONG_NAME, mode: 0, mtime: 0, size: marker.length }));
      blocks.push(pad(marker));
    }
    const data = entry.type === '5' ? new Uint8Array(0) : entry.data;
    blocks.push(header({
      name: nameBytes.length > 100 ? decoder.decode(nameBytes.subarray(0, 100)) : name,
      type: entry.type,
      mode: entry.mode,
      mtime: entry.mtime,
      size: data.length
    }));
    if (data.length) blocks.push(pad(data));
  }
  // Two zero blocks close the archive; GNU tar then expects the whole thing to fill a 20-block
  // record and prints "A lone zero block" for a short one.
  const body = concat(blocks);
  const total = Math.ceil((body.length + 2 * BLOCK) / (20 * BLOCK)) * (20 * BLOCK);
  const out = new Uint8Array(total);
  out.set(body);
  return out;
}

function header({ name, type, mode, mtime, size }) {
  const block = new Uint8Array(BLOCK);
  writeString(block, 0, 100, name);
  writeOctal(block, 100, 8, mode || 0o644);
  // uid/gid of the agent user. tar run by a non-root user ignores stored ownership anyway, but
  // a 0 here reads as "root-owned" to anyone inspecting the archive.
  writeOctal(block, 108, 8, 1000);
  writeOctal(block, 116, 8, 1000);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, mtime || Math.floor(Date.now() / 1000));
  block[156] = type.charCodeAt(0);
  writeString(block, 257, 6, 'ustar');
  block[263] = 0x30;
  block[264] = 0x30;
  writeString(block, 265, 32, 'agent');
  writeString(block, 297, 32, 'agent');

  // The checksum is computed with its own field read as spaces, then written into it.
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  writeString(block, 148, 8, sum.toString(8).padStart(6, '0'));
  block[154] = 0;
  block[155] = 0x20;
  return block;
}

function writeString(block, at, length, value) {
  const bytes = encoder.encode(value);
  block.set(bytes.subarray(0, length), at);
}

function writeOctal(block, at, length, value) {
  // length - 1 digits plus a NUL, which is what GNU tar writes and every reader accepts.
  writeString(block, at, length, value.toString(8).padStart(length - 1, '0'));
  block[at + length - 1] = 0;
}

function parseOctal(block, at, length) {
  const raw = trimNul(decoder.decode(block.subarray(at, at + length))).trim();
  if (!raw) return 0;
  const value = parseInt(raw, 8);
  return Number.isFinite(value) ? value : 0;
}

function paxAttribute(record, key) {
  // Each record is "<length> <key>=<value>\n".
  for (const line of record.split('\n')) {
    const separator = line.indexOf(' ');
    if (separator < 0) continue;
    const pair = line.slice(separator + 1);
    const equals = pair.indexOf('=');
    if (equals > 0 && pair.slice(0, equals) === key) return pair.slice(equals + 1);
  }
  return null;
}

function pad(data) {
  const size = Math.ceil(data.length / BLOCK) * BLOCK;
  const out = new Uint8Array(size);
  out.set(data);
  return out;
}

function isZeroBlock(block) {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

function trimNul(value) {
  const end = value.indexOf('\0');
  return end < 0 ? value : value.slice(0, end);
}

function concat(parts) {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
