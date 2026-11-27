export interface ApduTransport {
  exchange(command: Uint8Array): Promise<Uint8Array>;
}

export interface TransportEvents {
  onWaiting?: () => void;
}
