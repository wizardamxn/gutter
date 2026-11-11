import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { streamChat } from '../../shared/providers';
import { PROVIDERS, type HostedInfo, type Provider } from '../../shared/types';
import { requireAuth } from './auth';
import { env } from './env';
import { Usage } from './models';

const chatBody = z.object({
  provider: z.enum(['openai', 'anthropic', 'gemini']),
  system: z.string().max(100_000),
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(20_000) }))
    .min(1)
    .max(60)
});

const today = () => new Date().toISOString().slice(0, 10);
const available = (): Provider[] => PROVIDERS.filter((p) => !!env.keys[p]);

export const aiRouter = Router();
aiRouter.use(requireAuth);

// Which hosted models this server offers, and how much of today's allowance is used.
aiRouter.get('/providers', async (_req, res) => {
  const usage = await Usage.findOne({ userId: res.locals.userId, day: today() }).lean();
  const providers = available();
  const info: HostedInfo = {
    providers,
    models: Object.fromEntries(providers.map((p) => [p, env.models[p]])),
    dailyLimit: env.dailyLimit,
    usedToday: usage?.count ?? 0
  };
  res.json(info);
});

// Hosted side question. Streams the answer back as server-sent events:
//   data: {"t":"text chunk"}   ...   data: {"error":"..."}   data: [DONE]
aiRouter.post(
  '/chat',
  rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }),
  async (req, res) => {
    const parsed = chatBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request.' });
      return;
    }
    const { provider, system, messages } = parsed.data;
    if (!env.keys[provider]) {
      res.status(400).json({ error: 'That model is not available on Gutter right now.' });
      return;
    }

    // Count this question against today's allowance (atomic, so parallel requests can't slip past).
    const filter = { userId: res.locals.userId, day: today() };
    const usage = await Usage.findOneAndUpdate(filter, { $inc: { count: 1 } }, { upsert: true, new: true }).lean();
    if ((usage?.count ?? 0) > env.dailyLimit) {
      await Usage.updateOne(filter, { $inc: { count: -1 } });
      res.status(429).json({
        error: `You've used today's ${env.dailyLimit} free side questions. Add your own API key in settings to keep going.`
      });
      return;
    }

    res.status(200).set({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.flushHeaders();

    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

    try {
      const stream = streamChat({
        provider,
        apiKey: env.keys[provider],
        model: env.models[provider],
        system,
        messages,
        signal: abort.signal
      });
      for await (const chunk of stream) send({ t: chunk });
      res.write('data: [DONE]\n\n');
    } catch (err) {
      if (!abort.signal.aborted) {
        // Log the detail; tell the client only that it failed.
        console.error('[ai] upstream error:', err instanceof Error ? err.message : err);
        send({ error: 'The model had a problem answering. Try again, or pick another model.' });
        // Failed answers don't count.
        await Usage.updateOne(filter, { $inc: { count: -1 } }).catch(() => {});
      }
    } finally {
      res.end();
    }
  }
);
