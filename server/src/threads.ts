import { Router } from 'express';
import { z } from 'zod';
import type { Thread } from '../../shared/types';
import { requireAuth } from './auth';
import { ThreadModel } from './models';

const idPattern = /^[\w-]{8,64}$/;

const threadBody = z.object({
  convKey: z.string().min(1).max(500),
  site: z.string().max(40),
  title: z.string().max(300),
  quote: z.string().max(8000),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(100_000),
        via: z.string().max(80).optional(),
        error: z.boolean().optional()
      })
    )
    .max(200),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  deleted: z.boolean().optional()
});

function toClient(doc: any): Thread {
  return {
    id: doc.clientId,
    convKey: doc.convKey,
    site: doc.site,
    title: doc.title,
    quote: doc.quote,
    messages: (doc.messages ?? []).map((m: any) => ({
      role: m.role,
      content: m.content,
      ...(m.via ? { via: m.via } : {}),
      ...(m.error ? { error: true } : {})
    })),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    ...(doc.deleted ? { deleted: true } : {})
  };
}

export const threadsRouter = Router();
threadsRouter.use(requireAuth);

// All of the user's side threads for one main chat (including delete markers).
threadsRouter.get('/', async (req, res) => {
  const convKey = req.query.convKey;
  if (typeof convKey !== 'string' || !convKey || convKey.length > 500) {
    res.status(400).json({ error: 'convKey is required.' });
    return;
  }
  const docs = await ThreadModel.find({ userId: res.locals.userId, convKey }).sort({ createdAt: 1 }).lean();
  res.json({ threads: docs.map(toClient) });
});

// Create or update one thread. The newest `updatedAt` wins.
threadsRouter.put('/:id', async (req, res) => {
  const id = req.params.id;
  const parsed = threadBody.safeParse(req.body);
  if (typeof id !== 'string' || !idPattern.test(id) || !parsed.success) {
    res.status(400).json({ error: 'Invalid thread.' });
    return;
  }
  const filter = { userId: res.locals.userId, clientId: id };
  const existing = await ThreadModel.findOne(filter).lean();
  if (existing && existing.updatedAt > parsed.data.updatedAt) {
    res.json({ thread: toClient(existing), stale: true });
    return;
  }
  const body = parsed.data;
  const saved = await ThreadModel.findOneAndUpdate(
    filter,
    {
      $set: {
        ...body,
        // A deleted thread keeps only its marker.
        ...(body.deleted ? { messages: [], quote: '', title: '' } : {}),
        deleted: !!body.deleted
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  res.json({ thread: toClient(saved), stale: false });
});
