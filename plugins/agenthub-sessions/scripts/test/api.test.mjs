import assert from 'node:assert/strict';
import test from 'node:test';

import { Hub, HubError } from '../lib/api.mjs';

const TOKEN = 'oah_token';

test('refuses to start without a url and a token', () => {
  assert.throws(() => new Hub({ url: 'https://hub.example', token: '' }), HubError);
  assert.throws(() => new Hub({ url: '', token: TOKEN }), HubError);
  assert.throws(() => new Hub({ url: 'not a url', token: TOKEN }), /Not a URL/);
  // A file:// or ws:// url would make fetch fail somewhere far from the cause.
  assert.throws(() => new Hub({ url: 'ws://hub.example', token: TOKEN }), /http\(s\)/);
});

test('sends the token as a bearer header and keeps the path under api/remote', async () => {
  const calls = [];
  const hub = new Hub({
    url: 'https://hub.example/',
    token: TOKEN,
    fetchImpl: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(response(200, '[]'));
    }
  });

  await hub.listSessions();

  // The trailing slash of the configured url must not survive into the path.
  assert.equal(calls[0].url, 'https://hub.example/api/remote/sessions');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
});

test('a missing archive is an absence, not an error', async () => {
  const hub = new Hub({ url: 'https://hub.example', token: TOKEN, fetchImpl: () => Promise.resolve(response(404, '')) });

  assert.equal(await hub.downloadState('session-1'), null);
});

test('declares the length of an upload so the hub never has to buffer it', async () => {
  let seen;
  const hub = new Hub({
    url: 'https://hub.example',
    token: TOKEN,
    fetchImpl: (_url, init) => { seen = init; return Promise.resolve(response(204, '')); }
  });

  await hub.uploadState('session-1', new Uint8Array(42));

  assert.equal(seen.method, 'PUT');
  assert.equal(seen.headers['Content-Length'], '42');
  assert.equal(seen.headers['Content-Type'], 'application/gzip');
});

test('explains a 409 in terms of what the user has to do', async () => {
  const hub = new Hub({
    url: 'https://hub.example',
    token: TOKEN,
    fetchImpl: () => Promise.resolve(response(409, 'Pause the session before uploading its state.'))
  });

  await assert.rejects(() => hub.uploadState('session-1', new Uint8Array(1)), error =>
    error instanceof HubError && error.status === 409 && /Pause it in the hub first/.test(error.message));
});

test('reports a rejected token and missing object storage distinctly', async () => {
  const hub = status => new Hub({
    url: 'https://hub.example',
    token: TOKEN,
    fetchImpl: () => Promise.resolve(response(status, ''))
  });

  await assert.rejects(() => hub(401).listSessions(), /rejected the token/);
  await assert.rejects(() => hub(503).uploadState('s', new Uint8Array(1)), /no object storage/);
});

test('refuses an archive larger than the transfer limit before reading it', async () => {
  const hub = new Hub({
    url: 'https://hub.example',
    token: TOKEN,
    fetchImpl: () => Promise.resolve(response(200, '', { 'content-length': String(300 * 1024 * 1024) }))
  });

  await assert.rejects(() => hub.downloadState('session-1'), /over the/);
});

function response(status, body, headers = {}) {
  const bytes = new TextEncoder().encode(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    text: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(bytes.buffer)
  };
}
