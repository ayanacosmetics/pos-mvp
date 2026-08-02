import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { handleApiRequest } from '../cloudflare/worker.mjs';

test('adapter Cloudflare meneruskan endpoint health ke API yang sama', async () => {
  const response = await handleApiRequest(new Request('https://example.test/api/health'));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.version, '2.17.1-cloud');
});

test('adapter Cloudflare meneruskan aset non-API ke binding ASSETS', async () => {
  let requestedUrl = null;
  const request = new Request('https://example.test/products');
  const response = await worker.fetch(request, {
    ASSETS: {
      fetch(assetRequest) {
        requestedUrl = assetRequest.url;
        return new Response('asset');
      }
    }
  });
  assert.equal(requestedUrl, request.url);
  assert.equal(await response.text(), 'asset');
});
