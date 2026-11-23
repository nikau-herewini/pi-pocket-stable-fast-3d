/**
 * Convert one conversation-scoped image into a textured 3D GLB through an owner-configured
 * self-hosted Stable Fast 3D service. Accepts uploads, recorded SD outputs, and processed inputs.
 * Writes GLB outputs below the data folder and durable receipts in Pi Pocket.
 * Adds an owner-only browser settings sheet; no public routes or telemetry.
 *
 * @title Stable Fast 3D
 */
import { join } from 'node:path';
import { defineDoc, defineExtension, defineTool, hook, section, ToolTask } from '@earendil-works/pi-durable';
import { obj, str } from '@earendil-works/pi-schema';
import { configuration } from './stable-fast-3d/config.mjs';
import { createService } from './stable-fast-3d/service.mjs';
import { processedDirectory, recordGeneratedImage } from './stable-fast-3d/sources.mjs';

export const pocketApi = 2;
export const ModelLock = defineDoc({
  kind: 'x.stable-fast-3d.lock', version: 1, scope: 'session',
  initial: () => ({}), checkpointWhen: () => true,
});

export const ImageSources = defineDoc({
  kind: 'x.stable-fast-3d.sources', version: 1, scope: 'conversation',
  initial: () => ({ images: {} }), checkpointWhen: () => true,
});

export default function stableFast3d(host, web) {
  if (typeof web.settings !== 'function' || typeof web.setting !== 'function') {
    throw new Error('This extension requires Pi Pocket extension settings support (0.22 or newer).');
  }
  web.settings([
    { name: 'endpoint', label: 'Service URL', type: 'text', default: 'http://stable-fast-3d:8000', description: 'Owner-trusted http(s) URL reachable from Pi Pocket. No credentials in the URL.' },
    { name: 'timeoutMinutes', label: 'Generation timeout (minutes)', type: 'number', default: 30, min: 1, max: 120 },
  ], { sheet: 'settings' });
  web.client('stable-fast-3d-browser', { access: 'owner' });
  const config = () => configuration({ endpoint: web.setting('endpoint'), timeoutMinutes: web.setting('timeoutMinutes') });
  const directory = join(host.dataDir, 'extensions', 'stable-fast-3d', 'outputs');
  const processedDir = id => processedDirectory(host.cwdOf(id), id);
  const service = createService(directory, ModelLock, config, {
    dataDir: host.dataDir,
    publishPreview: typeof host.publishModelPreview === 'function' ? (id, bytes) => host.publishModelPreview(id, bytes) : undefined,
    sources: async (api, context) => ({
      processedDir: processedDir(api.conversationId),
      generatedImages: (await api.snapshot(ImageSources, api.conversationId, context))?.images ?? {},
    }),
  });
  const generate = defineTool({
    name: 'sf3d_generate',
    description: 'Convert 1 PNG or JPEG into a textured 3D GLB using the local Stable Fast 3D backend. Use an absolute path to this conversation’s upload, recorded sd_generate output, or processed-image folder (see sf3d_inputs). At most 10 MB and 16 million pixels. Returns the saved GLB path and metadata. On supported Pi Pocket builds the successful result includes a View in 3D action; otherwise preview the GLB with the artifact tool. One call at a time across conversations. Unknown submissions are never retried automatically.',
    parameters: obj({
      image: str({ minLength: 1, maxLength: 4096, description: 'Absolute path to an allowed image from this conversation.' }),
    }),
    replay: 'safe', execute: (args, api, context) => service.generate(args, api, context),
  });
  web.command('sf3d-status', {
    description: 'Inspect the global Stable Fast 3D lock and known submission', scope: 'global',
    handler: async (_args, ctx) => ({ type: 'card', output: await service.inspect((await ctx.snapshot(ModelLock, ctx.context))?.active) }),
  });
  for (const reset of [false, true]) web.command(reset ? 'sf3d-reset' : 'sf3d-recover', {
    description: reset ? 'Release an unknown request only after restarting the backend' : 'Release a stopped call only after confirming the backend is idle',
    args: reset ? '<lock-key> backend-restarted' : '<lock-key>', scope: 'global',
    handler: async (args, ctx) => {
      if (ctx.user.role !== 'owner') throw web.error(403, 'Only the owner can recover Stable Fast 3D generation.');
      const parts = args.trim().split(/\s+/);
      if (parts.length !== (reset ? 2 : 1) || !parts[0] || (reset && parts[1] !== 'backend-restarted')) throw web.error(400, reset ? 'Use /sf3d-reset <lock-key> backend-restarted after restarting the backend.' : 'Use /sf3d-recover <lock-key>.');
      const active = (await ctx.snapshot(ModelLock, ctx.context))?.active;
      if (!active || active.key !== parts[0]) throw web.error(409, 'Lock changed. Use /sf3d-status again.');
      try { await service.recover(active); }
      catch (error) { throw web.error(409, error instanceof Error && error.message.startsWith('SF3D:') ? error.message : 'Recovery failed. Check settings and backend state.'); }
      await ctx.commit(async tx => {
        const lock = await tx.doc(ModelLock);
        if (lock.active?.key !== active.key || service.isRunning(active.key)) throw web.error(409, 'Lock changed or its call is running. Use /sf3d-status again.');
        delete lock.active;
      });
      return { type: 'toast', level: 'info', message: 'Lock released. The previous submission will not be repeated.' };
    },
  });
  return defineExtension({
    name: 'stable-fast-3d', tools: [generate],
    hooks: [hook(ToolTask, {
      afterTool: (call, result, api, context) => recordGeneratedImage(call, result, api, context, ImageSources),
    })],
    sections: [section('sf3d_inputs', input => {
      const folder = processedDir(input.conversationId);
      return 'Stable Fast 3D accepts this conversation’s uploads and sd_generate outputs recorded while this extension is enabled.'
        + (folder ? ` For programmatically resized/compressed images, create ${folder} and save the PNG/JPEG there. Older SD outputs can also be copied there. Do not modify the originals.` : ' Processed-image inputs require a local workspace.');
    })],
  });
}
