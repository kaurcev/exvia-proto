import { IStorage, LocalStorageStorage } from './storage';
import { Ed25519KeyManager, IKeyManager } from './key-manager';
import { WebSocketConnectionManager, IConnectionManager } from './connection-manager';
import { LocalServerManager, IServerManager } from './server-manager';
import { MessageHandler, IMessageHandler } from './message-handler';
import { PublicKey, HexString, ContentType } from './types';
import { TypedEventEmitter, EventMap } from './events';

export interface ClientEvents extends EventMap {
  connected: [serverUrl: string];
  disconnected: [];
  message: [from: PublicKey, content: Uint8Array, contentType?: ContentType, parsed?: any];
  error: [error: Error];
  serversChanged: [servers: string[]];
  serversDiscovered: [addresses: string[]];
}

export class Client extends TypedEventEmitter<ClientEvents> {
  private keyManager: IKeyManager;
  private connectionManager: IConnectionManager;
  private serverManager: IServerManager;
  private messageHandler: IMessageHandler;
  private nick: string;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly POLL_INTERVAL = 30000;
  private initialized = false;

  constructor(private storage: IStorage = new LocalStorageStorage()) {
    super();
    this.keyManager = new Ed25519KeyManager(storage);
    this.connectionManager = new WebSocketConnectionManager();
    this.serverManager = new LocalServerManager(storage);
    this.nick = 'Anonymous'; // будет загружено в init
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
      this.startPolling();
    });

    this.messageHandler.on('message', (from, content, contentType, parsed) => {
      this.emit('message', from, content, contentType, parsed);
    });

    this.messageHandler.on('nodeInfoAddServer', (address) => {
      this.serverManager.addServer(address).catch(console.warn);
    });

    this.messageHandler.on('serversListReceived', (addresses) => {
      addresses.forEach(addr => this.serverManager.addServer(addr).catch(console.warn));
      this.emit('serversDiscovered', addresses);
    });

    this.connectionManager.on('close', () => {
      this.stopPolling();
      this.emit('disconnected');
    });

    this.connectionManager.on('error', (error) => {
      this.emit('error', error);
    });

    this.serverManager.on('listChanged', (servers) => {
      this.emit('serversChanged', servers);
    });
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.requestServerList().catch(err => console.warn('Failed to poll servers:', err));
    }, this.POLL_INTERVAL);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // Инициализация (загрузка данных из storage)
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.keyManager.load();
    // Загружаем ник
    const savedNick = await this.storage.getItem('sdk:nick');
    this.nick = savedNick || 'Anonymous';
    // Обновляем messageHandler с новым ником (если нужно)
    // (в текущей реализации messageHandler не использует nick динамически, но можно)
    this.initialized = true;
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

  async setNick(nick: string): Promise<void> {
    this.nick = nick;
    await this.storage.setItem('sdk:nick', nick);
  }

  async getServers(): Promise<string[]> {
    return this.serverManager.getServers();
  }

  async getSelectedServer(): Promise<string | null> {
    return this.serverManager.getSelectedServer();
  }

  async addServer(address: string): Promise<void> {
    await this.serverManager.addServer(address);
    if (this.connectionManager.isConnected()) {
      this.messageHandler.sendNodeInfoAddServer(address);
    }
  }

  async removeServer(address: string): Promise<void> {
    await this.serverManager.removeServer(address);
  }

  async selectServer(address: string | null): Promise<void> {
    await this.serverManager.setSelectedServer(address);
  }

  async connect(address?: string): Promise<void> {
    const server = address || (await this.serverManager.getSelectedServer());
    if (!server) throw new Error('No server selected');
    console.log('🌐 Connecting to server:', server);
    await this.connectionManager.connect(server);
    
    await new Promise<void>((resolve, reject) => {
      const onSuccess = () => {
        this.messageHandler.off('handshakeSuccess', onSuccess);
        this.connectionManager.off('close', onClose);
        this.connectionManager.off('error', onError);
        resolve();
      };
      const onClose = () => {
        this.messageHandler.off('handshakeSuccess', onSuccess);
        this.connectionManager.off('close', onClose);
        this.connectionManager.off('error', onError);
        reject(new Error('Connection closed during handshake'));
      };
      const onError = (err: Error) => {
        this.messageHandler.off('handshakeSuccess', onSuccess);
        this.connectionManager.off('close', onClose);
        this.connectionManager.off('error', onError);
        reject(err);
      };
      this.messageHandler.once('handshakeSuccess', onSuccess);
      this.connectionManager.once('close', onClose);
      this.connectionManager.once('error', onError);
    });
  }

  disconnect(): void {
    this.stopPolling();
    this.connectionManager.disconnect();
  }

  isConnected(): boolean {
    return this.connectionManager.isConnected() && (this.messageHandler as any).handshakeCompleted;
  }

  // Отправка данных
  sendText(target: PublicKey | HexString, text: string): void {
    const content = new TextEncoder().encode(text);
    this.send(target, content, ContentType.TEXT);
  }

  sendJSON(target: PublicKey | HexString, obj: any): void {
    const json = JSON.stringify(obj);
    const content = new TextEncoder().encode(json);
    this.send(target, content, ContentType.JSON);
  }

  async sendFileAsync(target: PublicKey | HexString, file: File): Promise<void> {
    const arrayBuffer = await file.arrayBuffer();
    const fileData = new Uint8Array(arrayBuffer);
    const nameBytes = new TextEncoder().encode(file.name);
    const content = new Uint8Array(1 + nameBytes.length + fileData.length);
    content[0] = nameBytes.length;
    content.set(nameBytes, 1);
    content.set(fileData, 1 + nameBytes.length);
    this.send(target, content, ContentType.FILE);
  }

  private send(target: PublicKey | HexString, content: Uint8Array, contentType: ContentType = ContentType.RAW): void {
    let targetBytes: PublicKey;
    if (typeof target === 'string') {
      if (!/^[0-9a-fA-F]{64}$/.test(target)) throw new Error('Invalid hex key');
      const bytes = target.match(/.{2}/g)!.map(b => parseInt(b, 16));
      targetBytes = new Uint8Array(bytes);
    } else {
      targetBytes = target;
    }
    this.messageHandler.sendSigned(targetBytes, content, contentType);
  }

  async requestServerList(): Promise<void> {
    if (!this.isConnected()) throw new Error('Not connected');
    this.messageHandler.sendRequestServers();
  }

  // Экспорт/импорт ключей
  exportKeys(): { publicKey: string; privateKey: string } {
    return this.keyManager.exportKeys();
  }

  async importKeys(publicKeyBase64: string, privateKeyBase64: string): Promise<void> {
    await this.keyManager.importKeys(publicKeyBase64, privateKeyBase64);
  }

  // Для обратной совместимости
  onData(callback: (from: PublicKey, message: Uint8Array) => void): void {
    this.on('message', (from, content) => callback(from, content));
  }
}