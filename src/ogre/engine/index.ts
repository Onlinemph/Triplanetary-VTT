/**
 * The engine's public surface.
 *
 * Everything outside `src/engine` imports from here, so the modules inside can
 * be rearranged without touching the shell. The rule this barrel exists to keep
 * visible: data flows *out* of the engine as state, and *in* as commands. There
 * is no other way through.
 */

export * from './hex.js';
export * from './terrain.js';
export * from './units.js';
export * from './ogres.js';
export * from './crt.js';
export * from './rng.js';
export * from './map.js';
export * from './mapdata.js';
export * from './types.js';
export * from './commands.js';
export * from './state.js';
export * from './mobility.js';
export * from './movement.js';
export * from './combat.js';
export * from './ram.js';
export * from './overrun.js';
export * from './reducer.js';
