import { MsgType } from '../../shared/protocol';

export type HexString = string;
export type PublicKey = Uint8Array;
export type PrivateKey = Uint8Array;
export type Signature = Uint8Array;

export enum ContentType {
  RAW = 0,      // без заголовка (старый формат)
  TEXT = 1,     // UTF-8 текст
  JSON = 2,     // JSON-объект
  FILE = 3,     // файл (имя + данные)
}

export interface Frame {
  type: MsgType;
  payload: Uint8Array;
  senderId: PublicKey;
  signature?: Signature;
}

export interface MessageEvent {
  from: PublicKey;
  content: Uint8Array;
  contentType?: ContentType;
  parsed?: any; // для TEXT, JSON, FILE
}