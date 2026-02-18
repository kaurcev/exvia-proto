import { generateKeyPairFromSeed, sign } from '@stablelib/ed25519';
import { MsgType, encodeFrame, decodeFrame, NODE_INFO_ADD_SERVER } from '../shared/protocol';

export class Client {
  public ws: WebSocket | null = null;
  private privateKey: Uint8Array;
  public publicKey: Uint8Array;
  private nick: string;
  private onDataCallback: ((from: Uint8Array, message: Uint8Array) => void) | null = null;
  private currentServerUrl: string = '';

  constructor() {
    const savedPrivateKey = localStorage.getItem('privateKey');
    const savedPublicKey = localStorage.getItem('publicKey');
    if (savedPrivateKey && savedPublicKey) {
      this.privateKey = new Uint8Array(JSON.parse(savedPrivateKey));
      this.publicKey = new Uint8Array(JSON.parse(savedPublicKey));
    } else {
      const seed = crypto.getRandomValues(new Uint8Array(32));
      const keyPair = generateKeyPairFromSeed(seed);
      this.privateKey = keyPair.secretKey;
      this.publicKey = keyPair.publicKey;
      localStorage.setItem('privateKey', JSON.stringify(Array.from(this.privateKey)));
      localStorage.setItem('publicKey', JSON.stringify(Array.from(this.publicKey)));
    }

    this.nick = localStorage.getItem('nick') || 'Anonymous';
    console.log('My public key:', this.getPublicKeyHex());
  }

  getPublicKeyHex(): string {
    return Array.from(this.publicKey).map(b => b.toString(16).padStart(2,'0')).join('');
  }

  setNick(nick: string) {
    this.nick = nick;
    localStorage.setItem('nick', nick);
  }

  onData(callback: (from: Uint8Array, message: Uint8Array) => void) {
    this.onDataCallback = callback;
  }

  connect(url: string): Promise<void> {
    this.currentServerUrl = url;
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onmessage = async (e) => {
        try {
          const frame = decodeFrame(e.data);
          if (frame.type === MsgType.HANDSHAKE) {
            if (frame.payload.length === 32) {
              const signature = sign(this.privateKey, frame.payload);
              if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(encodeFrame({
                  type: MsgType.HANDSHAKE,
                  payload: frame.payload,
                  senderId: this.publicKey,
                  signature: signature
                }));
              }
            } else if (frame.payload.length === 1 && frame.payload[0] === 1) {
              // Рукопожатие завершено, теперь синхронизируем известные серверы
              this.syncKnownServers();
              resolve();
            }
          } else if (frame.type === MsgType.DATA) {
            if (this.onDataCallback) {
              this.onDataCallback(frame.senderId, frame.payload);
            }
          }
        } catch (err) {
          reject(err);
        }
      };

      this.ws.onerror = () => reject(new Error('ws error'));
      this.ws.onclose = () => reject(new Error('ws close'));
    });
  }

  private syncKnownServers() {
    const savedServers = JSON.parse(localStorage.getItem('servers') || '[]');
    for (const addr of savedServers) {
      if (addr !== this.currentServerUrl) {
        this.addServerToNetwork(addr);
      }
    }
  }

  sendTo(targetPublicKey: Uint8Array, messageText: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }

    const nickBytes = new TextEncoder().encode(this.nick);
    const messageBytes = new TextEncoder().encode(messageText);
    const fullMessage = new Uint8Array(nickBytes.length + 1 + messageBytes.length);
    fullMessage.set(nickBytes, 0);
    fullMessage[nickBytes.length] = 10;
    fullMessage.set(messageBytes, nickBytes.length + 1);

    const payload = new Uint8Array(32 + fullMessage.length);
    payload.set(targetPublicKey, 0);
    payload.set(fullMessage, 32);

    this.ws.send(encodeFrame({
      type: MsgType.DATA,
      payload: payload,
      senderId: this.publicKey
    }));
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  addServerToNetwork(address: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('Not connected to server, cannot share server address');
      return;
    }

    const encoder = new TextEncoder();
    const addressBytes = encoder.encode(address);
    const payload = new Uint8Array(2 + addressBytes.length);
    payload[0] = NODE_INFO_ADD_SERVER;
    payload[1] = addressBytes.length;
    payload.set(addressBytes, 2);

    this.ws.send(encodeFrame({
      type: MsgType.NODE_INFO,
      payload,
      senderId: this.publicKey
    }));
    console.log(`Sent ADD_SERVER for ${address}`);
  }
}