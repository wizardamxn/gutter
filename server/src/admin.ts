import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { env } from './env';
import { User } from './models';

export function isAdmin(token: unknown): boolean {
  if (!env.adminToken || typeof token !== 'string') return false;
  const a = Buffer.from(token);
  const b = Buffer.from(env.adminToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

const planBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  plan: z.enum(['free', 'paid'])
});

export const adminRouter = Router();

// Until billing exists, accounts are marked paid by hand:
//   curl -X PUT $API/api/admin/plan -H "x-admin-token: $ADMIN_TOKEN" \
//        -H "content-type: application/json" -d '{"email":"a@b.com","plan":"paid"}'
adminRouter.put('/plan', async (req, res) => {
  if (!isAdmin(req.headers['x-admin-token'])) {
    res.status(404).json({ error: 'Not found.' });
    return;
  }
  const parsed = planBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Send { email, plan: "free" | "paid" }.' });
    return;
  }
  const user = await User.findOneAndUpdate({ email: parsed.data.email }, { $set: { plan: parsed.data.plan } }, { new: true });
  if (!user) {
    res.status(404).json({ error: 'No account with that email.' });
    return;
  }
  res.json({ email: user.email, plan: user.plan, smartUsed: user.smartUsed });
});
