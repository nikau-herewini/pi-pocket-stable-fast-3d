import { isAbsolute, join } from 'node:path';

// A separate subfolder keeps processed inputs out of other conversations' scope.
export function processedDirectory(cwd, conversationId) {
  return typeof cwd === 'string' && isAbsolute(cwd)
    ? join(cwd, '.sf3d-inputs', String(conversationId)) : undefined;
}

export async function recordGeneratedImage(call, result, api, context, Sources) {
  if (call.name !== 'sd_generate' || result.diagnostics?.length) return;
  const saved = result.details;
  if (typeof saved?.path !== 'string' || !isAbsolute(saved.path) || !/^[a-f0-9]{64}$/.test(saved.sha256 ?? '')) return;
  await api.commit(async tx => {
    const sources = await tx.doc(Sources, api.conversationId);
    sources.images[saved.path] = saved.sha256;
  }, context);
}
