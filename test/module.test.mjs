import { test } from 'node:test';
import assert from 'node:assert/strict';
import create, { pocketApi } from '../stable-fast-3d.ts';

test('module registers settings, one tool, and owner-only commands', async () => {
  const settings = { endpoint: 'http://stable-fast-3d:8000', timeoutMinutes: 30 }, commands = new Map(); let declared, options, client;
  const extension = create({ dataDir: '/tmp/example-data' }, {
    settings: (fields, given) => { declared = fields; options = given; }, setting: name => settings[name],
    client: (entry, access) => { client = { entry, ...access }; },
    command: (name, spec) => commands.set(name, spec), error: (_status, message) => new Error(message),
  });
  assert.equal(pocketApi, 2); assert.equal(extension.name, 'stable-fast-3d');
  assert.equal(declared.find(s => s.name === 'endpoint').default, 'http://stable-fast-3d:8000');
  assert.equal(declared.find(s => s.name === 'timeoutMinutes').default, 30);
  assert.deepEqual(options, { sheet: 'settings' });
  assert.deepEqual(client, { entry: 'stable-fast-3d-browser', access: 'owner' });
  assert.equal(extension.tools.length, 1);
  const tool = extension.tools[0]; assert.equal(tool.name, 'sf3d_generate'); assert.equal(tool.replay, 'safe');
  assert.deepEqual(tool.parameters.required, ['image']);
  for (const command of commands.values()) assert.equal(command.scope, 'global');
  for (const name of ['sf3d-reset', 'sf3d-recover']) {
    await assert.rejects(commands.get(name).handler('some-key', { user: { role: 'member' } }), /owner/);
    await assert.rejects(commands.get(name).handler('', { user: { role: 'owner' } }), /Use/);
  }
});
