import { IStorage, LocalStorageStorage } from './storage';
import { Ed25519KeyManager, IKeyManager } from './key-manager';
import { WebSocketConnectionManager, IConnectionManager } from './connection-manager';
import { LocalServerManager, IServerManager } from './server-manager';
import { MessageHandler, IMessageHandler } from './message-handler';
import { PublicKey, HexString } from './types';
import { TypedEventEmitter, EventMap } from './events';

export interface ClientEvents extends EventMap {
  connected: [serverUrl: string];
  disconnected: [];
  message: [from: PublicKey, content: Uint8Array];
  error: [error: Error];
  serversChanged: [servers: string[]];
}

export class Client extends TypedEventEmitter<ClientEvents> {
  private keyManager: IKeyManager;
  private connectionManager: IConnectionManager;
  private serverManager: IServerManager;
  private messageHandler: IMessageHandler;
  private nick: string;

  constructor(storage: IStorage = new LocalStorageStorage()) {
    super();
    this.keyManager = new Ed25519KeyManager(storage);
    this.connectionManager = new WebSocketConnectionManager();
    this.serverManager = new LocalServerManager(storage);
    this.nick = storage.getItem('sdk:nick') || 'Anonymous';

    this.messageHandler = new MessageHandler(
      this.keyManager,
      this.connectionManager,
      this.serverManager,
      this.nick
    );

    this.setupEventForwarding();
  }

    private setupEventForwarding(): void {
    this.messageHandler.on('handshakeSuccess', () => {
        this.emit('connected', this.connectionManager.isConnected() ? 'connected' : 'unknown');
    });

    this.messageHandler.on('message', (from, content) => {
        this.emit('message', from, content);
    });

    this.messageHandler.on('nodeInfoAddServer', (address) => {
        this.serverManager.addServer(address);
    });

    this.connectionManager.on('close', () => {
        this.emit('disconnected');
    });

    this.connectionManager.on('error', (error) => {
        this.emit('error', error); // теперь error — это Error
    });

    this.serverManager.on('listChanged', (servers) => {
        this.emit('serversChanged', servers);
    });
    }

  // Публичное API

  getPublicKeyHex(): HexString {
    return this.keyManager.getPublicKeyHex();
  }

  getPublicKey(): PublicKey {
    return this.keyManager.getPublicKey();
  }

  getNick(): string {
    return this.nick;
  }

  setNick(nick: string): void {
    this.nick = nick;
    // В реальном приложении нужно обновить ник в messageHandler и сохранить в storage
    (this.keyManager as any).storage?.setItem('sdk:nick', nick); // упрощённо
  }

  getServers(): string[] {
    return this.serverManager.getServers();
  }

  getSelectedServer(): string | null {
    return this.serverManager.getSelectedServer();
  }

  addServer(address: string): void {
    this.serverManager.addServer(address);
    if (this.connectionManager.isConnected()) {
      this.messageHandler.sendNodeInfoAddServer(address);
    }
  }

  removeServer(address: string): void {
    this.serverManager.removeServer(address);
  }

  selectServer(address: string | null): void {
    this.serverManager.setSelectedServer(address);
  }

  async connect(address?: string): Promise<void> {
    const server = address || this.serverManager.getSelectedServer();
    if (!server) throw new Error('No server selected');
    await this.connectionManager.connect(server);
  }

  disconnect(): void {
    this.connectionManager.disconnect();
  }

  isConnected(): boolean {
    return this.connectionManager.isConnected();
  }

  sendTo(target: PublicKey | HexString, message: string): void {
    let targetBytes: PublicKey;
    if (typeof target === 'string') {
      if (!/^[0-9a-fA-F]{64}$/.test(target)) throw new Error('Invalid hex key');
      const bytes = target.match(/.{2}/g)!.map(b => parseInt(b, 16));
      targetBytes = new Uint8Array(bytes);
    } else {
      targetBytes = target;
    }

    const nickBytes = new TextEncoder().encode(this.nick);
    const messageBytes = new TextEncoder().encode(message);
    const fullMessage = new Uint8Array(nickBytes.length + 1 + messageBytes.length);
    fullMessage.set(nickBytes, 0);
    fullMessage[nickBytes.length] = 10; // '\n'
    fullMessage.set(messageBytes, nickBytes.length + 1);

    this.messageHandler.sendData(targetBytes, fullMessage);
  }

  // Для обратной совместимости со старым кодом
  onData(callback: (from: PublicKey, message: Uint8Array) => void): void {
    this.on('message', callback);
  }
}