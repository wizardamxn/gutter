import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { DEFAULT_SELECTORS, isSelectorConfig, type SelectorConfig } from '../../shared/selectors';
import { env } from './env';
import { SelectorDoc } from './models';

export const configRouter = Router();

function isAdmin(token: unknown): boolean {
  if (!env.adminToken || typeof token !== 'string') return false;
  const a = Buffer.from(token);
  const b = Buffer.from(env.adminToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Public: the extension polls this to learn how to read each chat site.
// Serves the newest config saved in MongoDB, or the built-in default.
configRouter.get('/selectors', async (_req, res) => {
  let config: SelectorConfig = DEFAULT_SELECTORS;
  const doc = await SelectorDoc.findOne().sort({ version: -1 }).lean();
  if (doc && doc.version >= DEFAULT_SELECTORS.version) {
    const candidate = { version: doc.version, sites: doc.sites };
    if (isSelectorConfig(candidate)) config = candidate;
  }
  res.set('cache-control', 'public, max-age=300').json(config);
});

// Admin: publish a fixed config when a site changes its markup.
//   curl -X PUT $API/api/config/selectors -H "x-admin-token: $ADMIN_TOKEN" \
//        -H "content-type: application/json" -d @selectors.json
configRouter.put('/selectors', async (req, res) => {
  if (!isAdmin(req.headers['x-admin-token'])) {
    res.status(404).json({ error: 'Not found.' });
    return;
  }
  if (!isSelectorConfig(req.body)) {
    res.status(400).json({ error: 'Invalid selector config.' });
    return;
  }
  await SelectorDoc.create({ version: req.body.version, sites: req.body.sites });
  res.json({ ok: true, version: req.body.version });
});
