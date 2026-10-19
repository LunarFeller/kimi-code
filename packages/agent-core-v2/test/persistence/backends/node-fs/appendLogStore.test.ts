import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { AppendLogCorruptedError, IAppendLogStore, type AppendLogTruncation } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService, StorageError, StorageErrors } from '#/persistence/interface/storage';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';

const enc = new TextEncoder();

interface Rec {
  readonly n: number;
}

const SCOPE = 'agents/main';
const KEY = 'wire.jsonl';

function chunkedStorage(chunks: Uint8Array[]): IFileSystemStorageService {
  return {
    _serviceBrand: undefined,
    read: async () => undefined,
    readStream: async function* () {
      for (const c of chunks) yield c;
    },
    write: async () => {},
    writeStream: async () => {},
    append: async () => {},
    list: async () => [],
    delete: async () => {},
    size: async () => undefined,
    mtime: async () => undefined,
    pathFor: () => undefined,
    flush: async () => {},
    close: async () => {},
  };
}

describe('AppendLogStore', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let storage: InMemoryStorageService;
  let record: IAppendLogStore;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    storage = new InMemoryStorageService();
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    record = ix.get(IAppendLogStore);
  });

  afterEach(() => disposables.dispose());

  async function collect<R>(scope: string, key: string): Promise<readonly R[]> {
    const out: R[] = [];
    for await (const r of record.read<R>(scope, key)) {
      out.push(r);
    }
    return out;
  }

  it('reads nothing from an empty log', async () => {
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([]);
  });

  it('append + read round-trips records in order', async () => {
    record.append<Rec>(SCOPE, KEY, { n: 1 });
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    record.append<Rec>(SCOPE, KEY, { n: 3 });
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('batches many appends into a single durable append', async () => {
    const spy = { count: 0 };
    const original = storage.append.bind(storage);
    storage.append = async (...args) => {
      spy.count++;
      return original(...args);
    };

    for (let n = 0; n < 10; n++) record.append<Rec>(SCOPE, KEY, { n });
    await record.flush();

    expect(await collect<Rec>(SCOPE, KEY)).toHaveLength(10);
    expect(spy.count).toBe(1);
  });

  it('later flush reports an ambiguous auto-flush failure without retrying the batch', async () => {
    const failure = new Error('append failed after commit');
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let reportFailure!: (error: unknown) => void;
    const reportedFailure = new Promise<unknown>((resolve) => {
      reportFailure = resolve;
    });
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      markAppendStarted();
      await appendGate;
      await originalAppend(...args);
      throw failure;
    };

    record.append(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
    record.append(SCOPE, KEY, { n: 2 });
    await appendStarted;
    releaseAppend();
    expect(await reportedFailure).toBe(failure);

    await expect(record.flush()).rejects.toBe(failure);
    expect(appendAttempts).toBe(1);
    expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe(
      '{"n":1}\n{"n":2}\n',
    );
  });

  it('reacquire after final release waits for retiring storage before fresh I/O', async () => {
    const failure = new Error('retiring append failed');
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let markReplacementAppendStarted!: () => void;
    const replacementAppendStarted = new Promise<void>((resolve) => {
      markReplacementAppendStarted = resolve;
    });
    let releaseReplacementAppend!: () => void;
    const replacementAppendGate = new Promise<void>((resolve) => {
      releaseReplacementAppend = resolve;
    });
    let reportFailure!: (error: unknown) => void;
    const reportedFailure = new Promise<unknown>((resolve) => {
      reportFailure = resolve;
    });
    let appendAttempts = 0;
    let replacementStarted = false;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      if (appendAttempts === 1) {
        markAppendStarted();
        await appendGate;
        throw failure;
      }
      replacementStarted = true;
      markReplacementAppendStarted();
      await replacementAppendGate;
      return originalAppend(...args);
    };

    const retiringOwner = record.acquire(SCOPE, KEY);
    record.append(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
    await appendStarted;
    retiringOwner.dispose();
    const replacementOwner = record.acquire(SCOPE, KEY);
    record.append(SCOPE, KEY, { n: 2 });
    const orderedFlush = record.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(replacementStarted).toBe(false);

    releaseAppend();
    expect(await reportedFailure).toBe(failure);
    await replacementAppendStarted;

    const currentFlush = record.flush();
    let flushSettled = false;
    void currentFlush.then(() => {
      flushSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(flushSettled).toBe(false);

    releaseReplacementAppend();
    await Promise.all([orderedFlush, currentFlush]);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 2 }]);
    replacementOwner.dispose();
  });

  it('final release retirement is awaited by drainRetirements', async () => {
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      markAppendStarted();
      await appendGate;
      return originalAppend(...args);
    };

    const owner = record.acquire(SCOPE, KEY);
    record.append(SCOPE, KEY, { n: 1 });
    await appendStarted;
    owner.dispose();

    let drained = false;
    const draining = record.drainRetirements().then(() => {
      drained = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseAppend();
    await draining;
    expect(drained).toBe(true);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }]);
  });

  it('keeps a sticky failure until every acquired owner releases it', async () => {
    const failure = new Error('shared append failed');
    let reportFailure!: (error: unknown) => void;
    const reportedFailure = new Promise<unknown>((resolve) => {
      reportFailure = resolve;
    });
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      if (appendAttempts === 1) throw failure;
      return originalAppend(...args);
    };

    const firstOwner = record.acquire(SCOPE, KEY);
    const finalOwner = record.acquire(SCOPE, KEY);
    record.append(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
    expect(await reportedFailure).toBe(failure);

    firstOwner.dispose();
    await expect(record.flush()).rejects.toBe(failure);

    finalOwner.dispose();
    const replacementOwner = record.acquire(SCOPE, KEY);
    record.append(SCOPE, KEY, { n: 2 });
    await record.flush();
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 2 }]);
    replacementOwner.dispose();
  });

  it('rewrite atomically replaces the whole log', async () => {
    record.append<Rec>(SCOPE, KEY, { n: 1 });
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    await record.flush();

    await record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }, { n: 8 }]);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 8 }]);
  });

  it('rewrite preserves an append accepted after the replacement snapshot', async () => {
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const originalWrite = storage.write.bind(storage);
    storage.write = async (...args) => {
      markWriteStarted();
      await writeGate;
      return originalWrite(...args);
    };
    const replacement = [{ n: 9 }];
    record.append<Rec>(SCOPE, KEY, { n: 2 });

    const rewrite = record.rewrite<Rec>(SCOPE, KEY, replacement);
    await writeStarted;
    const flushed = record.flush();
    releaseWrite();
    await flushed;

    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 2 }]);
    await rewrite;
  });

  it('rewrite preserves an append whose old drain is in flight at cutover', async () => {
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseOldAppend!: () => void;
    const oldAppendGate = new Promise<void>((resolve) => {
      releaseOldAppend = resolve;
    });
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      if (appendAttempts === 1) {
        markAppendStarted();
        await oldAppendGate;
      }
      return originalAppend(...args);
    };
    const replacement = [{ n: 9 }];
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    await appendStarted;

    const rewrite = record.rewrite<Rec>(SCOPE, KEY, replacement);
    const flushed = record.flush();
    releaseOldAppend();
    await flushed;
    await rewrite;

    expect(appendAttempts).toBe(2);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 2 }]);
  });

  it('explicit rewrite recovers an in-flight ambiguous append failure', async () => {
    const failure = new Error('append failed after commit');
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      if (appendAttempts === 1) {
        markAppendStarted();
        await appendGate;
        await originalAppend(...args);
        throw failure;
      }
      return originalAppend(...args);
    };
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    await appendStarted;

    const rewrite = record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]);
    const flushed = record.flush();
    releaseAppend();
    await Promise.all([rewrite, flushed]);

    expect(appendAttempts).toBe(2);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 2 }]);
  });

  it('atomic rewrite rejection does not retry an append already written before cutover', async () => {
    const failure = new Error('atomic rewrite rejected');
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      markAppendStarted();
      await appendGate;
      return originalAppend(...args);
    };
    storage.write = async () => {
      throw failure;
    };
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    await appendStarted;

    const rewriteRejected = expect(
      record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]),
    ).rejects.toBe(failure);
    releaseAppend();
    await rewriteRejected;

    await expect(record.flush()).rejects.toBe(failure);
    expect(appendAttempts).toBe(1);
    expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":2}\n');
  });

  it('invalid replacement records do not change append ownership', async () => {
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      markAppendStarted();
      await appendGate;
      return originalAppend(...args);
    };
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    await appendStarted;

    const invalid = expect(
      record.rewrite<unknown>(SCOPE, KEY, [{ n: 9n }]),
    ).rejects.toBeInstanceOf(TypeError);
    releaseAppend();
    await invalid;
    await record.flush();

    expect(appendAttempts).toBe(1);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 2 }]);
  });

  it('successful explicit rewrite recovers sticky failure and drains the tail once', async () => {
    const failure = new Error('atomic rewrite rejected');
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      if (appendAttempts === 1) {
        markAppendStarted();
        await appendGate;
      }
      return originalAppend(...args);
    };
    let writeAttempts = 0;
    const originalWrite = storage.write.bind(storage);
    storage.write = async (...args) => {
      writeAttempts++;
      if (writeAttempts === 1) throw failure;
      return originalWrite(...args);
    };
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    await appendStarted;

    const failedRewrite = expect(
      record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]),
    ).rejects.toBe(failure);
    releaseAppend();
    await failedRewrite;
    await expect(record.flush()).rejects.toBe(failure);
    await expect(collect<Rec>(SCOPE, KEY)).rejects.toBe(failure);
    await expect(record.close()).rejects.toBe(failure);

    await record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]);
    await record.flush();

    expect(writeAttempts).toBe(2);
    expect(appendAttempts).toBe(2);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 2 }]);
  });

  it('close waits for every key before reporting the first sticky failure', async () => {
    const failedScope = 'agents/a';
    const pendingScope = 'agents/b';
    const failure = new Error('first key failed');
    let reportFailure!: (error: unknown) => void;
    const reportedFailure = new Promise<unknown>((resolve) => {
      reportFailure = resolve;
    });
    let markPendingAppendStarted!: () => void;
    const pendingAppendStarted = new Promise<void>((resolve) => {
      markPendingAppendStarted = resolve;
    });
    let releasePendingAppend!: () => void;
    const pendingAppendGate = new Promise<void>((resolve) => {
      releasePendingAppend = resolve;
    });
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      if (args[0] === failedScope) throw failure;
      if (args[0] === pendingScope) {
        markPendingAppendStarted();
        await pendingAppendGate;
      }
      return originalAppend(...args);
    };
    record.append(failedScope, KEY, { n: 1 }, { onError: reportFailure });
    expect(await reportedFailure).toBe(failure);
    record.append(pendingScope, KEY, { n: 2 });
    await pendingAppendStarted;

    const closed = record.close();
    let closeSettled = false;
    void closed.finally(() => {
      closeSettled = true;
    }).catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    releasePendingAppend();
    await expect(closed).rejects.toBe(failure);
    expect(new TextDecoder().decode(await storage.read(pendingScope, KEY))).toBe('{"n":2}\n');
  });

  it('appends that arrive during a rewrite land after the replaced content', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const originalWrite = storage.write.bind(storage);
    storage.write = async (...args) => {
      await writeGate;
      return originalWrite(...args);
    };

    record.append<Rec>(SCOPE, KEY, { n: 1 });
    await record.flush();
    const rewrite = record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]);
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    releaseWrite();
    await rewrite;
    await record.flush();

    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 2 }]);
  });

  it('flush() awaits an in-flight rewrite', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const originalWrite = storage.write.bind(storage);
    storage.write = async (...args) => {
      await writeGate;
      return originalWrite(...args);
    };

    record.append<Rec>(SCOPE, KEY, { n: 1 });
    await record.flush();
    const rewrite = record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]);
    const flushed = record.flush();
    releaseWrite();
    await flushed;
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }]);
    await rewrite;
  });

  it('flush() stays pending until an append made during rewrite is durable', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const originalWrite = storage.write.bind(storage);
    storage.write = async (...args) => {
      await writeGate;
      return originalWrite(...args);
    };
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      markAppendStarted();
      await appendGate;
      return originalAppend(...args);
    };

    const rewrite = record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]);
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    const flushed = record.flush();
    let flushSettled = false;
    void flushed.then(() => {
      flushSettled = true;
    });

    releaseWrite();
    await appendStarted;
    await Promise.resolve();
    await Promise.resolve();
    expect(flushSettled).toBe(false);

    releaseAppend();
    await flushed;
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 2 }]);
    await rewrite;
  });

  it('logs addressed by different scope/key are independent', async () => {
    record.append<Rec>('a', 'l', { n: 1 });
    record.append<Rec>('b', 'l', { n: 2 });
    expect(await collect<Rec>('a', 'l')).toEqual([{ n: 1 }]);
    expect(await collect<Rec>('b', 'l')).toEqual([{ n: 2 }]);
  });

  it('drops a torn final line (crash mid-flush)', async () => {
    const raw = `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 }).slice(0, 4)}`;
    await storage.append(SCOPE, KEY, enc.encode(raw));

    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }]);
  });

  it('throws AppendLogCorruptedError on a corrupted middle line', async () => {
    const raw = `${JSON.stringify({ n: 1 })}\nGARBAGE\n${JSON.stringify({ n: 3 })}\n`;
    await storage.append(SCOPE, KEY, enc.encode(raw));

    await expect(collect<Rec>(SCOPE, KEY)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AppendLogCorruptedError);
      const corrupted = error as AppendLogCorruptedError;
      expect(corrupted.code).toBe('storage.corrupted');
      expect(corrupted.details).toEqual({ scope: SCOPE, key: KEY, lineNumber: 2 });
      expect(corrupted.cause).toBeInstanceOf(SyntaxError);
      return true;
    });
  });

  it('stops at a corrupted middle line and reports it when onTruncate is given', async () => {
    const raw = `${JSON.stringify({ n: 1 })}\nGARBAGE\n${JSON.stringify({ n: 3 })}\n`;
    await storage.append(SCOPE, KEY, enc.encode(raw));
    const truncations: AppendLogTruncation[] = [];

    const out: Rec[] = [];
    for await (const r of record.read<Rec>(SCOPE, KEY, {
      onTruncate: (truncation) => truncations.push(truncation),
    })) {
      out.push(r);
    }

    expect(out).toEqual([{ n: 1 }]);
    expect(truncations).toHaveLength(1);
    expect(truncations[0]).toMatchObject({ lineNumber: 2, reason: 'corrupted' });
    expect(truncations[0]!.cause).toBeInstanceOf(AppendLogCorruptedError);
  });

  it('reports a torn final line as truncation when onTruncate is given', async () => {
    const raw = `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 }).slice(0, 4)}`;
    await storage.append(SCOPE, KEY, enc.encode(raw));
    const truncations: AppendLogTruncation[] = [];

    const out: Rec[] = [];
    for await (const r of record.read<Rec>(SCOPE, KEY, {
      onTruncate: (truncation) => truncations.push(truncation),
    })) {
      out.push(r);
    }

    expect(out).toEqual([{ n: 1 }]);
    expect(truncations).toEqual([{ lineNumber: 2, reason: 'truncated' }]);
  });

  it('does not report truncation for a clean log when onTruncate is given', async () => {
    const raw = `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n`;
    await storage.append(SCOPE, KEY, enc.encode(raw));
    const truncations: AppendLogTruncation[] = [];

    const out: Rec[] = [];
    for await (const r of record.read<Rec>(SCOPE, KEY, {
      onTruncate: (truncation) => truncations.push(truncation),
    })) {
      out.push(r);
    }

    expect(out).toEqual([{ n: 1 }, { n: 2 }]);
    expect(truncations).toEqual([]);
  });

  it('reads across chunk boundaries (stream read splits lines)', async () => {
    const full = `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n${JSON.stringify({ n: 3 })}\n`;
    const bytes = enc.encode(full);
    const chunks = [bytes.slice(0, 7), bytes.slice(7, 23), bytes.slice(23)];
    const localIx = disposables.add(new TestInstantiationService());
    localIx.stub(IFileSystemStorageService, chunkedStorage(chunks));
    localIx.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log = localIx.get(IAppendLogStore);

    const out: Rec[] = [];
    for await (const r of log.read<Rec>(SCOPE, KEY)) out.push(r);
    expect(out).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('does not leak decoder state into a later read when an earlier read returns early', async () => {
    const line1 = `${JSON.stringify({ type: 'metadata', protocol_version: '1.4' })}\n`;
    const line2 = `${JSON.stringify({ type: 'context.append_message', s: '中文中文中文' })}\n`;
    const bytes = enc.encode(line1 + line2);
    const cut = bytes.indexOf(enc.encode('中')[0]!) + 1;
    const chunks = [bytes.slice(0, cut), bytes.slice(cut)];
    const localIx = disposables.add(new TestInstantiationService());
    localIx.stub(IFileSystemStorageService, chunkedStorage(chunks));
    localIx.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log = localIx.get(IAppendLogStore);

    const first: Array<{ type: string }> = [];
    for await (const r of log.read<{ type: string }>(SCOPE, KEY)) {
      first.push(r);
      break;
    }
    expect(first).toEqual([{ type: 'metadata', protocol_version: '1.4' }]);

    const out: Array<{ type: string; s?: string }> = [];
    for await (const r of log.read<{ type: string; s?: string }>(SCOPE, KEY)) out.push(r);
    expect(out).toEqual([
      { type: 'metadata', protocol_version: '1.4' },
      { type: 'context.append_message', s: '中文中文中文' },
    ]);
  });

  it('isolates decoder state between concurrent reads', async () => {
    const content = `${JSON.stringify({ s: '中文日本語' })}\n`;
    const bytes = enc.encode(content);
    const chunks = Array.from(bytes, (b) => new Uint8Array([b]));
    const localIx = disposables.add(new TestInstantiationService());
    localIx.stub(IFileSystemStorageService, chunkedStorage(chunks));
    localIx.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log = localIx.get(IAppendLogStore);

    const readAll = async (): Promise<Array<{ s: string }>> => {
      const out: Array<{ s: string }> = [];
      for await (const r of log.read<{ s: string }>(SCOPE, KEY)) out.push(r);
      return out;
    };
    const [a, b] = await Promise.all([readAll(), readAll()]);
    expect(a).toEqual([{ s: '中文日本語' }]);
    expect(b).toEqual([{ s: '中文日本語' }]);
  });

  it('reads across chunk boundaries with multi-byte UTF-8 split', async () => {
    const full = `${JSON.stringify({ n: 1, s: '中文' })}\n${JSON.stringify({ n: 2, s: '日本語' })}\n`;
    const bytes = enc.encode(full);
    const chunks = Array.from(bytes, (b) => new Uint8Array([b]));
    const localIx = disposables.add(new TestInstantiationService());
    localIx.stub(IFileSystemStorageService, chunkedStorage(chunks));
    localIx.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log = localIx.get(IAppendLogStore);

    const out: Array<Rec & { s?: string }> = [];
    for await (const r of log.read<Rec & { s?: string }>(SCOPE, KEY)) out.push(r);
    expect(out).toEqual([
      { n: 1, s: '中文' },
      { n: 2, s: '日本語' },
    ]);
  });

  it('does not emit onDidWrite when a flush persists nothing', async () => {
    const events: string[] = [];
    record.onDidWrite((write) => events.push(`${write.scope}/${write.key}`));

    record.append<Rec>(SCOPE, KEY, { n: 1 });
    await record.flush();
    expect(events).toEqual([`${SCOPE}/${KEY}`]);

    await record.flush();
    await record.flush();
    expect(events).toEqual([`${SCOPE}/${KEY}`]);
  });

  it('emits onDidWrite for batches persisted before a later drain failure', async () => {
    const events: string[] = [];
    record.onDidWrite((write) => events.push(`${write.scope}/${write.key}`));
    const original = storage.append.bind(storage);
    let calls = 0;
    storage.append = async (scope, key, data, options) => {
      calls += 1;
      if (calls > 1) throw new Error('disk full');
      const result = await original(scope, key, data, options);
      record.append<Rec>(scope, key, { n: 2 });
      return result;
    };

    record.append<Rec>(SCOPE, KEY, { n: 1 });
    await expect(record.flush()).rejects.toThrow('disk full');
    expect(events).toEqual([`${SCOPE}/${KEY}`]);
  });

  describe('disk-full recovery', () => {
    const diskFull = (): StorageError =>
      new StorageError(
        StorageErrors.codes.STORAGE_DISK_FULL,
        'storage append failed: no space left on device',
        { details: { errno: 'ENOSPC' } },
      );

    const settle = async (): Promise<void> => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function watchRecovery(): Promise<void> {
      return new Promise<void>((resolve) => {
        const subscription = record.onDidRecover((write) => {
          if (write.scope === SCOPE && write.key === KEY) {
            subscription.dispose();
            resolve();
          }
        });
      });
    }

    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((settle) => {
        resolve = settle;
      });
      return { promise, resolve };
    }

    it('retries a disk-full append after a backoff and persists buffered records exactly once', async () => {
      const failure = diskFull();
      let attempts = 0;
      const originalAppend = storage.append.bind(storage);
      storage.append = async (...args) => {
        attempts++;
        if (attempts === 1) throw failure;
        return originalAppend(...args);
      };
      let failures = 0;
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });
      const recovered = watchRecovery();

      record.append<Rec>(SCOPE, KEY, { n: 1 }, {
        onError: () => {
          failures++;
          reportFailure();
        },
      });
      await reportedFailure;

      await expect(record.flush()).rejects.toBe(failure);
      expect(attempts).toBe(1);

      record.append<Rec>(SCOPE, KEY, { n: 2 });
      await settle();
      expect(failures).toBe(1);

      await vi.advanceTimersByTimeAsync(1000);
      await recovered;
      await record.flush();

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
      expect(attempts).toBe(2);
      expect(failures).toBe(1);
      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":1}\n{"n":2}\n');
    });

    it('repairs a torn tail from a partially committed batch before retrying', async () => {
      const failure = diskFull();
      let attempts = 0;
      const originalAppend = storage.append.bind(storage);
      storage.append = async (scope, key, data, options) => {
        attempts++;
        if (attempts === 1) {
          await originalAppend(scope, key, data.subarray(0, 9), options);
          throw failure;
        }
        return originalAppend(scope, key, data, options);
      };
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });
      const recovered = watchRecovery();

      record.append<Rec>(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
      record.append<Rec>(SCOPE, KEY, { n: 2 });
      await reportedFailure;

      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":1}\n{');

      await vi.advanceTimersByTimeAsync(1000);
      await recovered;
      await record.flush();

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":1}\n{"n":2}\n');
      expect(attempts).toBe(2);
    });

    it('drops an ambiguously committed batch instead of duplicating it', async () => {
      const failure = diskFull();
      let attempts = 0;
      const appends: { data: Uint8Array; durable?: boolean }[] = [];
      const originalAppend = storage.append.bind(storage);
      storage.append = async (scope, key, data, options) => {
        attempts++;
        appends.push({ data: data.slice(), durable: options?.durable });
        if (attempts === 1) {
          await originalAppend(scope, key, data, options);
          throw failure;
        }
        return originalAppend(scope, key, data, options);
      };
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });
      const recovered = watchRecovery();

      record.append<Rec>(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
      record.append<Rec>(SCOPE, KEY, { n: 2 });
      await reportedFailure;

      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":1}\n{"n":2}\n');

      await vi.advanceTimersByTimeAsync(1000);
      await recovered;
      await record.flush();

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
      expect(attempts).toBe(2);
      expect(appends.at(-1)).toEqual({ data: new Uint8Array(), durable: true });
    });

    it.each(['retirement', 'close'] as const)(
      '%s recovers an append that fails after shutdown starts',
      async (shutdown) => {
        const failure = diskFull();
        const started = deferred<void>();
        const gate = deferred<void>();
        const reported = deferred<unknown>();
        let attempts = 0;
        const originalAppend = storage.append.bind(storage);
        storage.append = async (...args) => {
          attempts++;
          if (attempts === 1) {
            started.resolve();
            await gate.promise;
            throw failure;
          }
          return originalAppend(...args);
        };

        const owner = record.acquire(SCOPE, KEY);
        record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
        record.append(SCOPE, KEY, { n: 2 });
        await started.promise;
        let finishing: Promise<unknown>;
        if (shutdown === 'close') {
          finishing = record.close().then(() => undefined, (error: unknown) => error);
        } else {
          owner.dispose();
          finishing = record.drainRetirements();
        }
        gate.resolve();
        expect(await reported.promise).toBe(failure);
        expect(await finishing).toBeUndefined();

        expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
        expect(attempts).toBe(2);
        owner.dispose();
        await record.drainRetirements();
      },
    );

    it.each(['retirement', 'close'] as const)(
      '%s recovers records accepted before the first flush microtask starts',
      async (shutdown) => {
        const failure = diskFull();
        const originalAppend = storage.append.bind(storage);
        let attempts = 0;
        storage.append = async (...args) => {
          attempts++;
          if (attempts === 1) throw failure;
          return originalAppend(...args);
        };
        const owner = record.acquire(SCOPE, KEY);
        record.append(SCOPE, KEY, { n: 1 });
        record.append(SCOPE, KEY, { n: 2 });
        if (shutdown === 'close') {
          await record.close();
        } else {
          owner.dispose();
          await record.drainRetirements();
        }

        expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
        expect(attempts).toBe(2);
        owner.dispose();
        await record.drainRetirements();
      },
    );

    it('close waits for a key first appended while another key is recovering', async () => {
      const failure = diskFull();
      const reported = deferred<unknown>();
      const recoveryStarted = deferred<void>();
      const recoveryGate = deferred<void>();
      const otherStarted = deferred<void>();
      const otherGate = deferred<void>();
      const otherKey = 'other.jsonl';
      const originalAppend = storage.append.bind(storage);
      let attempts = 0;
      storage.append = async (scope, key, data, options) => {
        if (key === KEY) {
          attempts++;
          if (attempts === 1) throw failure;
          recoveryStarted.resolve();
          await recoveryGate.promise;
        } else if (key === otherKey) {
          otherStarted.resolve();
          await otherGate.promise;
        }
        return originalAppend(scope, key, data, options);
      };

      record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
      expect(await reported.promise).toBe(failure);
      let closed = false;
      const closing = record.close().then(() => {
        closed = true;
      });
      await recoveryStarted.promise;
      record.append(SCOPE, otherKey, { n: 2 });
      await otherStarted.promise;
      recoveryGate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      try {
        expect(closed).toBe(false);
        expect(await storage.size(SCOPE, otherKey)).toBeUndefined();
      } finally {
        otherGate.resolve();
        await closing;
      }

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }]);
      expect(await collect<Rec>(SCOPE, otherKey)).toEqual([{ n: 2 }]);
    });

    it('completes a partial append using only its missing suffix', async () => {
      const seed = enc.encode('{"n":0}\n');
      await storage.append(SCOPE, KEY, seed);
      const failure = diskFull();
      const reported = deferred<unknown>();
      const originalRead = storage.read.bind(storage);
      const reads = vi.spyOn(storage, 'read');
      const writes = vi.spyOn(storage, 'write');
      const originalAppend = storage.append.bind(storage);
      const appended: Uint8Array[] = [];
      storage.append = async (scope, key, data, options) => {
        appended.push(data.slice());
        if (appended.length === 1) {
          await originalAppend(scope, key, data.subarray(0, 9), options);
          throw failure;
        }
        return originalAppend(scope, key, data, options);
      };

      record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
      record.append(SCOPE, KEY, { n: 2 });
      expect(await reported.promise).toBe(failure);
      await vi.advanceTimersByTimeAsync(1000);
      await record.flush();

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }]);
      expect(new TextDecoder().decode(await originalRead(SCOPE, KEY))).toBe(
        '{"n":0}\n{"n":1}\n{"n":2}\n',
      );
      expect(reads).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
      expect(appended).toEqual([
        enc.encode('{"n":1}\n{"n":2}\n'),
        enc.encode('{"n":1}\n{"n":2}\n').subarray(9),
      ]);
    });

    it('retains the original recovery boundary across repeated partial UTF-8 writes', async () => {
      const seed = enc.encode('{"n":0}\n');
      await storage.append(SCOPE, KEY, seed);
      const records = [{ n: 1, text: '中文🙂' }, { n: 2, text: '界' }];
      const batch = enc.encode(records.map((entry) => JSON.stringify(entry) + '\n').join(''));
      const firstCut = enc.encode('{"n":1,"text":"').byteLength + 1;
      const secondCut = 4;
      const failure = diskFull();
      const reported = deferred<unknown>();
      const originalRead = storage.read.bind(storage);
      const reads = vi.spyOn(storage, 'read');
      const writes = vi.spyOn(storage, 'write');
      const originalAppend = storage.append.bind(storage);
      const appended: Uint8Array[] = [];
      storage.append = async (scope, key, data, options) => {
        appended.push(data.slice());
        if (appended.length <= 2) {
          const cut = appended.length === 1 ? firstCut : secondCut;
          await originalAppend(scope, key, data.subarray(0, cut), options);
          throw failure;
        }
        return originalAppend(scope, key, data, options);
      };

      for (const entry of records) {
        record.append(SCOPE, KEY, entry, { onError: reported.resolve });
      }
      expect(await reported.promise).toBe(failure);
      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      expect(await originalRead(SCOPE, KEY)).toEqual(
        new Uint8Array([...seed, ...batch.subarray(0, firstCut + secondCut)]),
      );
      await vi.advanceTimersByTimeAsync(2000);
      await record.flush();

      expect(await collect(SCOPE, KEY)).toEqual([{ n: 0 }, ...records]);
      expect(appended).toEqual([
        batch,
        batch.subarray(firstCut),
        batch.subarray(firstCut + secondCut),
      ]);
      expect(reads).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
    });

    it('retries durability after a fully committed batch until the empty append succeeds', async () => {
      const failure = diskFull();
      const reported = deferred<unknown>();
      const originalAppend = storage.append.bind(storage);
      const appends: { data: Uint8Array; durable?: boolean }[] = [];
      storage.append = async (scope, key, data, options) => {
        appends.push({ data: data.slice(), durable: options?.durable });
        if (appends.length === 1) {
          await originalAppend(scope, key, data, options);
          throw failure;
        }
        if (appends.length === 2) throw failure;
        return originalAppend(scope, key, data, options);
      };
      let recoveries = 0;
      disposables.add(record.onDidRecover(() => {
        recoveries++;
      }));

      record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
      record.append(SCOPE, KEY, { n: 2 });
      expect(await reported.promise).toBe(failure);
      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      expect(recoveries).toBe(0);
      await expect(record.flush()).rejects.toBe(failure);
      await vi.advanceTimersByTimeAsync(2000);
      await record.flush();

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
      expect(recoveries).toBe(1);
      expect(appends).toEqual([
        { data: enc.encode('{"n":1}\n{"n":2}\n'), durable: true },
        { data: new Uint8Array(), durable: true },
        { data: new Uint8Array(), durable: true },
      ]);
    });

    it.each([
      { phase: 'tail read', retire: false, recoveryFails: false },
      { phase: 'tail read', retire: true, recoveryFails: false },
      { phase: 'suffix append', retire: false, recoveryFails: false },
      { phase: 'suffix append', retire: true, recoveryFails: false },
      { phase: 'suffix append', retire: false, recoveryFails: true },
      { phase: 'suffix append', retire: true, recoveryFails: true },
    ])(
      'rewrite during $phase preserves accepted records with retirement=$retire and recovery failure=$recoveryFails',
      async ({ phase, retire, recoveryFails }) => {
        await storage.append(SCOPE, KEY, enc.encode('{"n":0}\n'));
        const failure = diskFull();
        const reported = deferred<unknown>();
        const recoveryStarted = deferred<void>();
        const gate = deferred<void>();
        const originalAppend = storage.append.bind(storage);
        let attempts = 0;
        storage.append = async (scope, key, data, options) => {
          attempts++;
          if (attempts === 1) {
            const length = phase === 'tail read' ? data.byteLength : 9;
            await originalAppend(scope, key, data.subarray(0, length), options);
            throw failure;
          }
          if (attempts === 2 && phase === 'suffix append') {
            recoveryStarted.resolve();
            await gate.promise;
            if (recoveryFails) {
              await originalAppend(scope, key, data.subarray(0, 2), options);
              throw failure;
            }
          }
          return originalAppend(scope, key, data, options);
        };
        const originalReadStream = storage.readStream.bind(storage);
        let readBlocked = false;
        storage.readStream = async function* (scope, key, range) {
          if (phase === 'tail read' && range !== undefined && !readBlocked) {
            readBlocked = true;
            recoveryStarted.resolve();
            await gate.promise;
          }
          yield* originalReadStream(scope, key, range);
        };

        const owner = record.acquire(SCOPE, KEY);
        record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
        record.append(SCOPE, KEY, { n: 2 });
        expect(await reported.promise).toBe(failure);
        await vi.advanceTimersByTimeAsync(1000);
        await recoveryStarted.promise;

        const rewriting = record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]);
        record.append(SCOPE, KEY, { n: 3 });
        if (retire) owner.dispose();
        gate.resolve();
        await rewriting;
        if (retire) await record.drainRetirements();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(await collect<Rec>(SCOPE, KEY)).toEqual([
          { n: 9 }, { n: 1 }, { n: 2 }, { n: 3 },
        ]);
        expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe(
          '{"n":9}\n{"n":1}\n{"n":2}\n{"n":3}\n',
        );
        owner.dispose();
        await record.drainRetirements();
      },
    );

    it.each(['tail read', 'suffix append', 'partial suffix failure'] as const)(
      'close and retirement wait for a running recovery during %s',
      async (phase) => {
        const failure = diskFull();
        const reported = deferred<unknown>();
        const recoveryStarted = deferred<void>();
        const gate = deferred<void>();
        let attempts = 0;
        const originalAppend = storage.append.bind(storage);
        storage.append = async (scope, key, data, options) => {
          attempts++;
          if (attempts === 1) {
            const length = phase === 'tail read' ? data.byteLength : 9;
            await originalAppend(scope, key, data.subarray(0, length), options);
            throw failure;
          }
          if (attempts === 2 && phase !== 'tail read') {
            recoveryStarted.resolve();
            await gate.promise;
            if (phase === 'partial suffix failure') {
              await originalAppend(scope, key, data.subarray(0, 2), options);
              throw failure;
            }
          }
          return originalAppend(scope, key, data, options);
        };
        const originalReadStream = storage.readStream.bind(storage);
        let blocked = false;
        storage.readStream = async function* (scope, key, range) {
          if (phase === 'tail read' && range !== undefined && !blocked) {
            blocked = true;
            recoveryStarted.resolve();
            await gate.promise;
          }
          yield* originalReadStream(scope, key, range);
        };

        const owner = record.acquire(SCOPE, KEY);
        record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
        record.append(SCOPE, KEY, { n: 2 });
        expect(await reported.promise).toBe(failure);
        await vi.advanceTimersByTimeAsync(1000);
        await recoveryStarted.promise;
        const closing = record.close();
        owner.dispose();
        let drained = false;
        const retiring = record.drainRetirements().then(() => {
          drained = true;
        });
        await settle();
        expect(drained).toBe(false);
        gate.resolve();
        await Promise.all([closing, retiring]);

        expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
        expect(attempts).toBe(phase === 'partial suffix failure' ? 3 : 2);
      },
    );

    it.each(['retirement', 'close'] as const)(
      '%s makes only one final attempt when the disk remains full',
      async (shutdown) => {
        const failure = diskFull();
        const started = deferred<void>();
        const gate = deferred<void>();
        const reported = deferred<unknown>();
        let attempts = 0;
        storage.append = async () => {
          attempts++;
          if (attempts === 1) {
            started.resolve();
            await gate.promise;
          }
          throw failure;
        };
        const owner = record.acquire(SCOPE, KEY);
        record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
        await started.promise;
        let finishing: Promise<unknown>;
        if (shutdown === 'close') {
          finishing = record.close().then(() => undefined, (error: unknown) => error);
        } else {
          owner.dispose();
          finishing = record.drainRetirements();
        }
        gate.resolve();
        expect(await reported.promise).toBe(failure);
        expect(await finishing).toBe(shutdown === 'close' ? failure : undefined);
        expect(attempts).toBe(2);
        expect(await storage.size(SCOPE, KEY)).toBeUndefined();
        owner.dispose();
        await record.drainRetirements();
      },
    );

    it('stays sticky when the torn tail does not match the failed batch', async () => {
      const failure = diskFull();
      await storage.append(SCOPE, KEY, enc.encode('{"n":0}\n{"n":99'));
      let attempts = 0;
      const originalAppend = storage.append.bind(storage);
      storage.append = async (...args) => {
        attempts++;
        if (attempts === 1) throw failure;
        return originalAppend(...args);
      };
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });

      record.append<Rec>(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
      await reportedFailure;

      await vi.advanceTimersByTimeAsync(5000);
      await settle();
      expect(attempts).toBe(1);
      await expect(record.flush()).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });
      await expect(collect<Rec>(SCOPE, KEY)).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });

      await record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]);
      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 1 }]);
    });

    it('re-enters backoff with a growing delay when the recovery attempt itself hits disk-full', async () => {
      const failure = diskFull();
      let attempts = 0;
      const originalAppend = storage.append.bind(storage);
      storage.append = async (...args) => {
        attempts++;
        if (attempts <= 2) throw failure;
        return originalAppend(...args);
      };
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });
      const recovered = watchRecovery();

      record.append<Rec>(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
      await reportedFailure;

      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      expect(attempts).toBe(2);

      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      expect(attempts).toBe(2);

      await vi.advanceTimersByTimeAsync(1000);
      await recovered;
      await record.flush();

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }]);
      expect(attempts).toBe(3);
    });

    it('close() makes a final recovery attempt and persists buffered records', async () => {
      const failure = diskFull();
      let attempts = 0;
      const originalAppend = storage.append.bind(storage);
      storage.append = async (...args) => {
        attempts++;
        if (attempts === 1) throw failure;
        return originalAppend(...args);
      };
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });

      record.append<Rec>(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
      record.append<Rec>(SCOPE, KEY, { n: 2 });
      await reportedFailure;

      await record.close();

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
      expect(attempts).toBe(2);
    });

    it('does not enter recovery for non-retryable storage errors', async () => {
      const failure = new StorageError(
        StorageErrors.codes.STORAGE_PERMISSION_DENIED,
        'storage append failed: permission denied',
      );
      let attempts = 0;
      const originalAppend = storage.append.bind(storage);
      storage.append = async (...args) => {
        attempts++;
        if (attempts === 1) throw failure;
        return originalAppend(...args);
      };
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });

      record.append<Rec>(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
      await reportedFailure;

      await vi.advanceTimersByTimeAsync(5000);
      await settle();
      expect(attempts).toBe(1);
      await expect(record.flush()).rejects.toBe(failure);
    });

    it('also recovers transient io failures, not only disk-full', async () => {
      const failure = new StorageError(
        StorageErrors.codes.STORAGE_IO_FAILED,
        'storage append failed: unrecognized I/O error',
      );
      let attempts = 0;
      const originalAppend = storage.append.bind(storage);
      storage.append = async (...args) => {
        attempts++;
        if (attempts === 1) throw failure;
        return originalAppend(...args);
      };
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });
      const recovered = watchRecovery();

      record.append<Rec>(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
      await reportedFailure;

      await vi.advanceTimersByTimeAsync(1000);
      await recovered;
      await record.flush();

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }]);
      expect(attempts).toBe(2);
    });

    it('retirement performs a final recovery attempt before dropping the log', async () => {
      const failure = diskFull();
      let attempts = 0;
      const originalAppend = storage.append.bind(storage);
      storage.append = async (...args) => {
        attempts++;
        if (attempts === 1) throw failure;
        return originalAppend(...args);
      };
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });

      const owner = record.acquire(SCOPE, KEY);
      record.append<Rec>(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
      await reportedFailure;

      owner.dispose();
      await record.drainRetirements();

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }]);
      expect(attempts).toBe(2);
    });

    it('rewrite cancels a pending recovery and keeps the buffered records', async () => {
      const failure = diskFull();
      let attempts = 0;
      const originalAppend = storage.append.bind(storage);
      storage.append = async (...args) => {
        attempts++;
        if (attempts === 1) throw failure;
        return originalAppend(...args);
      };
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });

      record.append<Rec>(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
      await reportedFailure;
      expect(attempts).toBe(1);

      await record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]);
      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 1 }]);

      await vi.advanceTimersByTimeAsync(60_000);
      await settle();
      expect(attempts).toBe(2);
    });

    it('keeps a failed rewrite sticky until the caller explicitly retries it', async () => {
      const failure = diskFull();
      record.append<Rec>(SCOPE, KEY, { n: 1 });
      await record.flush();

      let writeAttempts = 0;
      const originalWrite = storage.write.bind(storage);
      storage.write = async (...args) => {
        writeAttempts++;
        if (writeAttempts === 1) throw failure;
        return originalWrite(...args);
      };
      const recovered = vi.fn();
      disposables.add(record.onDidRecover(recovered));

      await expect(record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }])).rejects.toBe(failure);
      await expect(record.flush()).rejects.toBe(failure);

      await vi.advanceTimersByTimeAsync(60_000);
      record.append<Rec>(SCOPE, KEY, { n: 2 });
      await expect(record.close()).rejects.toBe(failure);
      expect(recovered).not.toHaveBeenCalled();
      expect(writeAttempts).toBe(1);
      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":1}\n');

      await record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]);
      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 2 }]);
    });

    it.each([
      { committed: 0, appendInFlight: false },
      { committed: 9, appendInFlight: false },
      { committed: 0, appendInFlight: true },
      { committed: 9, appendInFlight: true },
    ])(
      'failed rewrite stays sticky after $committed bytes committed with append in flight=$appendInFlight',
      async ({ committed, appendInFlight }) => {
        await storage.append(SCOPE, KEY, enc.encode('{"n":1}\n'));
        const failure = diskFull();
        const reported = deferred<unknown>();
        const started = deferred<void>();
        const gate = deferred<void>();
        const originalAppend = storage.append.bind(storage);
        let appendAttempts = 0;
        storage.append = async (scope, key, data, options) => {
          appendAttempts++;
          if (appendAttempts === 1) {
            started.resolve();
            await gate.promise;
            await originalAppend(scope, key, data.subarray(0, committed), options);
            throw failure;
          }
          return originalAppend(scope, key, data, options);
        };
        const originalWrite = storage.write.bind(storage);
        let writeAttempts = 0;
        storage.write = async (...args) => {
          writeAttempts++;
          if (writeAttempts === 1) throw failure;
          return originalWrite(...args);
        };
        const recovered = vi.fn();
        disposables.add(record.onDidRecover(recovered));

        record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
        record.append(SCOPE, KEY, { n: 2 });
        await started.promise;
        const rewriting = appendInFlight
          ? expect(record.rewrite(SCOPE, KEY, [{ n: 9 }])).rejects.toBe(failure)
          : undefined;
        gate.resolve();
        expect(await reported.promise).toBe(failure);
        if (rewriting === undefined) {
          await expect(record.rewrite(SCOPE, KEY, [{ n: 9 }])).rejects.toBe(failure);
        } else {
          await rewriting;
        }
        await vi.advanceTimersByTimeAsync(60_000);
        await expect(record.close()).rejects.toBe(failure);
        expect(recovered).not.toHaveBeenCalled();
        expect(appendAttempts).toBe(1);

        await record.rewrite(SCOPE, KEY, [{ n: 9 }]);
        expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 1 }, { n: 2 }]);
        expect(appendAttempts).toBe(2);
      },
    );

    it('retries transient boundary-stat failures before attempting any append', async () => {
      const failure = new StorageError(StorageErrors.codes.STORAGE_IO_FAILED, 'transient stat failure');
      const originalSize = storage.size.bind(storage);
      let sizeAttempts = 0;
      storage.size = async (...args) => {
        sizeAttempts++;
        if (sizeAttempts <= 2) throw failure;
        return originalSize(...args);
      };
      const appended = vi.spyOn(storage, 'append');
      const reported = deferred<unknown>();
      const recovered = vi.fn();
      disposables.add(record.onDidRecover(recovered));

      record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
      record.append(SCOPE, KEY, { n: 2 });
      expect(await reported.promise).toBe(failure);
      expect(appended).not.toHaveBeenCalled();
      await expect(record.flush()).rejects.toBe(failure);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sizeAttempts).toBe(2);
      expect(appended).not.toHaveBeenCalled();
      expect(recovered).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2000);
      await record.flush();

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
      expect(appended).toHaveBeenCalledTimes(1);
      expect(recovered).toHaveBeenCalledTimes(1);
    });

    it('becomes sticky when a recovery attempt hits a non-retryable error', async () => {
      const permanent = new StorageError(
        StorageErrors.codes.STORAGE_PERMISSION_DENIED,
        'storage append failed: permission denied',
      );
      const failure = diskFull();
      let attempts = 0;
      const originalAppend = storage.append.bind(storage);
      storage.append = async (...args) => {
        attempts++;
        if (attempts === 1) throw failure;
        if (attempts === 2) throw permanent;
        return originalAppend(...args);
      };
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });

      record.append<Rec>(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
      await reportedFailure;

      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      await vi.advanceTimersByTimeAsync(60_000);
      await settle();

      expect(attempts).toBe(2);
      await expect(record.flush()).rejects.toBe(permanent);
    });

    it('does not confuse pre-existing identical content with a committed batch', async () => {
      const failure = diskFull();
      record.append<Rec>(SCOPE, KEY, { n: 1 });
      await record.flush();

      let attempts = 0;
      const originalAppend = storage.append.bind(storage);
      storage.append = async (...args) => {
        attempts++;
        if (attempts === 1) throw failure;
        return originalAppend(...args);
      };
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });
      const recovered = watchRecovery();

      record.append<Rec>(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
      await reportedFailure;

      await vi.advanceTimersByTimeAsync(1000);
      await recovered;
      await record.flush();

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 1 }]);
      expect(attempts).toBe(2);
    });
  });
});
