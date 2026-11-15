import { test } from 'node:test';
import assert from 'node:assert/strict';
import create, { ImageSources, pocketApi } from '../stable-fast-3d.ts';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { AssistantEntry, createRegistry, defineExtension, defineTool, Harness, MemoryStorage, ToolTask } from '@earendil-works/pi-durable';
import { obj } from '@earendil-works/pi-schema';

test('module registers settings, one tool, and owner-only commands', async () => {
  const settings = { endpoint: 'http://stable-fast-3d:8000', timeoutMinutes: 30 }, commands = new Map(); let declared, options, client;
  const extension = create({ dataDir: '/tmp/example-data', cwdOf: () => '/tmp/workspace' }, {
    settings: (fields, given) => { declared = fields; options = given; }, setting: name => settings[name],
    client: (entry, access) => { client = { entry, ...access }; },
    command: (name, spec) => commands.set(name, spec), error: (_status, message) => new Error(message),
  });
  assert.equal(pocketApi, 2); assert.equal(extension.name, 'stable-fast-3d');
  assert.equal(declared.find(s => s.name === 'endpoint').default, 'http://stable-fast-3d:8000');
  assert.equal(declared.find(s => s.name === 'timeoutMinutes').default, 30);
  assert.deepEqual(options, { sheet: 'settings' });
  assert.deepEqual(client, { entry: 'stable-fast-3d-browser', access: 'owner' });
  assert.equal(extension.hooks.length, 1);
  const instructions = await extension.sections[0].render({ conversationId: 7 });
  assert.match(instructions, /\/tmp\/workspace\/\.sf3d-inputs\/7/);
  assert.equal(extension.tools.length, 1);
  const tool = extension.tools[0]; assert.equal(tool.name, 'sf3d_generate'); assert.equal(tool.replay, 'safe');
  assert.deepEqual(tool.parameters.required, ['image']);
  for (const command of commands.values()) assert.equal(command.scope, 'global');
  for (const name of ['sf3d-reset', 'sf3d-recover']) {
    await assert.rejects(commands.get(name).handler('some-key', { user: { role: 'member' } }), /owner/);
    await assert.rejects(commands.get(name).handler('', { user: { role: 'owner' } }), /Use/);
  }
});

test('real durable hooks record direct and nested SD calls without granting another conversation access', async t => {
  const context = BACKGROUND_CONTEXT, registry = createRegistry();
  const extension = create({ dataDir: '/tmp/data', cwdOf: () => '/tmp/workspace' }, {
    settings() {}, setting: name => name === 'endpoint' ? 'http://localhost:8000' : 30,
    client() {}, command() {},
  });
  registry.install(extension);
  const path = '/tmp/data/extensions/stable-diffusion/outputs/test.png';
  registry.install(defineExtension({ name: 'fake-sd', tools: [
    defineTool({ name: 'sd_generate', parameters: obj({}), execute: async () => ({
      output: [], details: { path, sha256: 'a'.repeat(64) },
    }) }),
    defineTool({ name: 'nested_sd', parameters: obj({}), execute: async (_args, api, ctx) => {
      const result = await api.executeTool('sd_generate', {}, ctx);
      assert.equal(result.isError, false);
      return { output: [] };
    } }),
  ] }));
  const reports = [];
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry, onReport: r => reports.push({ ...r, error: String(r.error) }) }, context);
  t.after(() => harness.close(context));
  const root = await harness.root(context);
  for (const [i, name] of ['sd_generate', 'nested_sd'].entries()) {
    const id = await root.commit(async tx => {
      const entry = await tx.appendEntry(AssistantEntry, root.id, { model: [{
        role: 'assistant', content: [{ type: 'toolCall', id: 'call' + i, name, arguments: {} }],
        api: 'openai-responses', provider: 'test', model: 'test', stopReason: 'toolUse', timestamp: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      }] });
      return tx.createTask(ToolTask, { kind: 'model', assistant: entry.id, callId: 'call' + i }, { ownership: { kind: 'conversation' } });
    }, context);
    const settled = await harness.waitForTask(id, context);
    assert.equal(settled.state.status, 'terminal');
    assert.equal(settled.state.outcome.status, 'completed');
    const sources = await harness.snapshot(ImageSources, root.id, context);
    assert.ok(sources, JSON.stringify({ reports, entry: await root.commit(tx => tx.entry(settled.state.outcome.result.entryId), context) }));
    assert.deepEqual(sources.images, { [path]: 'a'.repeat(64) });
    // Clear between calls so the nested call must record its own result.
    await root.commit(async tx => { (await tx.doc(ImageSources, root.id)).images = {}; }, context);
  }
  assert.equal(reports.length, 0);
  const other = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
  assert.equal(await harness.snapshot(ImageSources, other.id, context), undefined);
});
