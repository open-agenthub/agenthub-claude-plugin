// The decisions a transfer makes, kept free of the filesystem and the network so each one can be
// tested against a real archive layout rather than through a mock of both.

import { listProjects, parsePath, projectSlug, replaceSession, retarget, rewriteTranscript, sessionEntries }
  from './transcript.mjs';

export class TransferError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransferError';
  }
}

/**
 * Which session to take out of an archive. A pod's state holds one project folder in the ordinary
 * case, but a session that worked in several directories holds more, and `--session` then decides.
 */
export function selectSession(entries, requested) {
  const projects = listProjects(entries).filter(project => project.sessions.length > 0);
  if (projects.length === 0) {
    throw new TransferError(
      'The archive holds no transcript. The session has not run yet, or it ran an agent other than '
      + 'Claude Code — only Claude Code transcripts can be continued locally.');
  }

  const candidates = projects.flatMap(
    project => project.sessions.map(sessionId => ({ slug: project.slug, sessionId })));
  if (requested) {
    const matches = candidates.filter(candidate => candidate.sessionId === requested);
    if (matches.length === 0) {
      throw new TransferError(
        `No transcript for ${requested} in the archive. It holds: `
        + `${candidates.map(candidate => candidate.sessionId).join(', ')}`);
    }
    return matches[0];
  }
  if (candidates.length > 1) {
    throw new TransferError(
      'The archive holds more than one transcript; pass --session with one of: '
      + `${candidates.map(candidate => candidate.sessionId).join(', ')}`);
  }
  return candidates[0];
}

/**
 * Files to write under the local home directory so `claude --resume <sessionId>` finds the
 * session in `cwd`. Paths are returned relative to the home directory, as they are in the archive.
 */
export function planPull(entries, { cwd, session }) {
  const slug = projectSlug(cwd);
  const files = sessionEntries(entries, session.slug, session.sessionId).map(entry => ({
    ...entry,
    name: retarget(entry.name, slug, session.sessionId),
    data: parsePath(entry.name).kind === 'transcript'
      // Only the transcript carries cwd. The sidecars are subagent conversations; the resume does
      // not index them by path, so rewriting them would change content nothing reads.
      ? new TextEncoder().encode(rewriteTranscript(new TextDecoder().decode(entry.data), { cwd }))
      : entry.data
  }));
  if (files.length === 0) {
    throw new TransferError(`No files for session ${session.sessionId} in the archive.`);
  }
  return { slug, sessionId: session.sessionId, files };
}

/**
 * A new archive in which the remote session's transcript is the local one. The remote session id
 * is kept, because that is the id the pod passes to `claude --resume`; a transcript stored under
 * the local id would be ignored and the session would come back up with no history.
 */
export function planPush(entries, localFiles, { session, remoteCwd }) {
  const slug = session.slug;
  const cwd = remoteCwd ?? null;
  const rewritten = localFiles.map(file => {
    const parsed = parsePath(file.name);
    if (!parsed) throw new TransferError(`Not a transcript path: ${file.name}`);
    return {
      ...file,
      name: retarget(file.name, slug, session.sessionId),
      data: parsed.kind === 'transcript'
        ? new TextEncoder().encode(rewriteTranscript(new TextDecoder().decode(file.data),
          { cwd: cwd ?? undefined, sessionId: session.sessionId }))
        : file.data
    };
  });
  if (!rewritten.some(file => parsePath(file.name).kind === 'transcript')) {
    throw new TransferError('No transcript among the local files; nothing to push.');
  }
  return { slug, sessionId: session.sessionId, entries: replaceSession(entries, { slug, sessionId: session.sessionId, files: rewritten }) };
}

/**
 * The working directory the pod will have. Taken from the archive's own project folder whenever
 * possible: that slug is what the pod wrote, so it is the one the resume will look in.
 */
export function remoteWorkdir(session, info) {
  // Mirrors AGENTHUB_WORKDIR in the hub's pod spec, which is "/workspace/repo" for *exactly* one
  // repository and "/workspace" otherwise — a session with two repositories gets each one in
  // /workspace/<name> and works from the parent, so counting "has repos" guesses the wrong one.
  const repos = Array.isArray(info?.repos) ? info.repos.length : 0;
  const guess = repos === 1 ? '/workspace/repo' : '/workspace';
  // The slug cannot be decoded back into a path — every separator became the same dash — so it is
  // used to check the guess rather than to produce one. That also covers the pod's own fallback to
  // /workspace when a clone failed and /workspace/repo was never created.
  return projectSlug(guess) === session.slug ? guess : null;
}
