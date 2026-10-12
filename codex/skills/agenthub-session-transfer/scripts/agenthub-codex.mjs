#!/usr/bin/env node
import { gunzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Hub } from './lib/api.mjs';
import { loadConfig } from './lib/config.mjs';
import { readTar } from './lib/tar.mjs';
import { candidates, select, importRollout } from './lib/codex.mjs';

const help = `agenthub-codex list | inspect <hub-id-or-url> | pull <hub-id-or-url> --dir <local-checkout>
Options: --session <rollout-uuid> --codex-home <path> --json
Uses AGENTHUB_URL/AGENTHUB_TOKEN or ~/.agenthub/cli.json. Requires Node 20+.
Pull creates a new local thread, never overwrites an existing conversation or changes the hub.`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    dir: { type: 'string' }, session: { type: 'string' }, 'codex-home': { type: 'string' },
    json: { type: 'boolean' }, help: { type: 'boolean' }
  } });
  const [command, input] = positionals;
  if (values.help || !command) { console.log(help); process.exit(0); }
  if (!['list', 'inspect', 'pull'].includes(command)) throw new Error('Unknown command.');
  const config = loadConfig();
  const hub = new Hub(config);
  let id = input;
  if (input?.includes('://')) {
    const url = new URL(input);
    if (url.origin !== new URL(config.url).origin) throw new Error('Session URL belongs to another hub; configure that hub explicitly.');
    id = /^\/s\/([a-zA-Z0-9-]+)\/?$/.exec(url.pathname)?.[1];
  }
  let result;
  if (command === 'list') {
    result = (await hub.listSessions()).filter(s => String(s.agent).toLowerCase() === 'codex')
      .map(s => ({ id: s.id, title: s.title, phase: s.phase, agent: s.agent }));
  } else {
    if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Specify a session ID or /s/<id> URL.');
    const session = await hub.getSession(id);
    if (String(session.agent).toLowerCase() !== 'codex') throw new Error('This hub session is not a Codex session.');
    const archive = await hub.downloadState(id);
    if (!archive) throw new Error('Session has no stored archive yet.');
    const entries = readTar(gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 }));
    if (command === 'inspect') {
      result = candidates(entries).map(c => ({ threadId: c.id, cwd: c.cwd, timestamp: c.timestamp, bytes: c.entry.data.length }));
    } else {
      const cwd = resolve(values.dir ?? process.cwd());
      if (!statSync(cwd).isDirectory()) throw new Error('Local checkout is not a directory.');
      result = { hubSessionId: id, phase: session.phase,
        ...importRollout(select(entries, values.session), { cwd,
          codexHome: resolve(values['codex-home'] ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')) }) };
      result.resume = `codex resume ${result.threadId}`;
      result.snapshot = 'Latest stored archive; a running session may have newer unsaved turns.';
    }
  }
  console.log(JSON.stringify(result, null, values.json ? undefined : 2));
} catch (error) {
  // API error bodies and malformed rollout lines can contain credentials or transcript text.
  const message = String(error.message ?? 'Transfer failed.');
  console.error(message.startsWith('HTTP ') ? message.split(':', 1)[0] : message);
  process.exitCode = 1;
}
