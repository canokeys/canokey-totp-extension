import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { t } from '../../lib/i18n';
import { copyText, send } from '../../lib/messaging';
import { requestCanoKey } from '../../lib/canokey/webusb';
import type { CopyResult, Credential, OperationView } from '../../lib/types';
import '../style.css';

const operationId = new URLSearchParams(location.search).get('op') ?? '';

function PasswordForm({ device, busy, onUnlock }: { device: string; busy: boolean; onUnlock: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState('');
  return <form className="stack" onSubmit={(event) => {
    event.preventDefault();
    const value = password;
    setPassword('');
    void onUnlock(value);
  }}>
    <label>{t('password')} · {device}<input type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
    <button className="primary" disabled={busy || !password}>{t('unlock')}</button>
  </form>;
}

function App() {
  const [view, setView] = useState<OperationView>();
  const [error, setError] = useState('');
  const [manualCopy, setManualCopy] = useState<CopyResult>();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const next = await send<OperationView>({ type: 'operation:get', operationId });
    setView(next);
    return next;
  }, []);

  useEffect(() => {
    void load().catch((cause: Error) => setError(cause.message));
  }, [load]);

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => { void load().catch(() => undefined); }, 250);
    return () => clearInterval(timer);
  }, [busy, load]);

  useEffect(() => {
    if (!manualCopy) return;
    const timer = setTimeout(() => {
      setManualCopy(undefined);
      setError(t('expiredCode'));
    }, Math.max(0, manualCopy.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [manualCopy]);

  async function putOnClipboard(result: CopyResult) {
    if (result.expiresAt <= Date.now()) throw new Error(t('expiredCode'));
    try {
      await copyText(result.code);
      setCopied(true);
    } catch {
      setManualCopy(result);
    }
  }

  async function action(run: () => Promise<void>, continueCopy = true) {
    setBusy(true);
    setError('');
    try {
      await run();
      const next = await load();
      if (continueCopy && next.mode === 'copy' && next.state === 'ready-to-fill') {
        const result = await send<CopyResult | undefined>({ type: 'autofill:copy', operationId });
        if (result) await putOnClipboard(result);
        await load();
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function select(credential: Credential, mode: 'fill' | 'copy') {
    return action(() => send({
      type: 'autofill:select', operationId, mode,
      selection: { deviceId: credential.deviceId, credentialName: credential.nameHex },
    }));
  }

  function unlock(deviceId: string, password: string) {
    return action(() => send({ type: 'autofill:password', operationId, deviceId, password }));
  }

  function copy() {
    return action(async () => {
      const result = await send<CopyResult | undefined>({ type: 'autofill:copy', operationId });
      if (result) await putOnClipboard(result);
    }, false);
  }

  async function cancel() {
    await send({ type: 'autofill:cancel', operationId }).catch(() => undefined);
    window.close();
  }

  if (!view) return <main className="app"><p>{error || t('loading')}</p></main>;
  return <main className="app">
    <div className="header">
      <div className="brand"><span className="logo">C</span>{t('appName')}</div>
      <button className="link" onClick={cancel}>{t('close')}</button>
    </div>
    <div className="stack">
      <div><h2 className="section-title">{t('currentSite')}</h2><div className="origin">{view.target.origin}</div></div>
      {error && <div className="notice error" role="alert">{error}</div>}
      {view.message && <div className={`notice ${view.state === 'error' ? 'error' : ''}`}>{view.message}</div>}
      {view.formIssue && view.state !== 'complete' && <p className="notice">{t(view.formIssue === 'ambiguous' ? 'formAmbiguous' : 'formNotFound')}</p>}
      {view.state === 'select-account' && <section>
        <h2 className="section-title">{t('selectAccount')}</h2>
        {view.credentials.map((credential) => <div className="account" key={`${credential.deviceId}:${credential.nameHex}`}>
          <div>
            <div className="account-name">{credential.account}</div>
            <div className="account-meta">{[credential.issuer, credential.deviceId].filter(Boolean).join(' · ')}</div>
          </div>
          <div className="actions">
            {!view.formIssue && view.mode === 'fill' &&
              <button className="primary" disabled={busy} onClick={() => select(credential, 'fill')}>{t('fill')}</button>}
            <button disabled={busy} onClick={() => select(credential, 'copy')}>{t('copy')}</button>
          </div>
        </div>)}
        {view.lockedDevices.map((device) => <PasswordForm key={device.id} device={device.id} busy={busy} onUnlock={(password) => unlock(device.id, password)} />)}
      </section>}
      {view.state === 'password-required' && view.passwordDeviceId && <PasswordForm
        device={view.passwordDevice?.productName ?? view.passwordDeviceId} busy={busy}
        onUnlock={(password) => unlock(view.passwordDeviceId!, password)} />}
      {view.state === 'no-accounts' && <p className="notice" role="status">{t('noCredentials')}</p>}
      {(view.state === 'device-required' || view.state === 'no-accounts') && <div className="actions">
        {view.state === 'device-required' && <button className="primary" disabled={busy} onClick={() => action(async () => {
          await requestCanoKey();
          await send({ type: 'autofill:retry', operationId });
        })}>{t('authorizeDevice')}</button>}
        <button disabled={busy} onClick={() => action(() => send({ type: 'autofill:retry', operationId }))}>{t('retry')}</button>
      </div>}
      {['calculating', 'touch-required'].includes(view.state) && <div className="notice" role="status">
        <span className="spinner" /> {t(view.state === 'touch-required' ? 'touch' : 'calculating')}
      </div>}
      {['copy-required', 'ready-to-fill'].includes(view.state) && <div className="actions">
        <button className="primary" disabled={busy} onClick={copy}>{t('copy')}</button>
      </div>}
      {manualCopy && <div><p>{t('copyManually')}</p><div className="code">{manualCopy.code}</div></div>}
      {view.state === 'complete' && !busy && !manualCopy && !error && <div className="notice success" role="status">{t(copied ? 'copied' : 'success')}</div>}
    </div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
