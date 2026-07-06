// Server bootstrap: bind Colyseus to HOST:PORT and register the single
// well-known match room type (plan §5 WP2 acceptance: boots on 0.0.0.0:2567).
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ROOM_NAME } from '@spike/shared';
import { HOST, PORT } from './config';
import { MatchRoom } from './rooms/MatchRoom';

async function main(): Promise<void> {
  const gameServer = new Server({
    transport: new WebSocketTransport(),
  });

  gameServer.define(ROOM_NAME, MatchRoom);

  await gameServer.listen(PORT, HOST);
  // eslint-disable-next-line no-console
  console.log(`[spike-server] listening on ws://${HOST}:${PORT} (room "${ROOM_NAME}")`);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[spike-server] fatal', err);
  process.exit(1);
});
