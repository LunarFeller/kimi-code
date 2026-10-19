import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type EventEnvelope,
  SessionEventJournal,
} from '../src/transport/ws/v1/sessionEventJournal';

const fsMock = vi.hoisted(() => ({
  appendFailures: 0,
  appendPrefixLines: 0,
  appendPrefixBytes: 0,
  appendPrefixes: [] as number[],
  appendCalls: 0,
  appendGate: undefined as Promise<void> | undefined,
  appendStarted: undefined as (() => void) | undefined,
}));

vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  const enospc = (): NodeJS.ErrnoException => {
    const error = new Error('ENOSPC: no space left on device, write') as NodeJS.ErrnoException;
    error.code = 'ENOSPC';
    return error;
  };
  return {
    ...actual,
    appendFile: async (...args: Parameters<typeof actual.appendFile>) => {
      fsMock.appendCalls++;
      if (fsMock.appendGate !== undefined) {
        const gate = fsMock.appendGate;
        fsMock.appendGate = undefined;
        fsMock.appendStarted?.();
        await gate;
      }
      const prefixBytes = fsMock.appendPrefixes.shift() ?? fsMock.appendPrefixBytes;
      if (prefixBytes > 0) {
        fsMock.appendPrefixBytes = 0;
        await actual.appendFile(args[0], Buffer.from(String(args[1]), 'utf8').subarray(0, prefixBytes));
        throw enospc();
      }
      if (fsMock.appendPrefixLines > 0) {
        const count = fsMock.appendPrefixLines;
        fsMock.appendPrefixLines = 0;
        const prefix =
          String(args[1])
            .split('\n')
            .slice(0, count)
            .join('\n') + '\n';
        await actual.appendFile(args[0], prefix, args[2]);
        throw enospc();
      }
      if (fsMock.appendFailures > 0) {
        fsMock.appendFailures--;
        throw enospc();
      }
      return actual.appendFile(...args);
    },
  };
});

function envelope(seq: number): EventEnvelope {
  return {
    type: 'turn.started',
    seq,
    timestamp: new Date().toISOString(),
    payload: { seq },
  };
}

describe('SessionEventJournal', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    fsMock.appendFailures = 0;
    fsMock.appendPrefixLines = 0;
    fsMock.appendPrefixBytes = 0;
    fsMock.appendPrefixes = [];
    fsMock.appendCalls = 0;
    fsMock.appendGate = undefined;
    fsMock.appendStarted = undefined;
    dir = await mkdtemp(join(tmpdir(), 'kimi-journal-test-'));
    filePath = join(dir, 'sess_1.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('assigns monotonic seq and reads back in order', async () => {
    const j = await SessionEventJournal.open(filePath);
    expect(j.epoch).toMatch(/^ep_/);
    expect(j.seq).toBe(0);

    j.append(j.nextSeq(), envelope(1));
    j.append(j.nextSeq(), envelope(2));
    j.append(j.nextSeq(), envelope(3));
    expect(j.seq).toBe(3);

    const all = await j.readSince(0, 100);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    await j.close();
  });

  it('recovers seq and epoch across reopen', async () => {
    const j1 = await SessionEventJournal.open(filePath);
    const epoch = j1.epoch;
    j1.append(j1.nextSeq(), envelope(1));
    j1.append(j1.nextSeq(), envelope(2));
    await j1.close();

    j1.append(j1.nextSeq(), envelope(3));
    await j1.flush();

    const j2 = await SessionEventJournal.open(filePath);
    expect(j2.epoch).toBe(epoch);
    expect(j2.seq).toBe(2);
    expect(j2.nextSeq()).toBe(3);
    await j2.close();
  });

  it('rotates to a fresh epoch when the header is corrupt', async () => {
    const j1 = await SessionEventJournal.open(filePath);
    const epoch = j1.epoch;
    j1.append(j1.nextSeq(), envelope(1));
    await j1.close();

    await writeFile(filePath, 'this is not json\n', 'utf8');

    const j2 = await SessionEventJournal.open(filePath);
    expect(j2.epoch).toMatch(/^ep_/);
    expect(j2.epoch).not.toBe(epoch);
    expect(j2.seq).toBe(0);
    await j2.close();
  });

  it('readSince honors the exclusive lower bound and the limit', async () => {
    const j = await SessionEventJournal.open(filePath);
    for (let i = 1; i <= 5; i++) j.append(j.nextSeq(), envelope(i));

    const page = await j.readSince(2, 2);
    expect(page.map((e) => e.seq)).toEqual([3, 4]);
    await j.close();
  });

  it('readSince on a missing file returns empty', async () => {
    const j = await SessionEventJournal.open(filePath);
    const out = await j.readSince(0, 100);
    expect(out).toEqual([]);
    await j.close();
  });

  it('flushes appends that arrive while a flush is in flight', async () => {
    const j = await SessionEventJournal.open(filePath);
    for (let i = 1; i <= 12; i++) j.append(j.nextSeq(), envelope(i));
    const deadline = Date.now() + 2000;
    let lines = 0;
    while (Date.now() < deadline) {
      try {
        lines = (await readFile(filePath, 'utf8')).trim().split('\n').length;
      } catch {
        lines = 0;
      }
      if (lines >= 13) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(lines).toBe(13);
    await j.close();
  });

  it('keeps buffered lines after a write failure and retries with backoff', async () => {
    const j = await SessionEventJournal.open(filePath);
    fsMock.appendFailures = 2;
    try {
      j.append(j.nextSeq(), envelope(1));
      j.append(j.nextSeq(), envelope(2));

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await readFile(filePath, 'utf8').catch(() => '')).toBe('');

      const deadline = Date.now() + 5000;
      let content = '';
      while (Date.now() < deadline) {
        content = await readFile(filePath, 'utf8').catch(() => '');
        if (content.trim().split('\n').filter(Boolean).length >= 3) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const lines = content.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('"journal_header"');
      expect(lines[1]).toContain('"seq":1');
      expect(lines[2]).toContain('"seq":2');
      expect(fsMock.appendFailures).toBe(0);
    } finally {
      fsMock.appendFailures = 0;
      await j.close();
    }
  });

  it('keeps the journal header pending when the first write fails, preserving the epoch', async () => {
    const j = await SessionEventJournal.open(filePath);
    const epoch = j.epoch;
    fsMock.appendFailures = 1;
    try {
      j.append(j.nextSeq(), envelope(1));
      const deadline = Date.now() + 5000;
      let content = '';
      while (Date.now() < deadline) {
        content = await readFile(filePath, 'utf8').catch(() => '');
        if (content.includes('"journal_header"') && content.includes('"seq":1')) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('"journal_header"');
      expect(lines[1]).toContain('"seq":1');
    } finally {
      fsMock.appendFailures = 0;
      await j.close();
    }

    const reopened = await SessionEventJournal.open(filePath);
    expect(reopened.epoch).toBe(epoch);
    expect(reopened.seq).toBe(1);
    await reopened.close();
  });

  it('does not write buffered lines after close', async () => {
    const j = await SessionEventJournal.open(filePath);
    fsMock.appendFailures = 100;
    j.append(j.nextSeq(), envelope(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await j.close();
    fsMock.appendFailures = 0;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await readFile(filePath, 'utf8').catch(() => '')).toBe('');
  });

  it('does not duplicate events after a partially committed write', async () => {
    const j = await SessionEventJournal.open(filePath);
    fsMock.appendPrefixLines = 2;
    try {
      j.append(j.nextSeq(), envelope(1));
      j.append(j.nextSeq(), envelope(2));

      const deadline = Date.now() + 5000;
      let content = '';
      while (Date.now() < deadline) {
        content = await readFile(filePath, 'utf8').catch(() => '');
        if (content.includes('"seq":2')) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const lines = content.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('"journal_header"');
      expect(lines[1]).toContain('"seq":1');
      expect(lines[2]).toContain('"seq":2');
      const entries = await j.readSince(0, 100);
      expect(entries.map((entry) => entry.seq)).toEqual([1, 2]);
    } finally {
      await j.close();
    }
  });

  it('repairs a torn line on retry so the event is not lost', async () => {
    const j = await SessionEventJournal.open(filePath);
    const epoch = j.epoch;
    fsMock.appendPrefixBytes = 10;
    try {
      j.append(j.nextSeq(), envelope(1));

      const deadline = Date.now() + 5000;
      let content = '';
      while (Date.now() < deadline) {
        content = await readFile(filePath, 'utf8').catch(() => '');
        if (content.includes('"seq":1')) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const entries = await j.readSince(0, 100);
      expect(entries.map((entry) => entry.seq)).toEqual([1]);

      const reopened = await SessionEventJournal.open(filePath);
      expect(reopened.epoch).toBe(epoch);
      expect(reopened.seq).toBe(1);
      await reopened.close();
    } finally {
      await j.close();
    }
  });

  it('keeps the event pending when a repeated failure commits only the repair delimiter', async () => {
    const j = await SessionEventJournal.open(filePath);
    try {
      j.append(j.nextSeq(), envelope(1));
      await j.flush();
      fsMock.appendPrefixes = [10, 1];
      j.append(j.nextSeq(), envelope(2));
      await j.flush();
      await j.flush();
      await j.flush();

      expect((await j.readSince(0, 100)).map((entry) => entry.seq)).toEqual([1, 2]);
    } finally {
      await j.close();
    }
  });

  it('reconciles a partial write ending inside a multibyte UTF-8 character', async () => {
    const j = await SessionEventJournal.open(filePath);
    try {
      j.append(j.nextSeq(), envelope(1));
      await j.flush();
      const event = { ...envelope(2), payload: { text: '你好' } };
      const bytes = Buffer.from(JSON.stringify({ kind: 'event', seq: 2, envelope: event }), 'utf8');
      fsMock.appendPrefixBytes = bytes.indexOf(Buffer.from('你', 'utf8')) + 1;
      j.append(j.nextSeq(), event);
      await j.flush();
      await j.flush();

      const entries = await j.readSince(0, 100);
      expect(entries.map((entry) => entry.seq)).toEqual([1, 2]);
      expect(entries[1]?.envelope.payload).toEqual({ text: '你好' });
    } finally {
      await j.close();
    }
  });

  it('does not queue the incomplete header as an event when retrying its torn write', async () => {
    const j = await SessionEventJournal.open(filePath);
    try {
      fsMock.appendPrefixBytes = 10;
      j.append(j.nextSeq(), envelope(1));
      await j.flush();
      await j.flush();

      const parsed = (await readFile(filePath, 'utf8')).trim().split('\n').flatMap((line) => {
        try {
          return [JSON.parse(line) as { kind: string }];
        } catch {
          return [];
        }
      });
      expect(parsed.filter((line) => line.kind === 'journal_header')).toHaveLength(1);
      expect((await j.readSince(0, 100)).map((entry) => entry.seq)).toEqual([1]);
    } finally {
      await j.close();
    }
  });

  it('close retries the buffered events after an in-flight append fails', async () => {
    const j = await SessionEventJournal.open(filePath);
    j.append(j.nextSeq(), envelope(1));
    await j.flush();
    const callsBefore = fsMock.appendCalls;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let release!: () => void;
    fsMock.appendGate = new Promise<void>((resolve) => { release = resolve; });
    fsMock.appendStarted = markStarted;
    fsMock.appendFailures = 1;
    j.append(j.nextSeq(), envelope(2));
    await started;
    const closing = j.close();
    release();
    await closing;

    expect(fsMock.appendCalls - callsBefore).toBe(2);
    const reopened = await SessionEventJournal.open(filePath);
    expect(reopened.seq).toBe(2);
    expect((await reopened.readSince(0, 100)).map((entry) => entry.seq)).toEqual([1, 2]);
    await reopened.close();
  });
});
