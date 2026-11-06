import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BudgetLedger } from '../server/budget.mjs';
import { createAliyunProvider, createAliyunTransport } from '../server/aliyun.mjs';

test('monetary reservations persist across restarts and rejected/unknown calls consume their reservation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qiban-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'budget.sqlite');
  let ledger = new BudgetLedger(path, { limitCny: 1, maxCalls: 4 });
  const id = ledger.reserve('qwen3.8-flash', 1000, 100);
  ledger.finish(id, { status: 'uncertain', errorCode: 'TIMEOUT' }); ledger.close();
  ledger = new BudgetLedger(path, { limitCny: 1, maxCalls: 4 });
  for (let i = 0; i < 3; i++) ledger.reserve('qwen3.8-flash', 1000, 100);
  assert.equal(ledger.summary().reservedCny, 1);
  assert.throws(() => ledger.reserve('qwen3.8-flash', 1000, 100), { code: 'BUDGET_EXHAUSTED' });
  assert.throws(() => ledger.reserve('expensive-other-model', 1000, 100), { code: 'BUDGET_REQUEST_LIMIT' });
  assert.throws(() => ledger.reserve('qwen3.8-flash', 40001, 100), { code: 'BUDGET_REQUEST_LIMIT' });
  assert.throws(() => ledger.reserve('qwen3.8-flash', 1000, 2049), { code: 'BUDGET_REQUEST_LIMIT' });
  ledger.close();
});

test('Aliyun adapter uses only official hosts, caps output and records usage without retaining secrets', async () => {
  const ledger = new BudgetLedger(':memory:');
  let sent;
  const generate = createAliyunProvider({ apiKey: 'local-test-secret', ledger, fetchImpl: async (url, options) => {
    sent = { url, body: JSON.parse(options.body), redirect: options.redirect };
    return new Response(JSON.stringify({ id: 'test-request', usage: { prompt_tokens: 100, completion_tokens: 20 }, choices: [{ finish_reason: 'stop', message: { content: '{"reply":"我在","memories":[],"plan":null}' } }] }));
  } });
  const reply = await generate([{ role: 'developer', content: '测试' }, { role: 'user', content: '你好' }]);
  assert.equal(reply.reply, '我在'); assert.equal(sent.body.messages[0].role, 'system');
  assert.equal(sent.body.max_tokens, 2048); assert.equal(sent.body.enable_thinking, false);
  assert.equal(sent.body.response_format.json_schema.strict, true); assert.equal(sent.redirect, 'error');
  assert.equal(ledger.summary().inputTokens, 100); assert.equal(ledger.summary().reservedCny, .25);
  assert.equal(JSON.stringify(ledger.summary()).includes('local-test-secret'), false);
  assert.throws(() => createAliyunProvider({ apiKey: 'test', baseURL: 'https://evil.example/v1', ledger }));
  const call = createAliyunTransport({ apiKey: 'test', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', ledger });
  await assert.rejects(call({ model: 'qwen3.8-flash', max_tokens: 100, enable_thinking: true }), { code: 'BUDGET_REQUEST_LIMIT' });
  assert.equal(ledger.summary().attempts, 1); ledger.close();
});

test('failed authentication never retries or downgrades to a different provider', async () => {
  const ledger = new BudgetLedger(':memory:'); let calls = 0;
  const generate = createAliyunProvider({ apiKey: 'test', ledger, fetchImpl: async () => {
    calls++; return new Response('{"error":{"code":"invalid_api_key"}}', { status: 401 });
  } });
  await assert.rejects(generate([{ role: 'user', content: 'hi' }]), { upstreamStatus: 401 });
  assert.equal(calls, 1); assert.equal(ledger.summary().calls[0].status, 'rejected'); assert.equal(ledger.summary().reservedCny, .25);
  ledger.close();
});
