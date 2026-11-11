import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { aiRouter } from './ai';
import { authRouter } from './auth';
import { configRouter } from './config';
import { env } from './env';
import { threadsRouter } from './threads';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // one reverse proxy in front (needed for rate limiting by IP)
  app.use(helmet());

  // Browsers: only the extension may call the API. Auth is a bearer token, not cookies.
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin) return cb(null, true); // curl, server-to-server
        const ok = env.extensionId
          ? origin === `chrome-extension://${env.extensionId}`
          : origin.startsWith('chrome-extension://');
        cb(null, ok);
      },
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['content-type', 'authorization']
    })
  );
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api/auth', authRouter);
  app.use('/api/threads', threadsRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/config', configRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number })?.status;
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: 'Bad request.' });
      return;
    }
    console.error('[server] unhandled error:', err);
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return app;
}
