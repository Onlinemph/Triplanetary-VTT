/**
 * `CampaignSession` — the campaign's counterpart to `GameSession`, and the
 * same idea at a different altitude: hold the current state, the accepted
 * command log, and the subscriber list, and let undo, save and load all be
 * "replay this list from the start".
 *
 * A campaign save is *smaller* than a battle save: the initial state is fully
 * determined by the seed (`createCampaign` is pure), so the file is a seed
 * and a log — which also means a saved campaign carries the replay of every
 * battle fought in it, because each `reportBattle` command holds the
 * `BattleResult` and each result holds its `{seed, log}`.
 */

import {
  type CampaignCommand,
  type CampaignState,
  applyCampaignCommand,
  createCampaign,
} from './engine.js';

export interface RefusedCampaignCommand {
  readonly cmd: CampaignCommand;
  readonly reason: string;
}

interface CampaignSave {
  readonly format: 'triplanetary-campaign';
  readonly v: 1;
  readonly seed: number;
  readonly log: readonly CampaignCommand[];
}

const FORMAT = 'triplanetary-campaign';

export class CampaignSession {
  readonly seed: number;

  private current: CampaignState;
  private readonly commands: CampaignCommand[] = [];
  private readonly subscribers = new Set<() => void>();
  private readonly refusals: RefusedCampaignCommand[] = [];

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.current = createCampaign(this.seed);
  }

  get state(): CampaignState {
    return this.current;
  }

  get log(): readonly CampaignCommand[] {
    return this.commands;
  }

  get refused(): readonly RefusedCampaignCommand[] {
    return this.refusals;
  }

  get canUndo(): boolean {
    return this.commands.length > 0;
  }

  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  dispatch(cmd: CampaignCommand): { ok: true } | { ok: false; reason: string } {
    const { state, result } = applyCampaignCommand(this.current, cmd);
    if (!result.ok) {
      const reason = result.reason ?? 'the campaign refused that';
      this.refusals.push({ cmd, reason });
      if (this.refusals.length > 12) this.refusals.shift();
      return { ok: false, reason };
    }
    this.current = state;
    this.commands.push(cmd);
    this.notify();
    return { ok: true };
  }

  /** Recompute the whole campaign from its seed. Exact, by construction. */
  replay(commands: readonly CampaignCommand[]): void {
    let state = createCampaign(this.seed);
    const accepted: CampaignCommand[] = [];
    for (const cmd of commands) {
      const step = applyCampaignCommand(state, cmd);
      if (!step.result.ok) continue;
      state = step.state;
      accepted.push(cmd);
    }
    this.current = state;
    this.commands.length = 0;
    this.commands.push(...accepted);
    this.notify();
  }

  undo(): void {
    if (!this.canUndo) return;
    this.replay(this.commands.slice(0, -1));
  }

  serialise(): string {
    const save: CampaignSave = { format: FORMAT, v: 1, seed: this.seed, log: this.commands };
    return JSON.stringify(save);
  }

  static deserialise(text: string): CampaignSession {
    const parsed = JSON.parse(text) as Partial<CampaignSave>;
    if (parsed.format !== FORMAT || typeof parsed.seed !== 'number' || !Array.isArray(parsed.log)) {
      throw new Error('this is not a saved campaign');
    }
    const session = new CampaignSession(parsed.seed);
    session.replay(parsed.log);
    return session;
  }

  private notify(): void {
    for (const fn of this.subscribers) fn();
  }
}
