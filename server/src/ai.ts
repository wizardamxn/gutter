import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { streamChat } from '../../shared/providers';
import { PROVIDERS, type HostedInfo, type Provider } from '../../shared/types';
import { requireAuth } from './auth';
import { env } from './env';
import { User } from './models';

// "Smart" answers: cloud models paid for by Gutter.
// Free accounts get env.freeLimit answers in total; paid accounts are not limited.

const chatBody = z.object({
  provider: z.enum(['openai', 'anthropic', 'gemini']),
  system: z.string().max(100_000),
  messages: z
    // The last user message carries the chat as a document (up to 60,000 characters plus the rules).
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(70_000) }))
    .min(1)
    .max(60)
});

const available = (): Provider[] => PROVIDERS.filter((p) => !!env.keys[p]);

export const aiRouter = Router();
aiRouter.use(requireAuth);

// Which smart models this server offers, the user's plan, and how many free answers are used.
aiRouter.get('/providers', async (_req, res) => {
  const user = await User.findById(res.locals.userId).select('plan smartUsed').lean();
  if (!user) {
    res.status(401).json({ error: 'Please sign in again.' });
    return;
  }
  const providers = available();
  const info: HostedInfo = {
    providers,
    models: Object.fromEntries(providers.map((p) => [p, env.models[p]])),
    plan: user.plan === 'paid' ? 'paid' : 'free',
    freeLimit: env.freeLimit,
    used: user.smartUsed ?? 0
  };
  res.json(info);
});

// One smart answer, streamed back as server-sent events:
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
      res.status(400).json({ error: 'That model is not available right now.' });
      return;
    }

    // Count the answer. For free accounts the check and the increment are one atomic
    // update, so parallel requests can't slip past the limit.
    const userId = res.locals.userId;
    const counted = await User.findOneAndUpdate(
      { _id: userId, $or: [{ plan: 'paid' }, { smartUsed: { $lt: env.freeLimit } }] },
      { $inc: { smartUsed: 1 } }
    ).lean();
    if (!counted) {
      const exists = await User.exists({ _id: userId });
      if (!exists) {
        res.status(401).json({ error: 'Please sign in again.' });
        return;
      }
      res.status(402).json({
        code: 'upgrade',
        error: `You've used your ${env.freeLimit} free smart answers.`
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
        await User.updateOne({ _id: userId }, { $inc: { smartUsed: -1 } }).catch(() => {});
      }
    } finally {
      res.end();
    }
  }
);
