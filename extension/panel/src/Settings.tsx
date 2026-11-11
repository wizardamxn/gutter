import { useState } from 'react';
import { PROVIDER_LABEL } from '../../../shared/providers';
import { PROVIDERS, type HostedInfo } from '../../../shared/types';
import { api } from './lib/api';
import type { Auth, Settings as SettingsData } from './lib/storage';

interface Props {
  settings: SettingsData;
  auth: Auth | null;
  hosted: HostedInfo | null;
  onSettings: (next: SettingsData) => void;
  onAuth: (auth: Auth | null) => void;
  onBack: () => void;
}

const KEY_HINT = {
  openai: 'sk-…',
  anthropic: 'sk-ant-…',
  gemini: 'AIza…'
} as const;

export function Settings({ settings, auth, hosted, onSettings, onAuth, onBack }: Props) {
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
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="settings">
      <button className="link back" onClick={onBack}>
        ← Back
      </button>

      <section className="card">
        <h2>Account</h2>
        {auth ? (
          <>
            <p>
              Signed in as <b>{auth.email}</b>
            </p>
            {hosted && (
              <p className="muted">
                {hosted.providers.length
                  ? `Gutter-hosted answers: ${hosted.usedToday} of ${hosted.dailyLimit} used today.`
                  : 'No Gutter-hosted models are switched on right now. Use your own key below.'}
              </p>
            )}
            <p className="muted">Your side notes sync to your account.</p>
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
            <p className="muted">
              Sign in for free daily answers without an API key, and to sync your side notes across devices.
            </p>
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
            {error && <p className="error">{error}</p>}
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

      <section className="card">
        <h2>Your own keys</h2>
        <p className="muted">
          Optional. Add a key to ask that model directly, with no daily limit. Keys stay on this device and go only to
          that provider.
        </p>
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
      </section>

      <section className="card">
        <h2>What Gutter sees</h2>
        <p className="muted">
          Gutter reads the chat in the open tab only when you ask a side question, and sends it to the model you picked
          (through the Gutter server for hosted models, straight to the provider for your own keys). It never posts in
          your main chat by itself.
        </p>
      </section>
    </div>
  );
}
