/**
 * nextStreamId is what makes trimming correct: XTRIM MINID removes entries
 * strictly BELOW the given id, so trimming *through* a delivered entry means
 * trimming below its successor. Getting this wrong either leaves the last
 * delivered entry behind forever (it would be redelivered on every pass) or
 * trims one too many (silent data loss).
 */
import { describe, expect, it } from 'vitest';
import { nextStreamId } from './cdc-spool.service';

describe('nextStreamId', () => {
  it('increments the sequence part', () => {
    expect(nextStreamId('1700000000000-0')).toBe('1700000000000-1');
    expect(nextStreamId('1700000000000-41')).toBe('1700000000000-42');
  });

  it('leaves the millisecond part untouched', () => {
    expect(nextStreamId('12345-7')).toBe('12345-8');
  });

  it('returns the input unchanged when it is not a stream id', () => {
    expect(nextStreamId('nonsense')).toBe('nonsense');
    expect(nextStreamId('1700000000000-x')).toBe('1700000000000-x');
  });

  it('is strictly greater than the id it came from', () => {
    // the ordering XTRIM relies on: same ms, higher sequence
    const id = '1700000000000-5';
    const next = nextStreamId(id);
    const [ms, seq] = id.split('-').map(Number);
    const [nms, nseq] = next.split('-').map(Number);
    expect(nms).toBe(ms);
    expect(nseq).toBeGreaterThan(seq!);
  });
});
