import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { wipe } from '../../lib/bytes';
import { t } from '../../lib/i18n';
import { DEVICE_AUTHORIZED_CHANNEL, openDeviceSettings, send } from '../../lib/messaging';
import { encodeBase32, parseOtpAuth } from '../../lib/otpauth';
import { tabOrigin } from '../../lib/origin';
import type { AutofillTarget, DeviceStatus, ImportResult, TotpDraft } from '../../lib/types';
import '../style.css';

const params = new URLSearchParams(location.search);
const targetTab = Number(params.get('tab'));
const targetOrigin = tabOrigin(params.get('origin') ?? undefined);
const emptyDraft = { issuer: '', account: '', secret: '', algorithm: 'SHA1' as TotpDraft['algorithm'], digits: 6, period: 30 };

function App() {
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus>();
  const [deviceId, setDeviceId] = useState('');
  const [source, setSource] = useState<'qr' | 'uri' | 'manual'>(targetOrigin ? 'qr' : 'manual');
  const [uri, setUri] = useState('');
  const [draft, setDraft] = useState(emptyDraft);
  const [touch, setTouch] = useState(true);
  const [password, setPassword] = useState('');
  const [pendingAction, setPendingAction] = useState<'import' | 'fill'>();
  const [fillTarget, setFillTarget] = useState<AutofillTarget>();
  const [imported, setImported] = useState<ImportResult>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const devices = deviceStatus?.devices ?? [];

  useEffect(() => {
    function refreshDevices() {
      void send<DeviceStatus>({ type: 'device:list' }).then((status) => {
        setDeviceStatus(status);
        setDeviceId((current) => status.devices.some((device) => device.id === current) ? current : status.devices[0]?.id ?? '');
      }).catch((cause: Error) => setError(cause.message));
    }
    const channel = new BroadcastChannel(DEVICE_AUTHORIZED_CHANNEL);
    channel.addEventListener('message', refreshDevices);
    refreshDevices();
    if (targetTab && targetOrigin) {
      void send<AutofillTarget | undefined>({ type: 'import:target', tabId: targetTab, expectedOrigin: targetOrigin })
        .then(setFillTarget).catch(() => undefined);
    }
    return () => channel.close();
  }, []);

  function readUri(value: string) {
    const parsed = parseOtpAuth(value);
    try {
      setDraft({ ...parsed, issuer: parsed.issuer ?? '', secret: encodeBase32(parsed.secret) });
      setUri('');
      setSource('manual');
      setError('');
    } finally {
      wipe(parsed.secret);
    }
  }

  async function scan() {
    if (!targetOrigin) return;
    setBusy(true);
    setError('');
    try {
      readUri(await send<string>({ type: 'import:screenshot', tabId: targetTab, expectedOrigin: targetOrigin }));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function importCredential(action: 'import' | 'fill', accessPassword = '') {
    if (!deviceId || (action === 'fill' && !fillTarget)) return;
    setBusy(true);
    setError('');
    try {
      const result = await send<ImportResult>({
        type: 'import:manual', deviceId, touch,
        draft: { ...draft, issuer: draft.issuer.trim() },
        ...(action === 'fill' && fillTarget ? { fillTarget } : {}),
        ...(accessPassword ? { password: accessPassword } : {}),
      });
      setImported(result);
      setDraft(emptyDraft);
      setPendingAction(undefined);
      if (result.fill?.state === 'complete') window.close();
    } catch (cause) {
      const code = (cause as Error & { code?: string }).code;
      if (code === 'OATH_PASSWORD_REQUIRED' || code === 'OATH_AUTH') setPendingAction(action);
      else setPendingAction(undefined);
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <main className="app">
    <div className="header">
      <div className="brand"><span className="logo">C</span><h1>{t('importTitle')}</h1></div>
      <button className="link" onClick={() => window.close()}>{t('close')}</button>
    </div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {imported ? <div className="stack">
      <div className="notice success" role="status">{t('imported')} {imported.credential.account}</div>
      {imported.fillError && <div className="notice error" role="alert">{imported.fillError}</div>}
    </div> : <>
      <div className="actions">
        <button className={source === 'qr' ? 'primary' : ''} disabled={busy || !targetOrigin} onClick={() => setSource('qr')}>QR</button>
        <button className={source === 'uri' ? 'primary' : ''} disabled={busy} onClick={() => setSource('uri')}>{t('pasteUri')}</button>
        <button className={source === 'manual' ? 'primary' : ''} disabled={busy} onClick={() => setSource('manual')}>{t('manual')}</button>
      </div>
      {source === 'qr' && <section className="section stack">
        <button className="primary" disabled={busy || !targetTab || !targetOrigin} onClick={scan}>{t('scanQr')}</button>
      </section>}
      {source === 'uri' && <section className="section stack">
        <label>{t('pasteUri')}<textarea autoComplete="off" value={uri} placeholder="otpauth://totp/…" onChange={(event) => {
          const value = event.target.value;
          setUri(value);
          if (value.trim()) {
            try { readUri(value); } catch { setError(t('invalidImportUri')); }
          } else setError('');
        }} /></label>
      </section>}
      {source === 'manual' && <form className="section stack" onSubmit={(event) => {
        event.preventDefault();
        const button = event.nativeEvent.submitter as HTMLButtonElement | null;
        const action = pendingAction ?? (button?.value === 'fill' ? 'fill' : 'import');
        void importCredential(action, password);
        setPassword('');
      }}>
        <div className="grid2">
          <label>{t('issuer')}<input value={draft.issuer} onChange={(event) => setDraft({ ...draft, issuer: event.target.value })} /></label>
          <label>{t('account')}<input value={draft.account} required onChange={(event) => setDraft({ ...draft, account: event.target.value })} /></label>
        </div>
        <label>{t('secret')}<input required autoComplete="off" type="password" value={draft.secret} onChange={(event) => setDraft({ ...draft, secret: event.target.value })} /></label>
        <div className="grid2">
          <label>{t('algorithm')}<select value={draft.algorithm} onChange={(event) => setDraft({ ...draft, algorithm: event.target.value as TotpDraft['algorithm'] })}>
            <option>SHA1</option><option>SHA256</option><option>SHA512</option>
          </select></label>
          <label>{t('digits')}<select value={draft.digits} onChange={(event) => setDraft({ ...draft, digits: Number(event.target.value) })}>
            {[4, 5, 6, 7, 8].map((value) => <option key={value}>{value}</option>)}
          </select></label>
          <label>{t('period')}<input type="number" required min={1} max={86400} value={draft.period} onChange={(event) => setDraft({ ...draft, period: Number(event.target.value) })} /></label>
          <label>{t('targetDevice')}<select value={deviceId} onChange={(event) => setDeviceId(event.target.value)}>
            <option value="">—</option>{devices.map((device) => <option value={device.id} key={device.id}>{device.productName} · {device.serial}</option>)}
          </select></label>
        </div>
        {deviceStatus?.devices.length === 0 && <button type="button" disabled={busy} onClick={() => {
          void openDeviceSettings().catch((cause: Error) => setError(cause.message));
        }}>{t('deviceSettings')}</button>}
        <label className="check"><input type="checkbox" checked={touch} onChange={(event) => setTouch(event.target.checked)} />{t('touchProtection')}</label>
        {pendingAction ? <>
          <label>{t('password')}<input autoFocus type="password" required autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <button className="primary" disabled={busy || !password}>{t('unlock')}</button>
        </> : <div className="actions">
          <button className={fillTarget ? '' : 'primary'} disabled={busy || !deviceId} value="import">{t('import')}</button>
          {fillTarget && <button className="primary" disabled={busy || !deviceId} value="fill">{t('importAndFill')}</button>}
        </div>}
        {fillTarget && <p className="origin">{fillTarget.origin}</p>}
        {busy && <div className="notice" role="status">{t('working')}</div>}
      </form>}
    </>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
