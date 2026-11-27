import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CANOKEY_USB_FILTER } from '../../lib/canokey/webusb';
import { errorMessage } from '../../lib/errors';
import { t, uiLanguage } from '../../lib/i18n';
import { DEVICE_AUTHORIZED_CHANNEL, send } from '../../lib/messaging';
import { DEFAULT_MAPPINGS, HTTPS_HOST_PATTERN } from '../../lib/origin';
import type { DeviceStatus, IssuerMapping } from '../../lib/types';
import './style.css';

const webpageAccess: chrome.permissions.Permissions = { origins: [HTTPS_HOST_PATTERN] };

function App() {
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus>();
  const [mappings, setMappings] = useState<IssuerMapping[]>([]);
  const [editing, setEditing] = useState<IssuerMapping>();
  const [issuer, setIssuer] = useState('');
  const [origin, setOrigin] = useState('');
  const [loading, setLoading] = useState(true);
  const [choosingDevice, setChoosingDevice] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deviceError, setDeviceError] = useState('');
  const [mappingError, setMappingError] = useState('');
  const [websiteAccess, setWebsiteAccess] = useState<boolean>();
  const [requestingWebsiteAccess, setRequestingWebsiteAccess] = useState(false);
  const [websiteAccessError, setWebsiteAccessError] = useState('');

  const loadDevices = useCallback(async () => {
    setLoading(true);
    setDeviceError('');
    try {
      setDeviceStatus(await send<DeviceStatus>({ type: 'device:list' }));
    } catch (error) {
      setDeviceStatus(undefined);
      setDeviceError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(loadDevices);
    void send<IssuerMapping[]>({ type: 'mapping:list' }).then(setMappings).catch(() => setMappingError(t('settingsLoadError')));
  }, [loadDevices]);

  useEffect(() => {
    const readWebsiteAccess = () => {
      void chrome.permissions.contains(webpageAccess).then((granted) => {
        setWebsiteAccess(granted);
        setWebsiteAccessError('');
      }).catch(() => setWebsiteAccessError(t('settingsLoadError')));
    };
    readWebsiteAccess();
    chrome.permissions.onAdded.addListener(readWebsiteAccess);
    chrome.permissions.onRemoved.addListener(readWebsiteAccess);
    return () => {
      chrome.permissions.onAdded.removeListener(readWebsiteAccess);
      chrome.permissions.onRemoved.removeListener(readWebsiteAccess);
    };
  }, []);

  async function authorize() {
    setDeviceError('');
    setChoosingDevice(true);
    try {
      if (!navigator.usb) throw new Error(t('webUsbUnsupported'));
      await navigator.usb.requestDevice({ filters: [CANOKEY_USB_FILTER] });
      const channel = new BroadcastChannel(DEVICE_AUTHORIZED_CHANNEL);
      channel.postMessage(null);
      channel.close();
      await loadDevices();
    } catch (error) {
      setDeviceError(errorMessage(error));
    } finally {
      setChoosingDevice(false);
    }
  }

  async function authorizeWebsites() {
    setWebsiteAccessError('');
    setRequestingWebsiteAccess(true);
    try {
      const granted = await chrome.permissions.request(webpageAccess);
      setWebsiteAccess(granted);
      if (!granted) setWebsiteAccessError(t('sitePermissionDenied'));
    } catch (error) {
      setWebsiteAccessError(errorMessage(error));
    } finally {
      setRequestingWebsiteAccess(false);
    }
  }

  function edit(mapping?: IssuerMapping) {
    setEditing(mapping);
    setIssuer(mapping?.issuer ?? '');
    setOrigin(mapping?.origin ?? '');
  }

  async function change(mapping?: IssuerMapping, previous?: IssuerMapping) {
    setSaving(true);
    setMappingError('');
    try {
      setMappings(await send<IssuerMapping[]>({
        type: 'mapping:change', ...(mapping ? { mapping } : {}), ...(previous ? { previous } : {}),
      }));
      edit();
    } catch (error) {
      setMappingError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return <div className="settings-shell">
    <aside className="settings-sidebar">
      <div className="settings-brand"><span className="settings-mark" aria-hidden="true">C</span>{t('appName')}</div>
      <nav aria-label={t('settingsNavigation')}>
        <a href="#devices">{t('devices')}</a>
        <a href="#webpage-buttons">{t('webpageButtons')}</a>
        <a href="#mappings">{t('issuerMappings')}</a>
      </nav>
    </aside>
    <main className="settings-main">
      <header className="page-heading"><h1>{t('settings')}</h1></header>
      <section id="devices" className="settings-panel" aria-labelledby="heading-devices">
        <header className="panel-heading">
          <h2 id="heading-devices">{t('devices')}</h2>
          <button className="button" disabled={loading || choosingDevice} onClick={loadDevices}>{t('refresh')}</button>
        </header>
        {deviceError && <p className="feedback error" role="alert">{deviceError}</p>}
        {loading && <p>{t('checkingDevices')}</p>}
        {!loading && deviceStatus?.devices.length === 0 && <p>{t(deviceStatus.authorizedCount ? 'deviceUnavailable' : 'settingsNoDevice')}</p>}
        {deviceStatus && deviceStatus.devices.length > 0 && <ul className="device-list">
          {deviceStatus.devices.map((device) => <li className="device-row" key={device.id}>
            <h3>{device.productName}</h3>
            <dl className="device-details"><div><dt>{t('serial')}</dt><dd>{device.serial}</dd></div><div><dt>{t('firmware')}</dt><dd>{device.firmware}</dd></div></dl>
          </li>)}
        </ul>}
        <button className="button" disabled={loading || choosingDevice} onClick={authorize}>{t('authorizeDevice')}</button>
      </section>

      <section id="webpage-buttons" className="settings-panel" aria-labelledby="heading-webpage-buttons">
        <header className="panel-heading">
          <div>
            <h2 id="heading-webpage-buttons">{t('webpageButtons')}</h2>
            {websiteAccess === true && <p role="status">{t('webpageButtonsEnabled')}</p>}
            {websiteAccess === false && <p id="webpage-access-scope">{t('webpageAccessScope')}</p>}
          </div>
        </header>
        {websiteAccess === false && <button className="button" disabled={requestingWebsiteAccess}
          aria-describedby="webpage-access-scope" onClick={authorizeWebsites}>{t('enableWebpageButtons')}</button>}
        {websiteAccessError && <p className="feedback error" role="alert">{websiteAccessError}</p>}
      </section>

      <section id="mappings" className="settings-panel" aria-labelledby="heading-mappings">
        <header className="panel-heading">
          <div><h2 id="heading-mappings">{t('issuerMappings')}</h2><p>{t('mappingHelp')}</p></div>
        </header>
        <form className="inline-form mapping-form" onSubmit={(event) => {
          event.preventDefault();
          void change({ issuer, origin }, editing);
        }}>
          <label>{t('issuer')}<input value={issuer} onChange={(event) => setIssuer(event.target.value)} maxLength={64} required /></label>
          <label>{t('settingsWebsiteAddress')}<input value={origin} onChange={(event) => setOrigin(event.target.value)} type="url" placeholder="https://example.com" required /></label>
          <button className="button primary" disabled={saving}>{t(editing ? 'settingsSave' : 'addMapping')}</button>
          {editing && <button type="button" className="button" onClick={() => edit()}>{t('cancel')}</button>}
        </form>
        {mappingError && <p className="feedback error" role="alert">{mappingError}</p>}
        {mappings.length > 0 && <ul className="site-list">
          {mappings.map((mapping) => <li key={`${mapping.issuer}:${mapping.origin}`}>
            <div><strong>{mapping.issuer}</strong><p><code>{mapping.origin}</code></p></div>
            <div>
              <button className="text-button" disabled={saving} onClick={() => edit(mapping)}>{t('editMapping')}</button>
              <button className="text-button danger" disabled={saving} onClick={() => change(undefined, mapping)}>{t('remove')}</button>
            </div>
          </li>)}
        </ul>}
        <details>
          <summary>{t('defaultMappings')}</summary>
          <ul className="site-list">
            {DEFAULT_MAPPINGS.map((mapping) => <li key={`${mapping.issuer}:${mapping.origin}`}><strong>{mapping.issuer}</strong><code>{mapping.origin}</code></li>)}
          </ul>
        </details>
      </section>
    </main>
  </div>;
}

document.documentElement.lang = uiLanguage;
document.title = `${t('settings')} · ${t('appName')}`;
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
