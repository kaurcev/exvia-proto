import { Frame, encodeFrame, decodeFrame } from '../../shared/protocol';
import { TypedEventEmitter, EventMap } from './events';

export interface ConnectionEvents extends EventMap {
  open: [];
  close: [code: number, reason: string];
  error: [error: Error];
  frame: [frame: Frame];
}

export interface IConnectionManager {
  connect(url: string): Promise<void>;
  disconnect(): void;
  send(frame: Frame): void;
  isConnected(): boolean;
  on<K extends keyof ConnectionEvents>(event: K, listener: (...args: ConnectionEvents[K]) => void): void;
  off<K extends keyof ConnectionEvents>(event: K, listener: (...args: ConnectionEvents[K]) => void): void;
}

export class WebSocketConnectionManager
  extends TypedEventEmitter<ConnectionEvents>
  implements IConnectionManager
{
  private ws: WebSocket | null = null;
  private connectionPromise: Promise<void> | null = null;

  connect(url: string): Promise<void> {
    if (this.connectionPromise) return this.connectionPromise;

    this.connectionPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        this.ws = ws;
        this.emit('open');
        resolve();
      };

      ws.onmessage = (event) => {
        try {
          const frame = decodeFrame(event.data as ArrayBuffer);
          this.emit('frame', frame);
        } catch (err) {
          console.error('Failed to decode frame', err);
        }
      };

      ws.onerror = () => {
        const error = new Error('WebSocket connection error');
        this.emit('error', error);
        reject(error);
      };

      ws.onclose = (event) => {
        this.ws = null;
        this.connectionPromise = null;
        this.emit('close', event.code, event.reason);
      };
    });

    return this.connectionPromise;
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connectionPromise = null;
    }
  }

  send(frame: Frame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.ws.send(encodeFrame(frame));
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}