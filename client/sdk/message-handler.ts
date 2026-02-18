import { MsgType, NODE_INFO_ADD_SERVER } from '../../shared/protocol';
import { Frame, PublicKey } from './types';
import { IKeyManager } from './key-manager';
import { IConnectionManager } from './connection-manager';
import { IServerManager } from './server-manager';
import { TypedEventEmitter, EventMap } from './events';

export interface MessageHandlerEvents extends EventMap {
  handshakeSuccess: [];
  message: [from: PublicKey, content: Uint8Array];
  nodeInfoAddServer: [address: string];
}

export interface IMessageHandler {
  handleFrame(frame: Frame): Promise<void>;
  sendData(target: PublicKey, payload: Uint8Array): void;
  sendNodeInfoAddServer(address: string): void;
  on<K extends keyof MessageHandlerEvents>(event: K, listener: (...args: MessageHandlerEvents[K]) => void): void;
  off<K extends keyof MessageHandlerEvents>(event: K, listener: (...args: MessageHandlerEvents[K]) => void): void;
}

export class MessageHandler
  extends TypedEventEmitter<MessageHandlerEvents>
  implements IMessageHandler
{
  private pendingChallenge: Uint8Array | null = null;
  private handshakeCompleted = false;

  constructor(
    private keyManager: IKeyManager,
    private connectionManager: IConnectionManager,
    private serverManager: IServerManager,
    private nick: string
  ) {
    super();
    this.connectionManager.on('frame', this.handleFrame.bind(this));
  }

  async handleFrame(frame: Frame): Promise<void> {
    switch (frame.type) {
      case MsgType.HANDSHAKE:
        await this.handleHandshake(frame);
        break;
      case MsgType.DATA:
        this.handleData(frame);
        break;
      case MsgType.NODE_INFO:
        this.handleNodeInfo(frame);
        break;
      default:
        console.warn('Unknown frame type', frame.type);
    }
  }

  private async handleHandshake(frame: Frame): Promise<void> {
    if (frame.payload.length === 32 && !frame.signature) {
      // Сервер прислал challenge
      this.pendingChallenge = frame.payload;
      const signature = this.keyManager.sign(frame.payload);
      this.connectionManager.send({
        type: MsgType.HANDSHAKE,
        payload: frame.payload,
        senderId: this.keyManager.getPublicKey(),
        signature
      });
    } else if (frame.payload.length === 1 && frame.payload[0] === 1) {
      // Сервер подтвердил handshake
      this.handshakeCompleted = true;
      this.emit('handshakeSuccess');
    } else {
      console.warn('Unexpected handshake frame', frame);
    }
  }

  private handleData(frame: Frame): void {
    // payload = target (32 bytes) + actual message
    if (frame.payload.length < 32) return;
    const content = frame.payload.slice(32);
    this.emit('message', frame.senderId, content);
  }

    private handleNodeInfo(frame: Frame): void {
    const payload = frame.payload;
    if (payload.length === 0) return;
    const subType = payload[0];
    if (subType === NODE_INFO_ADD_SERVER && payload.length >= 2) {
        const addrLen = payload[1];
        if (addrLen !== undefined && payload.length >= 2 + addrLen) {
        const address = new TextDecoder().decode(payload.slice(2, 2 + addrLen));
        this.emit('nodeInfoAddServer', address);
        }
    }
    }

  sendData(target: PublicKey, payload: Uint8Array): void {
    if (!this.handshakeCompleted) throw new Error('Handshake not completed');
    const fullPayload = new Uint8Array(32 + payload.length);
    fullPayload.set(target, 0);
    fullPayload.set(payload, 32);
    this.connectionManager.send({
      type: MsgType.DATA,
      payload: fullPayload,
      senderId: this.keyManager.getPublicKey()
    });
  }

  sendNodeInfoAddServer(address: string): void {
    const encoder = new TextEncoder();
    const addrBytes = encoder.encode(address);
    const payload = new Uint8Array(2 + addrBytes.length);
    payload[0] = NODE_INFO_ADD_SERVER;
    payload[1] = addrBytes.length;
    payload.set(addrBytes, 2);
    this.connectionManager.send({
      type: MsgType.NODE_INFO,
      payload,
      senderId: this.keyManager.getPublicKey()
    });
  }
}