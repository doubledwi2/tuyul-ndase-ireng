import { open } from 'node:fs/promises';

export async function syncDirectory(path: string, sync = async () => {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}): Promise<boolean> {
  try { await sync(); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (['EINVAL', 'ENOTSUP', 'EISDIR', 'ENOSYS'].includes(code ?? '')) return false;
    throw error;
  }
}
