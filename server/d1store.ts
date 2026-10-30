import type { TwinState } from '../engine/types.js';

/**
 * Durable twin-state persistence for multi-isolate deployments.
 * Single-row JSON document in D1; every write replaces the row so a read
 * always reflects the latest committed mutation (documented demo-scale
 * trade-off: last-writer-wins, no cross-isolate transactions).
 */
export interface TwinStore {
  load(): Promise<TwinState | null>;
  save(state: TwinState): Promise<void>;
  kind: 'durable' | 'memory';
}

interface Prepared {
  run(): Promise<unknown>;
  first<T = unknown>(): Promise<T | null>;
  bind(...vals: unknown[]): Prepared;
}

interface D1Like {
  prepare(sql: string): Prepared;
  exec(sql: string): Promise<unknown>;
}

export class D1TwinStore implements TwinStore {
  readonly kind = 'durable' as const;
  private schemaReady = false;

  constructor(private db: D1Like) {}

  async load(): Promise<TwinState | null> {
    try {
      if (!this.schemaReady) {
        await this.db.prepare(
          'CREATE TABLE IF NOT EXISTS twin_state (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL, updated_at TEXT NOT NULL)',
        ).run();
        this.schemaReady = true;
      }
      const row = await this.db.prepare('SELECT value FROM twin_state WHERE id = 1').first<{ value: string }>();
      if (!row?.value) return null;
      return JSON.parse(row.value) as TwinState;
    } catch {
      // Missing table on first boot is fine; caller falls back to a fresh twin.
      return null;
    }
  }

  async save(state: TwinState): Promise<void> {
    if (!this.schemaReady) {
      await this.db.prepare(
        'CREATE TABLE IF NOT EXISTS twin_state (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL, updated_at TEXT NOT NULL)',
      ).run();
      this.schemaReady = true;
    }
    await this.db.prepare(
      'INSERT INTO twin_state (id, value, updated_at) VALUES (1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).bind(JSON.stringify(state), new Date().toISOString()).run();
  }
}

export class MemoryTwinStore implements TwinStore {
  readonly kind = 'memory' as const;
  private state: TwinState | null = null;
  async load(): Promise<TwinState | null> { return this.state; }
  async save(state: TwinState): Promise<void> { this.state = state; }
}

/** Wraps a store into the per-request twin lifecycle used by createApp(). */
export type StoreAdapter = {
  load(): Promise<TwinState | null>;
  save(state: TwinState): Promise<void>;
};

export function makeStoreAdapter(db: D1Like | undefined): StoreAdapter & { kind: 'durable' | 'memory' } {
  if (db) { const s = new D1TwinStore(db); return { kind: 'durable', load: () => s.load(), save: (st) => s.save(st) }; }
  const s = new MemoryTwinStore();
  return { kind: 'memory', load: () => s.load(), save: (st) => s.save(st) };
}
