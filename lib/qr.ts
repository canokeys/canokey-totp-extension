import jsQR from 'jsqr';

export async function readQrFromScreenshot(dataUrl: string): Promise<string> {
  if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('Invalid screenshot');
  const encoded = dataUrl.slice('data:image/png;base64,'.length);
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes.buffer], { type: 'image/png' })).finally(() => bytes.fill(0));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Screenshot decoding is unavailable');
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const result = jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
    image.data.fill(0);
    canvas.width = 1;
    canvas.height = 1;
    if (!result?.data.startsWith('otpauth://')) throw new Error('No TOTP QR code was found in the visible tab');
    return result.data;
  } finally {
    bitmap.close();
  }
}
