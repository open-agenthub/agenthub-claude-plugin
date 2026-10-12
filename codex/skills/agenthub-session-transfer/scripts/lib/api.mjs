// The hub's remote API, the surface a personal API token is allowed to use. `api/sessions` needs
// an interactive login, so a workstation cannot reach it even with a valid token.

const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

export class HubError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'HubError';
    this.status = status;
  }
}

export class Hub {
  constructor({ url, token, fetchImpl = globalThis.fetch } = {}) {
    if (!url || !token) {
      throw new HubError(
        'Not configured. Set AGENTHUB_URL and AGENTHUB_TOKEN, or run `agenthub-session login`.');
    }
    let parsed;
    try { parsed = new URL(url); } catch { throw new HubError(`Not a URL: ${url}`); }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new HubError(`Expected an http(s) URL, got ${parsed.protocol}`);
    }
    this.baseUrl = parsed.toString().replace(/\/$/, '');
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  listSessions() {
    return this.#json('GET', '/api/remote/sessions');
  }

  getSession(id) {
    return this.#json('GET', `/api/remote/sessions/${encodeURIComponent(id)}`);
  }

  /** The session's state archive as raw gzip bytes, or null when the hub has none yet. */
  async downloadState(id) {
    const response = await this.#send('GET', `/api/remote/sessions/${encodeURIComponent(id)}/state`);
    if (response.status === 404) return null;
    await this.#assertOk(response);
    const declared = Number(response.headers.get('content-length'));
    if (declared > MAX_ARCHIVE_BYTES) {
      throw new HubError(`State archive is ${declared} bytes, over the ${MAX_ARCHIVE_BYTES} limit.`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async uploadState(id, bytes) {
    const response = await this.#send('PUT', `/api/remote/sessions/${encodeURIComponent(id)}/state`, {
      body: bytes,
      headers: {
        'Content-Type': 'application/gzip',
        // Sent explicitly so the hub never has to buffer the body to learn its length.
        'Content-Length': String(bytes.length)
      }
    });
    if (response.status === 409) {
      throw new HubError(
        `Session ${id} is still running. Pause it in the hub first — a running pod writes its own `
        + 'state over the upload when it stops.', { status: 409 });
    }
    await this.#assertOk(response);
  }

  async #json(method, path) {
    const response = await this.#send(method, path);
    await this.#assertOk(response);
    if (response.status === 204) return null;
    const text = await response.text();
    try { return JSON.parse(text); }
    catch { throw new HubError(`${method} ${path} did not answer with JSON.`); }
  }

  #send(method, path, { body, headers = {} } = {}) {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json', ...headers },
      body,
      signal: AbortSignal.timeout(600_000)
    });
  }

  async #assertOk(response) {
    if (response.ok) return;
    if (response.status === 401) {
      throw new HubError('The hub rejected the token (401). Check AGENTHUB_TOKEN.', { status: 401 });
    }
    if (response.status === 503) {
      throw new HubError(
        'The hub has no object storage configured, so it cannot store session state.', { status: 503 });
    }
    let detail = '';
    try { detail = (await response.text()).trim().slice(0, 500); } catch { /* body already consumed */ }
    throw new HubError(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`, { status: response.status });
  }
}

export { MAX_ARCHIVE_BYTES };
