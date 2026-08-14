import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, loadServerModule, RUNTIME_DIST } from './harness.ts';

async function loadModule(stateDir: string) {
  process.env.PRINNY_STATE_DIR = stateDir;
  vi.resetModules();
  return loadServerModule('queue');
}

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'prinny-queue-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  delete process.env.PRINNY_STATE_DIR;
});

/**
 * Timestamps are relative to now, because the queue ages entries out after
 * seven days — epoch-era values would simply be discarded as ancient.
 */
const NOW = Date.now();
const at = (offsetMs: number) => NOW + offsetMs;

function message(id: string, ts: number) {
  return { id, ts, content: `msg ${id}`, meta: { room_id: '!r:example.org', message_id: id } };
}

describe('enqueue', () => {
  it('queues a message', async () => {
    const q = await loadModule(stateDir);
    expect(q.enqueue(message('$a', at(-3000)))).toBe(true);
    expect(q.readQueue().map((m) => m.id)).toEqual(['$a']);
  });

  it('refuses a duplicate event id', async () => {
    const q = await loadModule(stateDir);
    q.enqueue(message('$a', at(-3000)));
    expect(q.enqueue(message('$a', at(-3000)))).toBe(false);
    expect(q.readQueue()).toHaveLength(1);
  });

  it('refuses anything already delivered, which is what stops a re-answer', async () => {
    const q = await loadModule(stateDir);
    q.writeWatermark(at(-3000));
    expect(q.enqueue(message('$old', at(-4000)))).toBe(false);
    expect(q.enqueue(message('$new', at(-1000)))).toBe(true);
  });

  it('keeps the queue in timestamp order however it arrives', async () => {
    const q = await loadModule(stateDir);
    q.enqueue(message('$c', at(-1000)));
    q.enqueue(message('$a', at(-3000)));
    q.enqueue(message('$b', at(-2000)));
    expect(q.readQueue().map((m) => m.id)).toEqual(['$a', '$b', '$c']);
  });

  it('drops messages older than the age cap', async () => {
    const q = await loadModule(stateDir);
    const now = NOW;
    q.enqueue(message('$ancient', now - q.MAX_AGE_MS - 1), now);
    q.enqueue(message('$fresh', now - 1000), now);
    expect(q.readQueue().map((m) => m.id)).toEqual(['$fresh']);
  });

  it('keeps the newest when over the cap — you want the end of a conversation', async () => {
    const q = await loadModule(stateDir);
    for (let i = 1; i <= q.MAX_QUEUED + 5; i += 1) q.enqueue(message(`$${i}`, at(-100_000 + i * 1000)));
    const queue = q.readQueue();
    expect(queue).toHaveLength(q.MAX_QUEUED);
    expect(queue[queue.length - 1]!.id).toBe(`$${q.MAX_QUEUED + 5}`);
    expect(queue.some((m) => m.id === '$1')).toBe(false);
  });
});

describe('flush', () => {
  it('delivers oldest first and empties the queue', async () => {
    const q = await loadModule(stateDir);
    q.enqueue(message('$a', at(-3000)));
    q.enqueue(message('$b', at(-2000)));

    const seen: string[] = [];
    const result = await q.flush(async (m) => {
      seen.push(m.id);
    });

    expect(seen).toEqual(['$a', '$b']);
    expect(result).toEqual({ delivered: 2, remaining: 0 });
    expect(q.readQueue()).toHaveLength(0);
  });

  it('advances the watermark so a restart does not replay', async () => {
    const q = await loadModule(stateDir);
    q.enqueue(message('$a', at(-3000)));
    await q.flush(async () => undefined);
    expect(q.readWatermark()).toBe(at(-3000));
    expect(q.enqueue(message('$a', at(-3000)))).toBe(false);
  });

  it('stops at the first failure and keeps the rest queued', async () => {
    const q = await loadModule(stateDir);
    q.enqueue(message('$a', at(-3000)));
    q.enqueue(message('$b', at(-2000)));
    q.enqueue(message('$c', at(-1000)));

    const seen: string[] = [];
    const result = await q.flush(async (m) => {
      seen.push(m.id);
      if (m.id === '$b') throw new Error('session went away');
    });

    expect(seen).toEqual(['$a', '$b']);
    expect(result.delivered).toBe(1);
    // $b must survive: it was attempted, not delivered. Dropping it here is
    // exactly the data loss the queue exists to prevent.
    expect(q.readQueue().map((m) => m.id)).toEqual(['$b', '$c']);
    expect(q.readWatermark()).toBe(at(-3000));
  });

  it('passes position, so a backlog item can be labelled as one', async () => {
    const q = await loadModule(stateDir);
    q.enqueue(message('$a', at(-3000)));
    q.enqueue(message('$b', at(-2000)));
    const positions: string[] = [];
    await q.flush(async (_m, index, total) => {
      positions.push(`${index + 1}/${total}`);
    });
    expect(positions).toEqual(['1/2', '2/2']);
  });

  it('is a no-op on an empty queue', async () => {
    const q = await loadModule(stateDir);
    let called = false;
    const result = await q.flush(async () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(result).toEqual({ delivered: 0, remaining: 0 });
  });
});

describe('durability', () => {
  it('survives a process restart', async () => {
    const first = await loadModule(stateDir);
    first.enqueue(message('$a', at(-3000)));

    // Fresh module registry, same state directory — a new process.
    const second = await loadModule(stateDir);
    expect(second.readQueue().map((m) => m.id)).toEqual(['$a']);
  });

  it('keeps a message that was queued but never delivered', async () => {
    const first = await loadModule(stateDir);
    first.enqueue(message('$a', at(-3000)));
    // Simulates a crash between queueing and delivering: no flush happens.
    const second = await loadModule(stateDir);
    expect(second.readQueue()).toHaveLength(1);
    expect(second.readWatermark()).toBe(0);
  });

  it('starts fresh from a corrupt queue file rather than refusing to run', async () => {
    writeFileSync(join(stateDir, 'queue.json'), '{ not json');
    const q = await loadModule(stateDir);
    expect(q.readQueue()).toEqual([]);
    expect(q.enqueue(message('$a', at(-3000)))).toBe(true);
  });

  it('writes the queue atomically, leaving no partial file behind', async () => {
    const q = await loadModule(stateDir);
    q.enqueue(message('$a', at(-3000)));
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(stateDir).some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(JSON.parse(readFileSync(join(stateDir, 'queue.json'), 'utf8'))).toHaveLength(1);
  });

  it('never moves the watermark backwards', async () => {
    const q = await loadModule(stateDir);
    q.writeWatermark(at(-1000));
    q.writeWatermark(at(-9000));
    expect(q.readWatermark()).toBe(at(-1000));
  });
});
