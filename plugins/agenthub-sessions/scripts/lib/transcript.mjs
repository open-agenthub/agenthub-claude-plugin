// Moving a Claude Code transcript between two machines is not a copy: the directory a transcript
// lives in is derived from the working directory it was recorded in, and every line repeats that
// working directory. Left alone, `claude --resume` on the other machine does not find the session
// at all — the transcript sits in a project folder belonging to a path that does not exist there.

const STATE_DIR = '.claude';
const PROJECTS = `${STATE_DIR}/projects`;

/**
 * The folder name Claude Code derives from a working directory. Verified against real sessions:
 * `C:\Users\Mb\GIT\agenthub` becomes `C--Users-Mb-GIT-agenthub` and `probe_a.b-c d` becomes
 * `probe-a-b-c-d`, so every character outside [A-Za-z0-9] maps to a single dash, including the
 * drive colon, both separators, dots, underscores and spaces.
 */
export function projectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Project folders present in a state archive, with the transcripts each one holds. */
export function listProjects(entries) {
  const projects = new Map();
  for (const entry of entries) {
    const parsed = parsePath(entry.name);
    if (!parsed) continue;
    if (!projects.has(parsed.slug)) projects.set(parsed.slug, { slug: parsed.slug, sessions: new Set() });
    if (parsed.sessionId) projects.get(parsed.slug).sessions.add(parsed.sessionId);
  }
  return [...projects.values()].map(project => ({ slug: project.slug, sessions: [...project.sessions] }));
}

/**
 * Splits `.claude/projects/<slug>/<sessionId>.jsonl` and the per-session sidecar files
 * `.claude/projects/<slug>/<sessionId>/subagents/<id>.jsonl` into their parts.
 */
export function parsePath(name) {
  const normalised = name.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalised.startsWith(`${PROJECTS}/`)) return null;
  const rest = normalised.slice(PROJECTS.length + 1);
  const slash = rest.indexOf('/');
  if (slash < 0) return { slug: rest, sessionId: null, kind: 'project' };

  const slug = rest.slice(0, slash);
  const tail = rest.slice(slash + 1);
  if (tail.endsWith('.jsonl') && !tail.includes('/')) {
    return { slug, sessionId: tail.slice(0, -'.jsonl'.length), kind: 'transcript', tail };
  }
  const nested = tail.indexOf('/');
  if (nested > 0) return { slug, sessionId: tail.slice(0, nested), kind: 'sidecar', tail };
  return { slug, sessionId: null, kind: 'other', tail };
}

/** Everything belonging to one session: its transcript plus its sidecar directory. */
export function sessionEntries(entries, slug, sessionId) {
  return entries.filter(entry => {
    const parsed = parsePath(entry.name);
    return parsed?.slug === slug && parsed.sessionId === sessionId
      && (parsed.kind === 'transcript' || parsed.kind === 'sidecar');
  });
}

/**
 * Rewrites a transcript for another machine. Only `cwd` and, when the target session id differs,
 * `sessionId` change; every other field is left byte-for-byte alone, because the transcript is
 * also the agent's record of what happened and an eager rewrite would edit history.
 *
 * Lines that are not JSON are passed through: a truncated last line is common in a transcript
 * captured while the agent was still writing, and dropping it would lose the turn before it.
 */
export function rewriteTranscript(text, { cwd, sessionId }) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const rewritten = lines.map(line => {
    if (!line.trim()) return line;
    let parsed;
    try { parsed = JSON.parse(line); } catch { return line; }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return line;
    if (cwd !== undefined && 'cwd' in parsed) parsed.cwd = cwd;
    if (sessionId !== undefined && 'sessionId' in parsed) parsed.sessionId = sessionId;
    return JSON.stringify(parsed);
  });
  return rewritten.join(newline);
}

/** The archive path of a transcript or sidecar file under a different project slug. */
export function retarget(name, slug, sessionId) {
  const parsed = parsePath(name);
  if (!parsed) return name;
  if (parsed.kind === 'transcript') return `${PROJECTS}/${slug}/${sessionId}.jsonl`;
  if (parsed.kind === 'sidecar') {
    const tail = parsed.tail.slice(parsed.sessionId.length + 1);
    return `${PROJECTS}/${slug}/${sessionId}/${tail}`;
  }
  return `${PROJECTS}/${slug}/${parsed.tail ?? ''}`;
}

/**
 * Replaces one session inside a state archive with transcript files from elsewhere. The old
 * entries for that session are dropped rather than merged: two transcripts for one id in one
 * project folder is a state Claude Code has no rule for, and the resume would pick by chance.
 */
export function replaceSession(entries, { slug, sessionId, files }) {
  const kept = entries.filter(entry => {
    const parsed = parsePath(entry.name);
    return !(parsed?.slug === slug && parsed.sessionId === sessionId
      && (parsed.kind === 'transcript' || parsed.kind === 'sidecar'));
  });
  return [...kept, ...files];
}

export { PROJECTS, STATE_DIR };
