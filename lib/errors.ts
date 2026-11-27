export class AppError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof DOMException) {
    if (error.name === 'NotFoundError') return 'No CanoKey was selected.';
    if (error.name === 'NetworkError') return 'The device is busy or was disconnected. Close other CanoKey clients and retry.';
    if (error.name === 'SecurityError') return 'WebUSB access was denied.';
  }
  if (error instanceof Error) {
    if (/otpauth|secret|apdu|password|code/i.test(error.message)) return 'The operation failed. Check the input and try again.';
    return error.message;
  }
  return 'The operation failed.';
}

export function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : 'DEVICE_ERROR';
}
