import { Router, type NextFunction, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from './env';
import { User } from './models';

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(200)
});

function sign(userId: string): string {
  return jwt.sign({ sub: userId }, env.jwtSecret, { expiresIn: '30d' });
}

/** Requires `Authorization: Bearer <token>`; puts the user id in res.locals.userId. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    const payload = jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] });
    if (typeof payload === 'string' || typeof payload.sub !== 'string') throw new Error('bad token');
    res.locals.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: 'Please sign in again.' });
  }
}

export const authRouter = Router();

// Slow down password guessing.
authRouter.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));

authRouter.post('/signup', async (req, res) => {
  const parsed = credentials.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Enter a valid email and a password of at least 8 characters.' });
    return;
  }
  const { email, password } = parsed.data;
  if (await User.exists({ email })) {
    res.status(409).json({ error: 'That email already has an account. Try signing in.' });
    return;
  }
  const user = await User.create({ email, passwordHash: await bcrypt.hash(password, 12) });
  res.status(201).json({ token: sign(String(user._id)), email });
});

authRouter.post('/login', async (req, res) => {
  const parsed = credentials.safeParse(req.body);
  const user = parsed.success ? await User.findOne({ email: parsed.data.email }) : null;
  const ok = !!user && parsed.success && (await bcrypt.compare(parsed.data.password, user.passwordHash));
  if (!user || !ok) {
    res.status(401).json({ error: 'Wrong email or password.' });
    return;
  }
  res.json({ token: sign(String(user._id)), email: user.email });
});

authRouter.get('/me', requireAuth, async (_req, res) => {
  const user = await User.findById(res.locals.userId).select('email');
  if (!user) {
    res.status(401).json({ error: 'Please sign in again.' });
    return;
  }
  res.json({ email: user.email });
});
