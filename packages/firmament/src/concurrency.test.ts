import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, MemoryStore, FileStore, generateSigner } from './index.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Entry } from './index.ts';

const input = (n: number) => ({ type: 'audit' as const, product: 'spectre', actor: 'cid:test', subject: `record:${n}`, payload: { n } });

it('serializes concurrent writers sharing one store', async () => {
  const store = new MemoryStore();
  const writers = [new Ledger(store), new Ledger(store)];
  const signer = generateSigner();
  const entries = await Promise.all(Array.from({ length: 40 }, (_, n) => writers[n % 2].append(input(n), signer)));
  assert.equal(new Set(entries.map(e => e.seq)).size, 40);
  assert.deepEqual(await writers[0].verify(), { ok: true, length: 40 });
});

it('continues after a failed append without leaving a sequence gap', async () => {
  class FailingStore extends MemoryStore {
    fail = true;
    override async append(entry: Entry) {
      if (this.fail) { this.fail = false; throw new Error('disk unavailable'); }
      await super.append(entry);
    }
  }
  const ledger = new Ledger(new FailingStore());
  const signer = generateSigner();
  const results = await Promise.allSettled([ledger.append(input(0), signer), ledger.append(input(1), signer)]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.deepEqual(await ledger.verify(), { ok: true, length: 1 });
});

it('keeps concurrent file writes verifiable after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'firmament-concurrency-'));
  try {
    const path = join(directory, 'ledger.jsonl');
    const ledger = new Ledger(new FileStore(path));
    const signer = generateSigner();
    await Promise.all(Array.from({ length: 20 }, (_, n) => ledger.append(input(n), signer)));
    assert.deepEqual(await new Ledger(new FileStore(path)).verify(), { ok: true, length: 20 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
