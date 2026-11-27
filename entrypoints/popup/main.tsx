import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { requestCanoKey } from '../../lib/canokey/webusb';
import { activeTab, copyText, send } from '../../lib/messaging';
import { DEFAULT_MAPPINGS, HTTPS_HOST_PATTERN, matchingCredentials, tabOrigin } from '../../lib/origin';
import { t } from '../../lib/i18n';
import type { CopyResult, Credential, DeviceStatus, IssuerMapping, OperationView } from '../../lib/types';
import '../style.css';

const webpageAccess: chrome.permissions.Permissions = { origins: [HTTPS_HOST_PATTERN] };

function App() {
  const [status, setStatus] = useState<DeviceStatus>();
  const [loading, setLoading] = useState(true);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [tab, setTab] = useState<chrome.tabs.Tab>();
  const [mappings, setMappings] = useState<IssuerMapping[]>([...DEFAULT_MAPPINGS]);
  const [query, setQuery] = useState('');
  const [password, setPassword] = useState('');
  const [locked, setLocked] = useState<string[]>([]);
  const [webpageAccessGranted, setWebpageAccessGranted] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const passwords = useRef(new Map<string, string>());
  const origin = tabOrigin(tab?.url);
  const devices = status?.devices ?? [];
  const unavailableCount = (status?.authorizedCount ?? 0) - devices.length;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    passwords.current.clear();
    try {
      const [current, deviceStatus, custom, accessGranted] = await Promise.all([
        activeTab(), send<DeviceStatus>({ type: 'device:list' }), send<IssuerMapping[]>({ type: 'mapping:list' }),
        chrome.permissions.contains(webpageAccess),
      ]);
      setTab(current);
      setStatus(deviceStatus);
      setMappings([...DEFAULT_MAPPINGS, ...custom]);
      setWebpageAccessGranted(accessGranted);
      const all: Credential[] = [];
      const lockedDevices: string[] = [];
      for (const device of deviceStatus.devices) {
        try {
          all.push(...await send<Credential[]>({ type: 'credential:list', deviceId: device.id }));
        } catch (cause) {
          if ((cause as Error & { code?: string }).code === 'OATH_PASSWORD_REQUIRED') lockedDevices.push(device.id);
          else setError((cause as Error).message);
        }
      }
      setCredentials(all);
      setLocked(lockedDevices);
    } catch (cause) {
      setStatus(undefined);
      setCredentials([]);
      setLocked([]);
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const search = query.trim().toLowerCase();
  const filtered = credentials.filter((credential) => `${credential.issuer ?? ''} ${credential.account}`.toLowerCase().includes(search));
  const matching = origin ? matchingCredentials(filtered, origin, mappings) : [];
  const others = filtered.filter((credential) => !matching.includes(credential));

  async function enableButton() {
    setError('');
    setBusy(true);
    try {
      const granted = await chrome.permissions.request(webpageAccess);
      setWebpageAccessGranted(granted);
      if (!granted) setError(t('sitePermissionDenied'));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function authorizeDevice() {
    try {
      await requestCanoKey();
      await load();
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  async function openImporter() {
    const params = new URLSearchParams();
    if (tab?.id !== undefined) params.set('tab', String(tab.id));
    if (origin) params.set('origin', origin);
    await chrome.windows.create({ url: chrome.runtime.getURL(`import.html?${params}`), type: 'popup', width: 520, height: 720 });
  }

  async function unlock(deviceId: string) {
    setBusy(true);
    setError('');
    try {
      const unlocked = await send<Credential[]>({ type: 'credential:list', deviceId, password });
      passwords.current.set(deviceId, password);
      setCredentials((items) => [...items.filter((item) => item.deviceId !== deviceId), ...unlocked]);
      setLocked((items) => items.filter((id) => id !== deviceId));
      setPassword('');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function start(credential: Credential, mode: 'fill' | 'copy') {
    if (tab?.id === undefined || !origin) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const devicePassword = passwords.current.get(credential.deviceId);
      const operation = await send<OperationView>({
        type: 'autofill:start', tabId: tab.id, expectedOrigin: origin, mode,
        selection: { deviceId: credential.deviceId, credentialName: credential.nameHex },
        ...(devicePassword ? { password: devicePassword } : {}),
      });
      if (mode === 'copy' && operation.state === 'ready-to-fill') {
        const result = await send<CopyResult | undefined>({ type: 'autofill:copy', operationId: operation.id });
        if (!result || result.expiresAt <= Date.now()) throw new Error(t('expiredCode'));
        await copyText(result.code);
        setMessage(t('copied'));
      } else if (operation.state === 'complete') {
        setMessage(t('success'));
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function account(credential: Credential) {
    return <div className="account" key={`${credential.deviceId}:${credential.nameHex}`}>
      <div>
        <div className="account-name" title={credential.account}>{credential.account}</div>
        <div className="account-meta">{[credential.issuer, credential.deviceId].filter(Boolean).join(' · ')}</div>
      </div>
      <div className="actions">
        <button className="primary" disabled={busy || loading || !origin} onClick={() => start(credential, 'fill')}>{t('fill')}</button>
        <button disabled={busy || loading || !origin} onClick={() => start(credential, 'copy')}>{t('copy')}</button>
      </div>
    </div>;
  }

  return <main className="popup">
    <div className="header">
      <div className="brand"><span className="logo">C</span>{t('appName')}</div>
      <div className="actions">
        <button className="link" disabled={loading || busy} onClick={load} aria-label={t('refresh')}>↻</button>
        <button className="link" onClick={() => chrome.runtime.openOptionsPage()}>{t('settings')}</button>
      </div>
    </div>
    <section className="section">
      <h2 className="section-title">{t('currentSite')}</h2>
      <div className="origin">{origin ?? t(tab ? 'noHttpsSite' : 'loading')}</div>
      {webpageAccessGranted === false && origin && mappings.some((mapping) => mapping.origin === origin) && <>
        <button className="site-action" disabled={busy || loading} aria-describedby="webpage-access-scope" onClick={enableButton}>
          {t('enableWebpageButtons')}
        </button>
        <p id="webpage-access-scope" className="muted">{t('webpageAccessScope')}</p>
      </>}
    </section>
    <div className="section">
      <div className="status" role="status">
        {loading ? t('checkingDevices') : <>
          <span className={devices.length ? 'dot connected' : 'dot'} aria-hidden="true" />
          {devices.length ? `${devices.length} CanoKey ${t('connected')}` : t(unavailableCount ? 'deviceUnavailable' : status ? 'noDevice' : 'deviceCheckFailed')}
        </>}
      </div>
      {!loading && unavailableCount > 0 && <p className="muted">{t('deviceUnavailableHelp')}</p>}
      {!loading && status?.authorizedCount === 0 && <button className="site-action" onClick={authorizeDevice}>{t('connect')}</button>}
      {locked.map((id) => <form className="section stack" key={id} onSubmit={(event) => { event.preventDefault(); void unlock(id); }}>
        <label>{t('password')} · {id}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <button disabled={busy || loading || !password}>{t('unlock')}</button>
      </form>)}
    </div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {message && <div className="notice success" role="status">{message}</div>}
    <section className="section">
      <div className="row">
        <h2 className="section-title grow">{t('allAccounts')}</h2>
        <button className="link" onClick={() => openImporter().catch((cause: Error) => setError(cause.message))}>{t('add')}</button>
      </div>
      <input type="search" aria-label={t('search')} placeholder={t('search')} value={query} onChange={(event) => setQuery(event.target.value)} />
      {matching.length > 0 && <section className="section"><h3 className="section-title">{t('matchingAccounts')}</h3>{matching.map(account)}</section>}
      {matching.length > 0 && others.length > 0 && <h3 className="section-title site-accounts">{t('otherAccounts')}</h3>}
      {others.map(account)}
      {!loading && !filtered.length && <p className="muted">{search ? t('noSearchResults') : t('noCredentials')}</p>}
    </section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
