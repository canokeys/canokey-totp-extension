export const EXPIRY_WAIT_MS = 4000;
export const MAX_OPERATION_AGE_MS = 90_000;

export interface TotpWindow {
  step: bigint;
  challenge: Uint8Array;
  calculatedAt: number;
  expiresAt: number;
  waitMs: number;
}

export function periodMilliseconds(period: number): number {
  if (!Number.isSafeInteger(period) || period < 1 || period > 86_400) throw new Error('Invalid TOTP period');
  return period * 1000;
}

export function totpWindow(now: number, period: number, waitNearExpiry = true): TotpWindow {
  const periodMs = periodMilliseconds(period);
  const step = BigInt(Math.floor(now / 1000)) / BigInt(period);
  const next = (Number(step) + 1) * periodMs;
  const remaining = next - now;
  const threshold = Math.min(EXPIRY_WAIT_MS, periodMs / 4);
  const waitMs = waitNearExpiry && remaining <= threshold ? remaining : 0;
  const effectiveNow = waitMs > 0 ? next : now;
  const effectiveStep = waitMs > 0 ? step + 1n : step;
  const challenge = new Uint8Array(8);
  new DataView(challenge.buffer).setBigUint64(0, effectiveStep, false);
  return {
    step: effectiveStep,
    challenge,
    calculatedAt: effectiveNow,
    expiresAt: (Number(effectiveStep) + 1) * periodMs,
    waitMs,
  };
}

export function isOtpValid(calculatedAt: number, expiresAt: number, now: number): boolean {
  return now >= calculatedAt && now < expiresAt && expiresAt > calculatedAt;
}
