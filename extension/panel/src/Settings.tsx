import { useState } from 'react';
import { PROVIDER_LABEL } from '../../../shared/providers';
import { PROVIDERS, type HostedInfo } from '../../../shared/types';
import { api } from './lib/api';
import type { NanoStatus } from './lib/nano';
import type { Auth, Settings as SettingsData } from './lib/storage';

interface Props {
  settings: SettingsData;
  auth: Auth | null;
  hosted: HostedInfo | null;
  nano: NanoStatus | 'checking';
  onSettings: (next: SettingsData) => void;
  onAuth: (auth: Auth | null) => void;
}

const KEY_HINT = { openai: 'sk-…', anthropic: 'sk-ant-…', gemini: 'AIza…' } as const;

const NANO_TEXT: Record<NanoStatus | 'checking', string> = {
  checking: 'Checking…',
  available: 'Ready. Free and unlimited. It runs on this computer, so your chat never leaves it.',
  downloadable: 'Chrome downloads it the first time you ask (about 4 GB, one time). Free and unlimited after that.',
  downloading: 'Chrome is downloading it now. You can ask as soon as it finishes.',
  unavailable: "This computer or browser can't run it. Use a smart model instead."
};

export function Settings({ settings, auth, hosted, nano, onSettings, onAuth }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  const submit = async (mode: 'login' | 'signup') => {
    setError('');
    setWorking(true);
    try {
      onAuth(await api[mode](email.trim(), password));
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="settings">
      <section>
        <h2>Built-in model</h2>
        <p className="muted nano-status" data-status={nano}>
          {NANO_TEXT[nano]}
        </p>
        <p className="muted">It is a small model: good for explaining and summarizing, less reliable for checking facts, and it only sees the recent part of a long chat.</p>
      </section>

      <section>
        <h2>Smart models</h2>
        {auth ? (
          <>
            <p>
              Signed in as <b>{auth.email}</b>. Your side notes sync to this account.
            </p>
            {hosted && (
              <p className="muted smart-usage">
                {!hosted.providers.length
                  ? 'Smart models are not available right now.'
                  : hosted.plan === 'paid'
                    ? 'Paid plan: unlimited smart answers.'
                    : `${Math.min(hosted.used, hosted.freeLimit)} of ${hosted.freeLimit} free smart answers used.`}
              </p>
            )}
            <button className="btn" onClick={() => onAuth(null)}>
              Sign out
            </button>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit('login');
            }}
          >
            <p className="muted">Larger cloud models that read the whole chat and can give a second opinion. Sign in to try 3 answers free.</p>
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                minLength={8}
                required
              />
            </label>
            {error && <p className="form-error">{error}</p>}
            <div className="row">
              <button className="btn primary" type="submit" disabled={working}>
                Sign in
              </button>
              <button className="btn" type="button" disabled={working || !email || password.length < 8} onClick={() => void submit('signup')}>
                Create account
              </button>
            </div>
          </form>
        )}
      </section>

      <details>
        <summary>Advanced: use your own API keys</summary>
        <p className="muted">With a key, Gutter asks that model directly and you pay the provider. Keys stay on this device.</p>
        {PROVIDERS.map((p) => (
          <div className="key-row" key={p}>
            <label>
              {PROVIDER_LABEL[p]} key
              <input
                type="password"
                placeholder={KEY_HINT[p]}
                value={settings.keys[p]}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => onSettings({ ...settings, keys: { ...settings.keys, [p]: e.target.value } })}
              />
            </label>
            <label>
              Model
              <input
                type="text"
                value={settings.models[p]}
                spellCheck={false}
                onChange={(e) => onSettings({ ...settings, models: { ...settings.models, [p]: e.target.value } })}
              />
            </label>
          </div>
        ))}
      </details>

      <section>
        <h2>What Gutter reads</h2>
        <p className="muted">
          Gutter reads the chat in the open tab only when you ask a question. With the built-in model it stays on this
          computer; with a smart model it is sent to that model. Gutter never sends anything in your main chat.
        </p>
      </section>
    </div>
  );
}
