import { describe, expect, it } from 'vitest';
import type { AdapterPoolService } from '../../../connections/adapter-pool.service';
import {
  MysqlCdcProvider,
  binlogEventStart,
  gtidFromEvent,
} from './mysql-cdc.provider';

// cursorAfter/splitCursor are pure, the pool is only used by readiness()
const provider = new MysqlCdcProvider(null as unknown as AdapterPoolService);
const split = (c: string) => provider['splitCursor'](c);
const make = (a: Parameters<MysqlCdcProvider['makeCursor']>[0]) =>
  provider['makeCursor'](a);
const serverOf = (c: string) => provider['cursorServer'](c);

describe('splitCursor', () => {
  it('parses the current start-format cursor "file:pos:row:s"', () => {
    expect(split('binlog.000042:1540:3:s')).toEqual(['binlog.000042', 1540, 3, true]);
  });

  it('parses the legacy end-format cursor "file:pos:row"', () => {
    expect(split('binlog.000042:1540:3')).toEqual(['binlog.000042', 1540, 3, false]);
  });

  it('parses the oldest "file:pos" cursor with row index -1', () => {
    expect(split('binlog.000042:1540')).toEqual(['binlog.000042', 1540, -1, false]);
  });

  it('keeps a filename containing colons intact', () => {
    expect(split('my:log.000001:200:0:s')).toEqual(['my:log.000001', 200, 0, true]);
    expect(split('my:log.000001:200:0')).toEqual(['my:log.000001', 200, 0, false]);
  });
});

describe('cursorAfter', () => {
  it('a null watermark means everything is new', () => {
    expect(provider.cursorAfter('binlog.000001:4:0:s', null)).toBe(true);
  });

  it('orders by file first (zero-padded names compare lexically)', () => {
    expect(provider.cursorAfter('binlog.000002:4:0:s', 'binlog.000001:9999:5:s')).toBe(true);
    expect(provider.cursorAfter('binlog.000001:9999:5:s', 'binlog.000002:4:0:s')).toBe(false);
  });

  it('then by position, then by row index', () => {
    expect(provider.cursorAfter('b.000001:200:0:s', 'b.000001:100:9:s')).toBe(true);
    expect(provider.cursorAfter('b.000001:100:4:s', 'b.000001:100:3:s')).toBe(true);
    expect(provider.cursorAfter('b.000001:100:3:s', 'b.000001:100:3:s')).toBe(false);
    expect(provider.cursorAfter('b.000001:100:2:s', 'b.000001:100:3:s')).toBe(false);
  });

  it('drops the already-delivered prefix of a replayed statement (mid-event resume)', () => {
    // crash happened after row 2 of a 5-row statement whose tablemap starts at 500
    const watermark = 'b.000001:500:2:s';
    // resume re-enters at 500 and replays rows 0..4
    expect(provider.cursorAfter('b.000001:500:0:s', watermark)).toBe(false);
    expect(provider.cursorAfter('b.000001:500:2:s', watermark)).toBe(false);
    expect(provider.cursorAfter('b.000001:500:3:s', watermark)).toBe(true);
    expect(provider.cursorAfter('b.000001:500:4:s', watermark)).toBe(true);
  });

  it('a start-format cursor at the offset where a legacy cursor ENDED is after it', () => {
    // legacy watermark: event ended at 800; the next statement's tablemap can
    // start at exactly 800, and its rows must not be dropped by the tie
    expect(provider.cursorAfter('b.000001:800:0:s', 'b.000001:800:7')).toBe(true);
    // and the mirror image: a legacy cursor at a start-format watermark's
    // offset belongs to the event BEFORE it
    expect(provider.cursorAfter('b.000001:800:7', 'b.000001:800:0:s')).toBe(false);
  });

  it('legacy 2-part watermarks compare as row -1, so row 0 still delivers', () => {
    expect(provider.cursorAfter('b.000001:800:0', 'b.000001:800')).toBe(true);
    expect(provider.cursorAfter('b.000001:799:0', 'b.000001:800')).toBe(false);
  });
});

describe('binlogEventStart (resume-position math)', () => {
  it('subtracts payload size and the 19-byte header', () => {
    // tablemap payload of 41 bytes ending at 560 starts at 560 - 41 - 19 = 500
    expect(binlogEventStart({ nextPosition: 560, size: 41 }, false)).toBe(500);
  });

  it('accounts for the 4-byte CRC32 when binlog_checksum is on', () => {
    // zongji strips the checksum from `size`, but next_position includes it
    expect(binlogEventStart({ nextPosition: 564, size: 41 }, true)).toBe(500);
  });
});

describe('server-identity cursors', () => {
  const base = { file: 'binlog.000007', pos: 900, row: 2, isStart: true };

  it('keeps the compact legacy form when the server is unknown', () => {
    expect(make({ ...base, serverUuid: null, gtid: null })).toBe(
      'binlog.000007:900:2:s',
    );
  });

  it('emits JSON carrying the server uuid when it is known', () => {
    const c = make({ ...base, serverUuid: 'uuid-a', gtid: 'uuid-a:12' });
    expect(serverOf(c)).toBe('uuid-a');
    expect(provider['cursorGtid'](c)).toBe('uuid-a:12');
  });

  it('parses back to the same coordinates it was built from', () => {
    const c = make({ ...base, serverUuid: 'uuid-a', gtid: null });
    expect(split(c)).toEqual(['binlog.000007', 900, 2, true]);
  });

  it('reports no server for a legacy cursor', () => {
    expect(serverOf('binlog.000007:900:2:s')).toBeNull();
  });

  it('survives a malformed JSON cursor without throwing', () => {
    expect(serverOf('{not json')).toBeNull();
    expect(split('{not json')).toEqual(['{not json', 0, -1, false]);
  });

  it('orders identically whether a cursor is JSON or legacy', () => {
    // a stream upgraded mid-flight compares old watermarks against new cursors
    const modern = make({
      file: 'b.000001',
      pos: 200,
      row: 0,
      isStart: true,
      serverUuid: 'u1',
      gtid: null,
    });
    expect(provider.cursorAfter(modern, 'b.000001:100:9:s')).toBe(true);
    expect(provider.cursorAfter('b.000001:300:0:s', modern)).toBe(true);
    expect(provider.cursorAfter(modern, 'b.000001:300:0:s')).toBe(false);
    // and against another JSON cursor
    const later = make({
      file: 'b.000001',
      pos: 400,
      row: 0,
      isStart: true,
      serverUuid: 'u1',
      gtid: null,
    });
    expect(provider.cursorAfter(later, modern)).toBe(true);
    expect(provider.cursorAfter(modern, later)).toBe(false);
  });
});

describe('gtidFromEvent', () => {
  it('formats the 16-byte server id and transaction number as a GTID', () => {
    const sid = Buffer.from('3E11FA47710C4A4EA9B4E75E1B1B2B3C', 'hex');
    expect(gtidFromEvent({ serverId: sid, transactionRange: 42 })).toBe(
      '3e11fa47-710c-4a4e-a9b4-e75e1b1b2b3c:42',
    );
  });

  it('returns null when the server id is not a 16-byte buffer', () => {
    expect(gtidFromEvent({ serverId: 'nope', transactionRange: 1 })).toBeNull();
    expect(gtidFromEvent({ serverId: Buffer.alloc(4), transactionRange: 1 })).toBeNull();
    expect(gtidFromEvent({})).toBeNull();
  });
});
