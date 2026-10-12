import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const decoder = new TextDecoder();

export function candidates(entries) {
  return entries.filter(e => ['0', '\0'].includes(e.type)
    && /^(?:\.\/)?\.codex\/(?:sessions|archived_sessions)\/.*\.jsonl$/.test(e.name))
    .flatMap(entry => {
      const text = decoder.decode(entry.data);
      let meta;
      try { meta = JSON.parse(text.split('\n', 1)[0]); } catch { return []; }
      if (meta.type !== 'session_meta' || !UUID.test(meta.payload?.id ?? '')) return [];
      return [{ entry, text, id: meta.payload.id, cwd: meta.payload.cwd,
        timestamp: meta.payload.timestamp ?? meta.timestamp }];
    });
}

export function select(entries, requested) {
  const found = candidates(entries);
  const remembered = entries.find(e => /^(?:\.\/)?\.codex\/agenthub-thread-id$/.test(e.name));
  const id = requested ?? (remembered ? decoder.decode(remembered.data).trim() : undefined);
  if (id) {
    const matches = found.filter(c => c.id === id);
    if (matches.length === 1) return matches[0];
    throw new Error('Transcript selection is missing or ambiguous; use inspect and --session.');
  }
  if (found.length === 1) return found[0];
  throw new Error(found.length ? 'Multiple Codex transcripts; use inspect and --session.' : 'Archive holds no Codex rollout.');
}

export function importRollout(candidate, { cwd, codexHome, id = randomUUID() }) {
  if (!UUID.test(id)) throw new Error('Invalid local thread UUID.');
  const date = new Date(candidate.timestamp);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid rollout timestamp.');
  cwd = resolve(cwd);
  const lines = candidate.text.trimEnd().split('\n').map((line, i) => {
    let record;
    try { record = JSON.parse(line); } catch { throw new Error(`Invalid rollout JSON at line ${i + 1}.`); }
    if (record.type === 'session_meta') {
      record.payload.id = id;
      record.payload.cwd = cwd;
      // The imported conversation is a local root, not a child of a foreign live thread.
      delete record.payload.forked_from_id;
      return JSON.stringify(record);
    }
    if (record.type === 'turn_context') {
      record.payload.cwd = cwd;
      // Historical pod permissions must not select the local session's execution policy.
      delete record.payload.sandbox_policy;
      delete record.payload.approval_policy;
      return JSON.stringify(record);
    }
    return line;
  });
  const stamp = date.toISOString().slice(0, 19).replaceAll(':', '-');
  const folder = join(codexHome, 'sessions', ...date.toISOString().slice(0, 10).split('-'));
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = join(folder, `rollout-${stamp}-${id}.jsonl`);
  writeFileSync(file, lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  return { threadId: id, sourceThreadId: candidate.id, cwd, file };
}
