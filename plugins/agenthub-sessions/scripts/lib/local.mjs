import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix } from 'node:path';

import { PROJECTS, projectSlug } from './transcript.mjs';

// Local transcripts are addressed exactly as they are inside a state archive — a home-relative
// posix path — so the same functions handle both sides and nothing has to translate between two
// spellings of the same file.

export function projectDir(cwd, home = homedir()) {
  return join(home, '.claude', 'projects', projectSlug(cwd));
}

/** Transcripts recorded for `cwd` on this machine, newest first. */
export function listLocalSessions(cwd, home = homedir()) {
  const dir = projectDir(cwd, home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith('.jsonl'))
    .map(name => {
      const path = join(dir, name);
      return { sessionId: name.slice(0, -'.jsonl'.length), path, modified: statSync(path).mtime };
    })
    .sort((a, b) => b.modified - a.modified);
}

/** A session's transcript and sidecar files, named as archive entries. */
export function readLocalSession(cwd, sessionId, home = homedir()) {
  const slug = projectSlug(cwd);
  const dir = projectDir(cwd, home);
  const transcript = join(dir, `${sessionId}.jsonl`);
  if (!existsSync(transcript)) {
    throw new Error(`No local transcript at ${transcript}`);
  }
  const files = [entryFor(`${PROJECTS}/${slug}/${sessionId}.jsonl`, transcript)];
  const sidecarRoot = join(dir, sessionId);
  if (existsSync(sidecarRoot)) {
    for (const relative of walk(sidecarRoot)) {
      files.push(entryFor(
        posix.join(PROJECTS, slug, sessionId, relative.split(/[\\/]/).join('/')),
        join(sidecarRoot, relative)));
    }
  }
  return files;
}

/**
 * Writes archive entries below the home directory. Refuses a path that would leave it: the entry
 * names come from an archive built elsewhere, and `..` in one of them is how a tar extraction
 * writes outside the directory it was pointed at.
 */
export function writeEntries(files, { home = homedir(), force = false } = {}) {
  const root = join(home, '.');
  const written = [];
  for (const file of files) {
    const target = join(home, file.name);
    if (!target.startsWith(root)) throw new Error(`Entry escapes the home directory: ${file.name}`);
    if (existsSync(target) && !force) {
      const existing = readFileSync(target);
      if (!existing.equals(Buffer.from(file.data))) {
        throw new Error(
          `${target} already exists with different content. Pass --force to overwrite it — local `
          + 'work in that transcript would be lost.');
      }
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(file.data));
    written.push(target);
  }
  return written;
}

function entryFor(name, path) {
  const stats = statSync(path);
  return {
    name,
    type: '0',
    mode: 0o600,
    mtime: Math.floor(stats.mtimeMs / 1000),
    data: new Uint8Array(readFileSync(path))
  };
}

function* walk(dir, prefix = '') {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) yield* walk(join(dir, item.name), relative);
    else if (item.isFile()) yield relative;
  }
}
