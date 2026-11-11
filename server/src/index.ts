import dns from 'node:dns';
import mongoose from 'mongoose';
import { createApp } from './app';
import { env } from './env';
import { PROVIDERS } from '../../shared/types';

async function main() {
  // Node on Windows can pick 127.0.0.1 as its DNS server, which refuses the SRV lookup
  // mongodb+srv:// needs (querySrv ECONNREFUSED). Only affects dns.resolve*, not normal lookups.
  if (env.mongoUri.startsWith('mongodb+srv://')) dns.setServers(['1.1.1.1', '8.8.8.8']);
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
