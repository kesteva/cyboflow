import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { canonicalJson, jsonByteLength, projectionHash } from '../canonical';

describe('canonicalJson', () => {
  it('sorts keys at every depth with no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });
  it('omits undefined members and nulls undefined/functions in arrays', () => {
    expect(canonicalJson({ a: undefined, b: 1, c: () => 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined, () => 1, 2, null])).toBe('[null,null,2,null]');
  });
  it('top-level undefined is null', () => {
    expect(canonicalJson(undefined)).toBe('null');
  });
  it('uses toJSON', () => {
    expect(canonicalJson({ d: new Date('2026-01-02T03:04:05.000Z') })).toBe('{"d":"2026-01-02T03:04:05.000Z"}');
  });
  it('escapes strings like JSON.stringify', () => {
    expect(canonicalJson({ 'k"': 'a\nb' })).toBe('{"k\\"":"a\\nb"}');
  });
});

describe('projectionHash', () => {
  const e1 = { entityId: 'a', entityType: 'task', ref: 'T-1', fields: { title: 'x', n: 1 } };
  const e2 = { entityId: 'b', entityType: 'idea', ref: null, fields: { z: true } };
  it('matches a hand-computed sha256 for one entity', () => {
    const expected = createHash('sha256').update('a\ttask\tT-1\t{"n":1,"title":"x"}\n', 'utf8').digest('hex');
    expect(projectionHash([e1])).toBe(expected);
  });
  it('excludes deleted entities', () => {
    expect(projectionHash([e1, { ...e2, deleted: true }])).toBe(projectionHash([e1]));
  });
  it('is order independent', () => {
    expect(projectionHash([e1, e2])).toBe(projectionHash([e2, e1]));
  });
  it('renders a null ref as empty', () => {
    const expected = createHash('sha256').update('b\tidea\t\t{"z":true}\n', 'utf8').digest('hex');
    expect(projectionHash([e2])).toBe(expected);
  });
});

describe('jsonByteLength', () => {
  it('counts UTF-8 bytes', () => {
    expect(jsonByteLength({ a: 'é' })).toBe(Buffer.byteLength('{"a":"é"}', 'utf8'));
    expect(jsonByteLength('x')).toBe(3);
  });
});
