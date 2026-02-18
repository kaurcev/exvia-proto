import { IStorage } from './storage';
import { TypedEventEmitter, EventMap } from './events';

export interface ServerManagerEvents extends EventMap {
  listChanged: [servers: string[]];
  selectedChanged: [server: string | null];
}

export interface IServerManager {
  getServers(): string[];
  addServer(address: string): void;
  removeServer(address: string): void;
  setSelectedServer(address: string | null): void;
  getSelectedServer(): string | null;
  on<K extends keyof ServerManagerEvents>(event: K, listener: (...args: ServerManagerEvents[K]) => void): void;
  off<K extends keyof ServerManagerEvents>(event: K, listener: (...args: ServerManagerEvents[K]) => void): void;
}

export class LocalServerManager
  extends TypedEventEmitter<ServerManagerEvents>
  implements IServerManager
{
  private servers: string[];
  private selected: string | null = null;
  private readonly storageKey = 'sdk:servers';
  private readonly selectedKey = 'sdk:selectedServer';

  constructor(private storage: IStorage) {
    super();
    const saved = this.storage.getItem(this.storageKey);
    this.servers = saved ? JSON.parse(saved) : [];
    const savedSelected = this.storage.getItem(this.selectedKey);
    this.selected = savedSelected || null;
  }

  private saveServers(): void {
    this.storage.setItem(this.storageKey, JSON.stringify(this.servers));
    this.emit('listChanged', this.servers.slice());
  }

  getServers(): string[] {
    return this.servers.slice();
  }

  addServer(address: string): void {
    if (!this.servers.includes(address)) {
      this.servers.push(address);
      this.saveServers();
    }
  }

  removeServer(address: string): void {
    const index = this.servers.indexOf(address);
    if (index !== -1) {
      this.servers.splice(index, 1);
      if (this.selected === address) {
        this.setSelectedServer(this.servers[0] || null);
      }
      this.saveServers();
    }
  }

  setSelectedServer(address: string | null): void {
    if (address !== null && !this.servers.includes(address)) {
      throw new Error('Server not in list');
    }
    this.selected = address;
    if (address === null) {
      this.storage.removeItem(this.selectedKey);
    } else {
      this.storage.setItem(this.selectedKey, address);
    }
    this.emit('selectedChanged', address);
  }

  getSelectedServer(): string | null {
    return this.selected;
  }
}