import type { Credential, IssuerMapping } from './types';

export const HTTPS_HOST_PATTERN = 'https://*/*';

export function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.origin === 'null') {
    throw new Error('Only HTTPS website addresses are supported.');
  }
  return url.origin;
}

export function tabOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return normalizeOrigin(value);
  } catch {
    return null;
  }
}

export function helperMatchPattern(origin: string): string {
  return `https://${new URL(normalizeOrigin(origin)).hostname}/*`;
}

export const DEFAULT_MAPPINGS: readonly IssuerMapping[] = [
  { issuer: '1Password', origin: 'https://my.1password.com' },
  { issuer: '1Password', origin: 'https://my.1password.ca' },
  { issuer: '1Password', origin: 'https://my.1password.eu' },
  { issuer: 'Amazon', origin: 'https://www.amazon.com' },
  { issuer: 'Amazon', origin: 'https://www.amazon.ca' },
  { issuer: 'Amazon', origin: 'https://www.amazon.co.jp' },
  { issuer: 'Amazon', origin: 'https://www.amazon.co.uk' },
  { issuer: 'Amazon', origin: 'https://www.amazon.com.au' },
  { issuer: 'Amazon', origin: 'https://www.amazon.de' },
  { issuer: 'Amazon', origin: 'https://www.amazon.fr' },
  { issuer: 'Amazon', origin: 'https://www.amazon.in' },
  { issuer: 'Amazon', origin: 'https://www.amazon.sg' },
  { issuer: 'Amazon Web Services', origin: 'https://signin.aws.amazon.com' },
  { issuer: 'Atlassian', origin: 'https://id.atlassian.com' },
  { issuer: 'Bitwarden', origin: 'https://vault.bitwarden.com' },
  { issuer: 'Bitwarden', origin: 'https://vault.bitwarden.eu' },
  { issuer: 'Cloudflare', origin: 'https://dash.cloudflare.com' },
  { issuer: 'Coinbase', origin: 'https://login.coinbase.com' },
  { issuer: 'DigitalOcean', origin: 'https://cloud.digitalocean.com' },
  { issuer: 'Discord', origin: 'https://discord.com' },
  { issuer: 'Docker', origin: 'https://login.docker.com' },
  { issuer: 'Dropbox', origin: 'https://www.dropbox.com' },
  { issuer: 'Epic Games', origin: 'https://www.epicgames.com' },
  { issuer: 'Facebook', origin: 'https://www.facebook.com' },
  { issuer: 'Fastmail', origin: 'https://app.fastmail.com' },
  { issuer: 'Firefox', origin: 'https://accounts.firefox.com' },
  { issuer: 'GitHub', origin: 'https://github.com' },
  { issuer: 'GitLab', origin: 'https://gitlab.com' },
  { issuer: 'gitlab.com', origin: 'https://gitlab.com' },
  { issuer: 'Google', origin: 'https://accounts.google.com' },
  { issuer: 'Hugging Face', origin: 'https://huggingface.co' },
  { issuer: 'Instagram', origin: 'https://www.instagram.com' },
  { issuer: 'Kraken', origin: 'https://id.kraken.com' },
  { issuer: 'LinkedIn', origin: 'https://www.linkedin.com' },
  { issuer: 'Microsoft', origin: 'https://login.live.com' },
  { issuer: 'Microsoft', origin: 'https://login.microsoftonline.com' },
  { issuer: 'Microsoft account', origin: 'https://login.live.com' },
  { issuer: 'Mozilla', origin: 'https://accounts.firefox.com' },
  { issuer: 'Nintendo Account', origin: 'https://accounts.nintendo.com' },
  { issuer: 'Notion', origin: 'https://app.notion.com' },
  { issuer: 'OpenAI', origin: 'https://auth.openai.com' },
  { issuer: 'PayPal', origin: 'https://www.paypal.com' },
  { issuer: 'Proton', origin: 'https://account.proton.me' },
  { issuer: 'ProtonMail', origin: 'https://account.proton.me' },
  { issuer: 'Reddit', origin: 'https://www.reddit.com' },
  { issuer: 'Roblox', origin: 'https://www.roblox.com' },
  { issuer: 'Shopify', origin: 'https://accounts.shopify.com' },
  { issuer: 'Stripe', origin: 'https://dashboard.stripe.com' },
  { issuer: 'Twitch', origin: 'https://www.twitch.tv' },
  { issuer: 'Twitter', origin: 'https://x.com' },
  { issuer: 'Vercel', origin: 'https://vercel.com' },
  { issuer: 'WordPress.com', origin: 'https://wordpress.com' },
  { issuer: 'X', origin: 'https://x.com' },
  { issuer: 'Yahoo', origin: 'https://login.yahoo.com' },
  { issuer: 'Zoom', origin: 'https://zoom.us' },
];

function issuerKey(issuer: string): string {
  return issuer.trim().toLowerCase();
}

export function sameMapping(a: IssuerMapping, b: IssuerMapping): boolean {
  return a.origin === b.origin && issuerKey(a.issuer) === issuerKey(b.issuer);
}

export function matchingCredentials(
  credentials: readonly Credential[],
  origin: string,
  mappings: readonly IssuerMapping[],
): Credential[] {
  const issuers = new Set(mappings.filter((mapping) => mapping.origin === origin).map((mapping) => issuerKey(mapping.issuer)));
  return credentials.filter((credential) => credential.issuer && issuers.has(issuerKey(credential.issuer)));
}
