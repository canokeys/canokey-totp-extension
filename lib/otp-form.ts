export interface OtpTarget {
  elements: HTMLInputElement[];
  score: number;
}

export interface OtpDiscovery {
  target?: OtpTarget;
  reason?: 'ambiguous' | 'not-found';
}

const OTP_TEXT = /(?:one[ -]?time|otp|totp|2fa|mfa|verification[ _-]?(?:code|number)|auth(?:entication)?[ _-]?code|security[ _-]?code|token)/i;
const NEGATIVE_TEXT = /(?:password|passwd|phone|mobile|credit|card|cvv|ssn|postal|zip)/i;
const DIGIT_CODE_TEXT = /\b([4-8])[\s\p{Pd}]+digit\s+code\b/iu;
const MIN_OTP_SCORE = 40;

function contextText(input: HTMLInputElement): string {
  const labels = input.labels ? Array.from(input.labels, (label) => label.textContent ?? '').join(' ') : '';
  const describedBy = input.getAttribute('aria-describedby');
  const description = describedBy ? describedBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ') : '';
  return [input.name, input.id, input.placeholder, input.getAttribute('aria-label'), labels, description].filter(Boolean).join(' ');
}

export function isEligibleInput(input: HTMLInputElement): boolean {
  if (!(input instanceof HTMLInputElement) || input.disabled || input.readOnly || !input.isConnected) return false;
  if (['hidden', 'password', 'checkbox', 'radio', 'submit', 'button', 'file', 'range', 'color', 'date'].includes(input.type)) return false;
  const style = getComputedStyle(input);
  if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
  const rect = input.getBoundingClientRect();
  return rect.width >= 8 && rect.height >= 8 && input.getClientRects().length > 0;
}

export function scoreInput(input: HTMLInputElement): number {
  if (!isEligibleInput(input)) return -1000;
  const text = contextText(input);
  if (NEGATIVE_TEXT.test(text) && !OTP_TEXT.test(text)) return -1000;
  if (/^(?:tel|telephone|phone)$/i.test(input.autocomplete) && !OTP_TEXT.test(text)) return -1000;
  const numericPattern = /\\d|\[0-9\]/.test(input.pattern);
  let score = 0;
  if (input.autocomplete === 'one-time-code') score += 100;
  if (OTP_TEXT.test(text)) score += 45;
  if (input.inputMode === 'numeric') score += 18;
  if (input.type === 'number') score += 12;
  if (input.type === 'tel') score += 5;
  if (numericPattern) score += 8;
  if (input.maxLength >= 4 && input.maxLength <= 8) score += 15;
  if (input.maxLength === 1) score -= 20;
  const statedLength = DIGIT_CODE_TEXT.exec(text)?.[1];
  if (Number(statedLength) === input.maxLength && (numericPattern || input.inputMode === 'numeric')) {
    score = Math.max(score, MIN_OTP_SCORE);
  }
  return score;
}

function groupScore(group: HTMLInputElement[]): number {
  if (group.length < 4 || group.length > 8) return -1000;
  if (!group.every((input) => isEligibleInput(input) && input.maxLength === 1)) return -1000;
  const text = group.map(contextText).join(' ');
  if (NEGATIVE_TEXT.test(text) && !OTP_TEXT.test(text)) return -1000;
  let score = 45;
  if (OTP_TEXT.test(text)) score += 45;
  if (group.every((input) => input.inputMode === 'numeric' || input.type === 'number' || input.type === 'tel')) score += 20;
  const parentText = group[0]?.parentElement?.textContent ?? '';
  if (OTP_TEXT.test(parentText)) score += 20;
  return score;
}

function groups(inputs: HTMLInputElement[]): HTMLInputElement[][] {
  const result: HTMLInputElement[][] = [];
  const visited = new Set<HTMLInputElement>();
  for (const input of inputs) {
    if (visited.has(input) || input.maxLength !== 1 || !isEligibleInput(input)) continue;
    const parent = input.parentElement;
    if (!parent) continue;
    const siblings = Array.from(parent.querySelectorAll<HTMLInputElement>('input[maxlength="1"]')).filter(isEligibleInput);
    if (siblings.length < 4 || siblings.length > 8) continue;
    const group = siblings.slice(siblings.indexOf(input));
    const selected = group.length <= 8 ? group : group.slice(0, 8);
    selected.forEach((item) => visited.add(item));
    result.push(selected);
  }
  return result;
}

export function discoverOtpTarget(root: Document = document): OtpDiscovery {
  const inputs = Array.from(root.querySelectorAll('input'));
  const focused = root.activeElement;
  if (focused instanceof HTMLInputElement) {
    const focusedGroup = groups(inputs).find((group) => group.includes(focused) && groupScore(group) >= MIN_OTP_SCORE);
    if (focusedGroup) return { target: { elements: focusedGroup, score: groupScore(focusedGroup) + 1000 } };
    if (scoreInput(focused) >= MIN_OTP_SCORE) return { target: { elements: [focused], score: scoreInput(focused) + 1000 } };
  }
  const candidates: OtpTarget[] = inputs.filter((input) => scoreInput(input) >= MIN_OTP_SCORE).map((input) => ({ elements: [input], score: scoreInput(input) }));
  for (const group of groups(inputs)) {
    const score = groupScore(group);
    if (score >= MIN_OTP_SCORE) candidates.push({ elements: group, score });
  }
  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (!best) return { reason: 'not-found' };
  if (candidates[1] && candidates[1].score === best.score) return { reason: 'ambiguous' };
  return { target: best };
}

function setNativeValue(input: HTMLInputElement, value: string): void {
  // The native setter is intentionally detached so React's overridden value property is bypassed.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) Reflect.apply(setter, input, [value]);
  else input.value = value;
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

export function fillOtpTarget(target: OtpTarget, code: string): boolean {
  if (!/^\d{4,8}$/.test(code) || !target.elements.every(isEligibleInput)) return false;
  if (target.elements.length === 1) {
    const input = target.elements[0];
    if (!input) return false;
    input.focus({ preventScroll: true });
    setNativeValue(input, code);
    return input.value === code;
  }
  if (target.elements.length !== code.length) return false;
  target.elements.forEach((input, index) => {
    input.focus({ preventScroll: true });
    setNativeValue(input, code[index] ?? '');
  });
  return target.elements.every((input, index) => input.value === code[index]);
}
