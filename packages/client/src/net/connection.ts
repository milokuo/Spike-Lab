import { Client, type Room } from 'colyseus.js';
import { ROOM_NAME } from '@spike/shared';
import { deriveWsUrl, type PracticeCreateOptions } from '../config';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface ConnectionHandle {
  room: Room;
}

export type StatusListener = (status: ConnectionStatus) => void;

// Thin wrapper around colyseus.js create/join-by-code/reconnect + status
// reporting, so main.ts and the lobby UI don't need to know about the Client
// type directly. M2.1 §d: room code IS Colyseus's own `room.roomId` — no
// custom code-generation, so create() and joinByCode() are the only two ways
// into a room (no more blind joinOrCreate()).
export class Connection {
  private client: Client;
  private listeners: Set<StatusListener> = new Set();
  private currentRoom: Room | undefined;

  constructor() {
    this.client = new Client(deriveWsUrl());
  }

  onStatus(listener: StatusListener): void {
    this.listeners.add(listener);
  }

  private emitStatus(status: ConnectionStatus): void {
    for (const listener of this.listeners) listener(status);
  }

  get room(): Room | undefined {
    return this.currentRoom;
  }

  // Host flow: creates a brand-new room; its roomId becomes the shareable code.
  // M2.9 §5 — an optional { mode: 'practice' } is forwarded verbatim to the
  // server's onCreate(options) to spin up a private single-player sandbox room.
  // Absent -> a normal versus room (server treats unknown/missing mode as versus).
  async createRoom(options?: PracticeCreateOptions): Promise<Room> {
    return this.join(() => this.client.create(ROOM_NAME, options));
  }

  // Guest flow: joins an existing room by the code a friend shared. Colyseus
  // rejects a full/locked/nonexistent room — caller surfaces the thrown error.
  async joinRoomByCode(code: string): Promise<Room> {
    return this.join(() => this.client.joinById(code));
  }

  private async join(attempt: () => Promise<Room>): Promise<Room> {
    this.emitStatus('connecting');
    try {
      const room = await attempt();
      this.currentRoom = room;
      this.emitStatus('connected');
      room.onLeave(() => {
        this.currentRoom = undefined;
        this.emitStatus('disconnected');
      });
      room.onError(() => {
        this.emitStatus('error');
      });
      return room;
    } catch (error: unknown) {
      this.emitStatus('error');
      throw error instanceof Error ? error : new Error('Failed to join room');
    }
  }

  disconnect(): void {
    this.currentRoom?.leave();
    this.currentRoom = undefined;
  }
}
