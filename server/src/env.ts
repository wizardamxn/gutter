import 'dotenv/config';
import { DEFAULT_MODELS } from '../../shared/providers';
import type { Provider } from '../../shared/types';

const jwtSecret = process.env.JWT_SECRET ?? '';
if (jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be set to a random string of at least 32 characters (see .env.example).');
}

const keys: Record<Provider, string> = {
  openai: process.env.OPENAI_API_KEY ?? '',
  anthropic: process.env.ANTHROPIC_API_KEY ?? '',
  gemini: process.env.GEMINI_API_KEY ?? ''
};

const models: Record<Provider, string> = {
  openai: process.env.OPENAI_MODEL || DEFAULT_MODELS.openai,
  anthropic: process.env.ANTHROPIC_MODEL || DEFAULT_MODELS.anthropic,
  gemini: process.env.GEMINI_MODEL || DEFAULT_MODELS.gemini
};

export const env = {
  port: Number(process.env.PORT ?? 4000),
  mongoUri: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/gutter',
  jwtSecret,
  keys,
  models,
  /** Hosted side questions each signed-in user gets per day. */
  dailyLimit: Number(process.env.FREE_DAILY_LIMIT ?? 25),
  /** If set, only this extension id may call the API from a browser. */
  extensionId: process.env.EXTENSION_ID ?? '',
  /** Required to PUT a new selector config. Unset = endpoint disabled. */
  adminToken: process.env.ADMIN_TOKEN ?? ''
};
