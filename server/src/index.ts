import mongoose from 'mongoose';
import { createApp } from './app';
import { env } from './env';
import { PROVIDERS } from '../../shared/types';

async function main() {
  await mongoose.connect(env.mongoUri);
  const hosted = PROVIDERS.filter((p) => env.keys[p]);
  createApp().listen(env.port, () => {
    console.log(`Gutter server on http://localhost:${env.port}`);
    console.log(`Hosted models: ${hosted.length ? hosted.join(', ') : 'none (set API keys in .env)'}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
