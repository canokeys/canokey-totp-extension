import { beforeEach, describe, expect, it } from 'vitest';
import { discoverOtpTarget, fillOtpTarget, isEligibleInput, scoreInput } from '../lib/otp-form';

function input(attributes: Record<string, string> = {}, parent: HTMLElement = document.body): HTMLInputElement {
  const element = document.createElement('input');
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  element.style.opacity = '1';
  parent.append(element);
  Object.defineProperty(element, 'getClientRects', { value: () => [{}] });
  element.getBoundingClientRect = () => ({ width: 200, height: 30, top: 0, left: 0, right: 200, bottom: 30, x: 0, y: 0, toJSON: () => ({}) });
  return element;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('OTP field discovery', () => {
  it('recognizes one-time-code, numeric, telephone and labelled fields', () => {
    const field = input({ autocomplete: 'one-time-code', type: 'text' });
    expect(discoverOtpTarget().target?.elements).toEqual([field]);
    document.body.innerHTML = '';
    const numeric = input({ name: 'totp', inputmode: 'numeric', maxlength: '6' });
    expect(scoreInput(numeric)).toBeGreaterThan(40);
    document.body.innerHTML = '';
    const tel = input({ type: 'tel', name: 'verification_code' });
    expect(scoreInput(tel)).toBeGreaterThan(40);
  });

  it('prioritizes an eligible focused field', () => {
    input({ autocomplete: 'one-time-code' });
    const focused = input({ name: 'otp', inputmode: 'numeric', maxlength: '6' });
    focused.focus();
    expect(discoverOtpTarget().target?.elements).toEqual([focused]);
  });

  it('recognizes the labelled six-digit code field on the Fastmail setup form', () => {
    input({ value: 'Authenticator app' });
    const field = input({ id: 'v108-input', type: 'text', placeholder: 'XXXXXX', autocomplete: 'off', pattern: '[0-9]*', maxlength: '6' });
    const label = document.createElement('label');
    label.htmlFor = field.id;
    label.textContent = 'Enter the 6-digit code from your app that appears after scanning the QR code:';
    field.before(label);

    expect(discoverOtpTarget().target?.elements).toEqual([field]);
    expect(fillOtpTarget(discoverOtpTarget().target!, '000042')).toBe(true);
    expect(field.value).toBe('000042');
  });

  it.each(['Enter a number', 'Enter the 5-digit code', 'Enter the 6-digit code on your card'])('ignores a six-digit field labelled "%s"', (label) => {
    const field = input({ 'aria-label': label, pattern: '[0-9]*', maxlength: '6' });
    field.focus();
    expect(discoverOtpTarget().reason).toBe('not-found');
  });

  it('rejects hidden, disabled, read-only, password and telephone fields', () => {
    for (const attributes of [{ type: 'password', name: 'otp' }, { type: 'tel', autocomplete: 'tel' }, { name: 'phone', inputmode: 'numeric' }, { name: 'otp', disabled: '' }, { name: 'otp', readonly: '' }]) {
      document.body.innerHTML = '';
      const field = input(attributes);
      if ('disabled' in attributes || 'readonly' in attributes || attributes.type === 'password') expect(isEligibleInput(field)).toBe(false);
      expect(scoreInput(field)).toBeLessThan(0);
    }
    document.body.innerHTML = '';
    const hidden = input({ name: 'otp', style: 'display:none;opacity:1' });
    expect(scoreInput(hidden)).toBeLessThan(0);
  });

  it('does not guess between equally scored candidates', () => {
    input({ name: 'otp-a', inputmode: 'numeric', maxlength: '6' });
    input({ name: 'otp-b', inputmode: 'numeric', maxlength: '6' });
    expect(discoverOtpTarget().reason).toBe('ambiguous');
  });

  it('recognizes and fills six single-character inputs in order', () => {
    const group = document.createElement('div');
    group.setAttribute('aria-label', 'verification code');
    document.body.append(group);
    const fields = Array.from({ length: 6 }, (_, index) => input({ name: `otp-${index}`, maxlength: '1', inputmode: 'numeric' }, group));
    fields[2]?.focus();
    const discovered = discoverOtpTarget();
    expect(discovered.target?.elements).toEqual(fields);
    const events: string[] = [];
    fields.forEach((field) => field.addEventListener('input', () => events.push(field.value)));
    expect(fillOtpTarget(discovered.target!, '123456')).toBe(true);
    expect(fields.map((field) => field.value)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(events).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('uses the native value setter for framework-controlled inputs', () => {
    const field = input({ autocomplete: 'one-time-code' });
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
    Object.defineProperty(field, 'value', { get() { return native.get?.call(this); }, set() { /* Simulate a framework interceptor. */ } });
    let changes = 0;
    field.addEventListener('change', () => { changes += 1; });
    expect(fillOtpTarget({ elements: [field], score: 100 }, '123456')).toBe(true);
    expect(field.value).toBe('123456');
    expect(changes).toBe(1);
    field.value = '654321';
    expect(fillOtpTarget({ elements: [field], score: 100 }, '12ab')).toBe(false);
    expect(field.value).toBe('123456');
  });
});
