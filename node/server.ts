import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';
import { randomBytes } from 'crypto';
import { generateKeyPairFromSeed, sign, verify } from '@stablelib/ed25519';
import { 
  MsgType, 
  encodeFrame, 
  decodeFrame, 
  Frame,
  NODE_INFO_REQUEST_CLIENTS,
  NODE_INFO_RESPONSE_CLIENTS,
  NODE_INFO_REQUEST_SERVERS,
  NODE_INFO_RESPONSE_SERVERS,
  NODE_INFO_ADD_SERVER,
  NODE_INFO_QUERY_CLIENT,
  NODE_INFO_QUERY_RESPONSE
} from '../shared/protocol';

interface KnownServer {
  address: string;
  publicKey: Uint8Array;
  socket?: WebSocket;
}

class RelayServer {
  private wss: WebSocketServer;
  private serverPrivateKey: Uint8Array;
  public serverPublicKey: Uint8Array;
  private localClients = new Map<string, WebSocket>(); // ключ hex -> сокет
  private knownServers = new Map<string, KnownServer>(); // ключ hex -> информация о сервере
  private pendingQueries = new Map<string, { frame: Frame, timer: NodeJS.Timeout }>(); // targetHex -> ожидающий DATA

  constructor(port: number) {
    const seed = randomBytes(32);
    const keyPair = generateKeyPairFromSeed(seed);
    this.serverPrivateKey = keyPair.secretKey;
    this.serverPublicKey = keyPair.publicKey;

    console.log(`Server public key: ${Buffer.from(this.serverPublicKey).toString('hex')}`);

    this.wss = new WebSocketServer({ port });
    console.log(`Relay listening on port ${port}`);
    this.setupServer();
  }

  private setupServer() {
    this.wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });
  }

  connectToServer(address: string) {
    console.log(`Connecting to peer server: ${address}`);
    const ws = new WebSocket(address);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      console.log('Connected to peer server, starting handshake...');
      this.initiateHandshake(ws);
    };

    ws.onmessage = async (e) => {
      await this.handlePeerMessage(ws, e.data as ArrayBuffer);
    };

    ws.onclose = () => {
      console.log('Disconnected from peer server');
      for (const [key, srv] of this.knownServers.entries()) {
        if (srv.socket === ws) {
          this.knownServers.delete(key);
          break;
        }
      }
    };

    ws.onerror = (err) => {
      console.error('Peer connection error:', err);
    };
  }

  private initiateHandshake(ws: WebSocket) {
    const challenge = randomBytes(32);
    (ws as any).pendingChallenge = challenge;
    ws.send(encodeFrame({
      type: MsgType.HANDSHAKE,
      payload: challenge,
      senderId: new Uint8Array(32)
    }));
  }

  private async handlePeerMessage(ws: WebSocket, data: ArrayBuffer) {
    try {
      const frame = decodeFrame(data);

      if (frame.type === MsgType.HANDSHAKE) {
        if (frame.payload.length === 32 && frame.signature?.length === 64) {
          const isValid = await verify(frame.senderId, frame.payload, frame.signature);
          if (isValid) {
            const publicKeyHex = Buffer.from(frame.senderId).toString('hex');
            this.knownServers.set(publicKeyHex, {
              address: (ws as any).url,
              publicKey: frame.senderId,
              socket: ws
            });
            console.log(`Peer server ${publicKeyHex.slice(0,8)} authenticated`);

            ws.send(encodeFrame({
              type: MsgType.HANDSHAKE,
              payload: new Uint8Array([1]),
              senderId: this.serverPublicKey
            }));

            this.requestNodeInfo(ws, NODE_INFO_REQUEST_SERVERS);
          } else {
            ws.close();
          }
        }
        else if (frame.payload.length === 32 && !frame.signature) {
          const signature = sign(this.serverPrivateKey, frame.payload);
          ws.send(encodeFrame({
            type: MsgType.HANDSHAKE,
            payload: frame.payload,
            senderId: this.serverPublicKey,
            signature: signature
          }));
        }
        else if (frame.payload.length === 1 && frame.payload[0] === 1) {
          console.log('Handshake with peer server successful');
          this.requestNodeInfo(ws, NODE_INFO_REQUEST_SERVERS);
        }
      }
      else if (frame.type === MsgType.NODE_INFO) {
        const subType = frame.payload[0];
        if (subType === NODE_INFO_QUERY_CLIENT) {
          await this.handleNodeInfoQuery(frame);
        } else if (subType === NODE_INFO_QUERY_RESPONSE) {
          await this.handleNodeInfoResponse(frame);
        } else {
          await this.handleNodeInfo(ws, frame);
        }
      }
      else if (frame.type === MsgType.DATA) {
        await this.handleRelayedData(frame);
      }
    } catch (err) {
      console.error('Error handling peer message:', err);
    }
  }

  private requestNodeInfo(ws: WebSocket, requestType: number) {
    ws.send(encodeFrame({
      type: MsgType.NODE_INFO,
      payload: new Uint8Array([requestType]),
      senderId: this.serverPublicKey
    }));
  }

  private async handleNodeInfo(ws: WebSocket, frame: Frame) {
    if (frame.payload.length === 0) return;
    const requestType = frame.payload[0];

    if (requestType === NODE_INFO_REQUEST_SERVERS) {
      const serversArray = Array.from(this.knownServers.entries()).filter(([key, s]) => s.publicKey && s.address);
      let totalSize = 1 + 2; // тип + количество (2 байта)
      const chunks: Buffer[] = [];
      for (const [key, s] of serversArray) {
        const addrBuf = Buffer.from(s.address, 'utf8');
        totalSize += 32 + 1 + addrBuf.length; // публичный ключ + длина адреса + адрес
        chunks.push(Buffer.from(s.publicKey));
        chunks.push(Buffer.from([addrBuf.length]));
        chunks.push(addrBuf);
      }
      const payload = Buffer.alloc(totalSize);
      payload[0] = NODE_INFO_RESPONSE_SERVERS;
      payload.writeUInt16BE(serversArray.length, 1);
      let offset = 3;
      for (const chunk of chunks) {
        chunk.copy(payload, offset);
        offset += chunk.length;
      }
      ws.send(encodeFrame({
        type: MsgType.NODE_INFO,
        payload: new Uint8Array(payload),
        senderId: this.serverPublicKey
      }));
    }
    else if (requestType === NODE_INFO_RESPONSE_SERVERS) {
      const serverKeyHex = Buffer.from(frame.senderId).toString('hex');
      const server = this.knownServers.get(serverKeyHex);
      if (!server) return;

      const payloadBuf = Buffer.from(frame.payload);
      const count = payloadBuf.readUInt16BE(1);
      let offset = 3;
      for (let i = 0; i < count; i++) {
        if (offset + 32 > payloadBuf.length) break;
        const pubKey = payloadBuf.slice(offset, offset + 32);
        offset += 32;
        if (offset >= payloadBuf.length) break;
        const addrLen = payloadBuf[offset];
        if (addrLen === undefined) break;
        offset += 1;
        if (offset + addrLen > payloadBuf.length) break;
        const addr = payloadBuf.slice(offset, offset + addrLen).toString('utf8');
        offset += addrLen;

        const pubKeyHex = pubKey.toString('hex');
        if (!this.knownServers.has(pubKeyHex) && pubKeyHex !== Buffer.from(this.serverPublicKey).toString('hex')) {
          console.log(`Discovered new server: ${addr} (${pubKeyHex.slice(0,8)})`);
          this.knownServers.set(pubKeyHex, {
            address: addr,
            publicKey: new Uint8Array(pubKey)
          });
          setTimeout(() => this.connectToServer(addr), 100);
        }
      }
    }
  }

  private handleConnection(ws: WebSocket) {
    console.log('New client connection');
    const challenge = randomBytes(32);
    (ws as any).pendingChallenge = challenge;

    ws.send(encodeFrame({
      type: MsgType.HANDSHAKE,
      payload: challenge,
      senderId: new Uint8Array(32)
    }));

    ws.on('message', async (data: RawData) => {
      try {
        const buffer = data as Buffer;
        const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
        const frame = decodeFrame(arrayBuffer);

        if (!(ws as any).authenticated) {
          if (frame.type !== MsgType.HANDSHAKE) {
            ws.close();
            return;
          }
          await this.handleClientHandshake(ws, frame);
        } else {
          if (frame.type === MsgType.DATA) {
            await this.handleClientData(ws, frame);
          } else if (frame.type === MsgType.NODE_INFO) {
            await this.handleNodeInfoFromClient(ws, frame);
          } else {
            ws.close();
          }
        }
      } catch (err) {
        console.error('Error handling client message:', err);
        ws.close();
      }
    });

    ws.on('close', () => {
      this.handleClientDisconnect(ws);
    });
  }

  private async handleClientHandshake(ws: WebSocket, frame: Frame) {
    if (frame.payload.length === 32 && frame.signature?.length === 64) {
      const publicKeyHex = Buffer.from(frame.senderId).toString('hex');
      const isValid = await verify(frame.senderId, frame.payload, frame.signature);
      if (isValid) {
        this.localClients.set(publicKeyHex, ws);
        (ws as any).authenticated = true;
        console.log(`Client ${publicKeyHex.slice(0,8)} authenticated`);

        ws.send(encodeFrame({
          type: MsgType.HANDSHAKE,
          payload: new Uint8Array([1]),
          senderId: new Uint8Array(32)
        }));
      } else {
        ws.close();
      }
    } else {
      ws.close();
    }
  }

  private async handleClientData(ws: WebSocket, frame: Frame) {
    if (frame.payload.length < 32) return;

    const targetKey = frame.payload.slice(0, 32);
    const targetHex = Buffer.from(targetKey).toString('hex');
    console.log(`Received DATA for client ${targetHex.slice(0,8)}`);

    if (this.localClients.has(targetHex)) {
      console.log(`Target is local, delivering directly`);
      const targetWs = this.localClients.get(targetHex);
      if (targetWs?.readyState === WebSocket.OPEN) {
        targetWs.send(encodeFrame({
          type: MsgType.DATA,
          payload: frame.payload.slice(32),
          senderId: frame.senderId
        }));
      }
      return;
    }

    console.log(`Target not local, starting query`);
    this.queryClientLocation(targetHex, frame);
  }

  private async handleRelayedData(frame: Frame) {
    if (frame.payload.length < 32) return;
    const targetKey = frame.payload.slice(0, 32);
    const targetHex = Buffer.from(targetKey).toString('hex');
    console.log(`Received relayed DATA for client ${targetHex.slice(0,8)}`);

    if (this.localClients.has(targetHex)) {
      console.log(`Target is local, delivering`);
      const targetWs = this.localClients.get(targetHex);
      if (targetWs?.readyState === WebSocket.OPEN) {
        targetWs.send(encodeFrame({
          type: MsgType.DATA,
          payload: frame.payload.slice(32),
          senderId: frame.senderId
        }));
      }
    } else {
      console.log(`Relayed DATA for unknown client, ignoring`);
    }
  }

  private queryClientLocation(targetHex: string, originalFrame: Frame) {
    if (this.pendingQueries.has(targetHex)) {
      console.log(`Query already pending for ${targetHex.slice(0,8)}`);
      return;
    }

    const frameCopy: Frame = {
      type: originalFrame.type,
      payload: originalFrame.payload.slice(),
      senderId: originalFrame.senderId.slice()
    };
    if (originalFrame.signature) {
      frameCopy.signature = originalFrame.signature.slice();
    }

    const timer = setTimeout(() => {
      this.pendingQueries.delete(targetHex);
      console.log(`Query for ${targetHex.slice(0,8)} timed out`);
    }, 5000);

    this.pendingQueries.set(targetHex, { frame: frameCopy, timer });

    const queryPayload = new Uint8Array(1 + 32);
    queryPayload[0] = NODE_INFO_QUERY_CLIENT;
    queryPayload.set(Buffer.from(targetHex, 'hex'), 1);

    console.log(`Broadcasting query for ${targetHex.slice(0,8)} to ${this.knownServers.size} servers`);
    for (const [serverKey, server] of this.knownServers.entries()) {
      if (server.socket?.readyState === WebSocket.OPEN) {
        server.socket.send(encodeFrame({
          type: MsgType.NODE_INFO,
          payload: queryPayload,
          senderId: this.serverPublicKey
        }));
      }
    }
  }

  private async handleNodeInfoQuery(frame: Frame) {
    const payload = frame.payload;
    if (payload.length < 1 + 32) return;
    const targetKey = payload.slice(1, 33);
    const targetHex = Buffer.from(targetKey).toString('hex');
    console.log(`Received query for client ${targetHex.slice(0,8)}`);

    const found = this.localClients.has(targetHex);
    console.log(`Client ${targetHex.slice(0,8)} local: ${found}`);

    const responsePayload = found
      ? new Uint8Array(1 + 1 + 32 + 32)
      : new Uint8Array(1 + 1 + 32);
    responsePayload[0] = NODE_INFO_QUERY_RESPONSE;
    responsePayload[1] = found ? 1 : 0;
    responsePayload.set(targetKey, 2);
    if (found) {
      responsePayload.set(this.serverPublicKey, 2 + 32);
    }

    const responseFrame = encodeFrame({
      type: MsgType.NODE_INFO,
      payload: responsePayload,
      senderId: this.serverPublicKey
    });

    const requesterHex = Buffer.from(frame.senderId).toString('hex');
    const requester = this.knownServers.get(requesterHex);
    if (requester?.socket?.readyState === WebSocket.OPEN) {
      requester.socket.send(responseFrame);
      console.log(`Sent response to ${requesterHex.slice(0,8)}`);
    }
  }

  private async handleNodeInfoResponse(frame: Frame) {
    const payload = frame.payload;
    if (payload.length < 1 + 1 + 32) return;
    const status = payload[1];
    const targetClient = payload.slice(2, 2 + 32);
    const targetClientHex = Buffer.from(targetClient).toString('hex');
    console.log(`Received query response for ${targetClientHex.slice(0,8)} with status ${status}`);

    if (status === 1 && payload.length >= 1 + 1 + 32 + 32) {
      const targetServer = payload.slice(2 + 32, 2 + 32 + 32);
      const targetServerHex = Buffer.from(targetServer).toString('hex');

      const pending = this.pendingQueries.get(targetClientHex);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingQueries.delete(targetClientHex);
        console.log(`Found client ${targetClientHex.slice(0,8)} on server ${targetServerHex.slice(0,8)}, forwarding message`);

        const server = this.knownServers.get(targetServerHex);
        if (server?.socket?.readyState === WebSocket.OPEN) {
          server.socket.send(encodeFrame({
            type: MsgType.DATA,
            payload: pending.frame.payload,
            senderId: pending.frame.senderId
          }));
        } else {
          console.log(`Server ${targetServerHex.slice(0,8)} not connected, cannot forward`);
        }
      }
    }
  }

  private async handleNodeInfoFromClient(ws: WebSocket, frame: Frame) {
    const clientKeyHex = Buffer.from(frame.senderId).toString('hex');
    if (!this.localClients.has(clientKeyHex)) {
      console.warn('NODE_INFO from unknown client');
      ws.close();
      return;
    }

    const payload = frame.payload;
    if (payload.length === 0) return;
    const subType = payload[0];

    if (subType === NODE_INFO_ADD_SERVER) {
      if (payload.length < 2) return;
      const addrLen = payload[1];
      if (addrLen === undefined) return;
      if (payload.length < 2 + addrLen) return;
      const addressBytes = payload.slice(2, 2 + addrLen);
      const address = new TextDecoder().decode(addressBytes);
      console.log(`Client ${clientKeyHex.slice(0,8)} requested to add server: ${address}`);

      let alreadyKnown = false;
      for (const s of this.knownServers.values()) {
        if (s.address === address) {
          alreadyKnown = true;
          break;
        }
      }
      if (!alreadyKnown && address !== `ws://localhost:${(this.wss.options.port as number)}`) {
        console.log(`Initiating connection to new server ${address}`);
        this.connectToServer(address);
      } else {
        console.log(`Server ${address} already known or self`);
      }
    }
  }

  private handleClientDisconnect(ws: WebSocket) {
    for (const [key, clientWs] of this.localClients.entries()) {
      if (clientWs === ws) {
        this.localClients.delete(key);
        console.log(`Client ${key.slice(0,8)} disconnected`);
        break;
      }
    }
  }

  addSeedServer(address: string) {
    this.connectToServer(address);
  }
}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const server = new RelayServer(PORT);

const args = process.argv.slice(2);
const connectIndex = args.indexOf('--connect');
if (connectIndex !== -1) {
  const peerAddress = args[connectIndex + 1];
  if (peerAddress) {
    setTimeout(() => server.addSeedServer(peerAddress), 1000);
  }
}