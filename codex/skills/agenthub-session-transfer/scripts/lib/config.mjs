import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The token is a credential, so it is never passed on the command line of a long-running process
// and never written into the plugin directory — that one is replaced wholesale on every update.
const CONFIG_DIR = join(homedir(), '.agenthub');
const CONFIG_FILE = join(CONFIG_DIR, 'cli.json');

export function loadConfig(env = process.env) {
  const stored = readStored();
  return {
    url: env.AGENTHUB_URL || stored.url,
    token: env.AGENTHUB_TOKEN || stored.token,
    source: env.AGENTHUB_URL || env.AGENTHUB_TOKEN ? 'environment' : stored.url ? CONFIG_FILE : 'nothing'
  };
}

export function saveConfig({ url, token }) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, `${JSON.stringify({ url, token }, null, 2)}\n`, { mode: 0o600 });
  // mkdir/writeFile honour the mode only on creation, so an existing file keeps its old bits.
  chmodSync(CONFIG_FILE, 0o600);
  return CONFIG_FILE;
}

function readStored() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    return { url: parsed.url ?? null, token: parsed.token ?? null };
  } catch {
    return { url: null, token: null };
  }
}

export { CONFIG_FILE };
