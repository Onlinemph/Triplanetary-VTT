/**
 * Public surface of online play on Supabase.
 *
 * The shell imports this and nothing deeper. What it gets is the contract
 * (`protocol.ts`), the client that speaks it (`client.ts`), and the handful of
 * referee functions that are genuinely a browser's business — reading a join
 * code, and knowing how long a seat stays present.
 *
 * The rest of `referee.ts` is deliberately not re-exported. `judge`, `takeSeat`
 * and `playComputerSeats` are the referee's authority, and the only participant
 * entitled to exercise them is the Edge Function holding the service role. They
 * are importable by anyone who reaches for the module directly — this is a
 * bundler, not a security boundary — but a barrel that offers them to the UI
 * invites a client to decide something it may not decide.
 */

export {
  TableClient,
  type ChannelLike,
  type CreateOptions,
  type PostgresChangeFilter,
  type SupabaseLike,
  type TableClientEvents,
  type TableClientOptions,
  type TableConnection,
} from './client.js';

// The wire contract: request and response shapes, seat and table info, the
// channel name, and the table names the migrations use.
export * from './protocol.js';

export { CODE_ALPHABET, CODE_LENGTH, PRESENCE_MS, codeFrom, isCode, replayLog } from './referee.js';

// The other way to play online: no Edge Function, no service role, one SQL
// file pasted into a dashboard. `quick.ts` explains what it trades away for
// that, and `supabase/quick/README.md` is the page a player is sent to.
export {
  QuickTable,
  fingerprint,
  type QuickEvents,
  type QuickLike,
  type QuickListing,
  type QuickMove,
  type QuickSeat,
  type QuickSetup,
  type QuickTableInfo,
} from './quick.js';
