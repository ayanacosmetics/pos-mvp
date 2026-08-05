import vercelHandler from '../api/index.mjs';

function nodeHeaders(headers) {
  const result = {};
  for (const [name, value] of headers.entries()) result[name.toLowerCase()] = value;
  return result;
}

async function nodeRequest(request, executionContext) {
  const url = new URL(request.url);
  const query = {};
  for (const [name, value] of url.searchParams.entries()) {
    const current = query[name];
    query[name] = current === undefined ? value : Array.isArray(current) ? [...current, value] : [current, value];
  }

  let body;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const text = await request.text();
    if (text) body = text;
  }

  return {
    method: request.method,
    url: request.url,
    headers: nodeHeaders(request.headers),
    query,
    body,
    waitUntil: executionContext?.waitUntil ? (promise) => executionContext.waitUntil(promise) : undefined
  };
}

function nodeResponse() {
  const headers = new Headers();
  return {
    statusCode: 200,
    body: null,
    setHeader(name, value) {
      if (Array.isArray(value)) {
        headers.delete(name);
        for (const item of value) headers.append(name, String(item));
        return;
      }
      headers.set(name, String(value));
    },
    end(value = null) {
      this.body = value;
    },
    toResponse() {
      return new Response(this.body, { status: this.statusCode, headers });
    }
  };
}

export async function handleApiRequest(request, executionContext) {
  const incoming = await nodeRequest(request, executionContext);
  const outgoing = nodeResponse();
  await vercelHandler(incoming, outgoing);
  return outgoing.toResponse();
}

export default {
  async fetch(request, env, executionContext) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, executionContext);
    }
    return env.ASSETS.fetch(request);
  }
};
