/**
 * Public surface of the session and networking layer.
 *
 * The shell only needs `GameSession`; the transports are exported so a host
 * page can choose how (or whether) a table is shared.
 */

export {
  GameSession,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  parseSnapshot,
  type Rejection,
  type SessionListener,
  type SessionSnapshot,
} from './session.js';

export {
  BroadcastChannelTransport,
  LocalTransport,
  PROTOCOL_VERSION,
  WebSocketTransport,
  isCommand,
  isFrame,
  newClientId,
  parseFrame,
  type BroadcastChannelLike,
  type BroadcastTransportOptions,
  type CommandFrame,
  type ConnectionStatus,
  type Frame,
  type JoinFrame,
  type LogFrame,
  type SocketLike,
  type Transport,
  type TransportKind,
  type WebSocketTransportOptions,
} from './transport.js';

// The server-authoritative layer: wire protocol, redaction, and the client that
// speaks to `server/`. Peer relay play does not need any of this.
export * from './protocol.js';
export * from './redact.js';
export * from './client.js';
