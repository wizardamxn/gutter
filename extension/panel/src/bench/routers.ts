// Bench only: the routers the hybrid was chosen over, kept so the comparison can be re-run.
// The product uses lib/router.ts `hybrid` alone.
import { classify } from '../lib/ai';
import { routeWithNano } from '../lib/nano';
import { hybrid, parseRoute, SEMANTIC, semanticMargin, type Router } from '../lib/router';

export type RouterName = 'rules' | 'semantic' | 'nano' | 'hybrid';

export const ROUTERS: Record<RouterName, Router> = {
  /** The old word-list classifier. */
  rules: async (question) => classify(question),
  /** Semantic only: unsure or no matcher → explain. */
  semantic: async (question) => {
    const m = await semanticMargin(question);
    return m !== null && m >= SEMANTIC.margin ? 'lookup' : 'explain';
  },
  /** Built-in model only: unparseable or unavailable → explain. */
  nano: async (question, previous) => parseRoute(await routeWithNano(question, previous).catch(() => '')),
  /** The live router. */
  hybrid: async (question, previous) => (await hybrid(question, previous)).mode
};
