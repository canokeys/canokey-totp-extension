export type Algorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface DeviceInfo {
  id: string;
  serial: string;
  firmware: string;
  model: string;
  productName: string;
}

export interface Credential {
  deviceId: string;
  name: string;
  nameHex: string;
  issuer?: string;
  account: string;
  algorithm: Algorithm;
  digits?: number;
  period: number;
}

export interface IssuerMapping {
  issuer: string;
  origin: string;
}

export interface DeviceStatus {
  devices: DeviceInfo[];
  authorizedCount: number;
}

export interface TotpDraft {
  issuer?: string;
  account: string;
  secret: Uint8Array;
  algorithm: Algorithm;
  digits: number;
  period: number;
}

export interface ImportPreview {
  issuer?: string;
  account: string;
  algorithm: Algorithm;
  digits: number;
  period: number;
  name: string;
}

export interface ImportResult {
  credential: Credential;
  fill?: AutofillOperation;
  fillError?: string;
}

export type FormIssue = 'ambiguous' | 'not-found';

export type OperationState =
  | 'select-account'
  | 'password-required'
  | 'device-required'
  | 'no-accounts'
  | 'copy-required'
  | 'calculating'
  | 'touch-required'
  | 'ready-to-fill'
  | 'complete'
  | 'error'
  | 'cancelled';

export interface AutofillTarget {
  tabId: number;
  documentId: string;
  origin: string;
  windowId: number;
}

export interface AutofillOperation {
  id: string;
  target: AutofillTarget;
  deviceId?: string;
  credentialName?: string;
  state: OperationState;
  message?: string | undefined;
  formIssue?: FormIssue;
  mode: 'fill' | 'copy';
}

export interface OperationView extends AutofillOperation {
  credentials: Credential[];
  lockedDevices: DeviceInfo[];
  passwordDevice?: DeviceInfo | undefined;
  passwordDeviceId?: string;
}

export interface CopyResult {
  code: string;
  expiresAt: number;
}

export interface AutofillSelection {
  deviceId: string;
  credentialName: string;
}

export type ContentMessage =
  | { type: 'content:inspect' }
  | { type: 'content:prepare'; operationId: string }
  | { type: 'content:validate'; operationId: string; requireField?: boolean }
  | { type: 'content:fill'; operationId: string; code: string }
  | { type: 'content:status'; operationId: string; state: 'touch-required' | 'calculating' | 'complete' | 'clear'; release?: boolean };

export type Message =
  | { type: 'device:list' }
  | { type: 'credential:list'; deviceId: string; password?: string }
  | { type: 'mapping:list' }
  | { type: 'mapping:change'; mapping?: IssuerMapping; previous?: IssuerMapping }
  | { type: 'autofill:start'; tabId: number; selection: AutofillSelection; mode: 'fill' | 'copy'; expectedOrigin: string; password?: string }
  | { type: 'autofill:select'; operationId: string; selection: AutofillSelection; mode: 'fill' | 'copy' }
  | { type: 'autofill:password'; operationId: string; deviceId: string; password: string }
  | { type: 'autofill:retry'; operationId: string }
  | { type: 'autofill:cancel'; operationId: string }
  | { type: 'autofill:copy'; operationId: string }
  | { type: 'operation:get'; operationId: string }
  | { type: 'helper:clicked' | 'helper:status'; origin: string }
  | { type: 'import:manual'; draft: Omit<TotpDraft, 'secret'> & { secret: string }; deviceId: string; touch: boolean; password?: string; fillTarget?: Pick<AutofillTarget, 'tabId' | 'documentId' | 'origin'> }
  | { type: 'import:target'; tabId: number; expectedOrigin: string }
  | { type: 'import:screenshot'; tabId: number; expectedOrigin: string };

export interface MessageResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
}

export interface PrepareResult {
  found: boolean;
  reason?: FormIssue;
}
