import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/index.mjs';

test('Vercel cloud health route dapat dijalankan tanpa membocorkan secret', async () => {
  const headers = {};
  let payload = '';
  const request = { method: 'GET', url: '/api/index?route=health', query: { route: 'health' }, headers: {} };
  const response = {
    statusCode: 0,
    setHeader(name, value) { headers[name] = value; },
    end(value) { payload = value; }
  };
  await handler(request, response);
  const body = JSON.parse(payload);
  assert.equal(response.statusCode, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.database, 'supabase');
  assert.equal(Object.hasOwn(body, 'serviceRoleKey'), false);
  assert.equal(headers['cache-control'], 'no-store');
});
