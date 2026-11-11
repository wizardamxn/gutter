// Thread sync with the Gutter server. Local storage stays the source of truth
// for the UI; sync is best-effort and never blocks asking.
import type { Thread } from '../../../../shared/types';
import { api } from './api';
import type { Auth } from './storage';

/** Merge the server's copy into the local list. Newest `updatedAt` wins per thread. */
export async function pullAndMerge(auth: Auth, convKey: string, local: Thread[]): Promise<Thread[]> {
  const { threads: remote } = await api.listThreads(auth.token, convKey);
  const byId = new Map(local.map((t) => [t.id, t]));
  const remoteIds = new Set<string>();

  for (const r of remote) {
    remoteIds.add(r.id);
    const mine = byId.get(r.id);
    if (!mine || r.updatedAt > mine.updatedAt) byId.set(r.id, r);
  }
  const merged = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);

  // Upload anything the server lacks or has an older copy of (e.g. made while signed out).
  const remoteById = new Map(remote.map((r) => [r.id, r]));
  for (const t of merged) {
    const r = remoteById.get(t.id);
    if (!remoteIds.has(t.id) || (r && t.updatedAt > r.updatedAt)) void push(auth, t);
  }
  return merged;
}

export async function push(auth: Auth | null, thread: Thread): Promise<void> {
  if (!auth) return;
  try {
    await api.putThread(auth.token, thread);
  } catch {
    // Offline or server down: the thread is still saved locally and uploads on the next pull.
  }
}
