import { describe, expect, it } from 'vitest';
import { CelParseError, parseCel, summarizeCondition } from '../src/cel.ts';

describe('summarizeCondition', () => {
  it('リテラルが左側の比較と、同じ参照への OR を in にまとめる', () => {
    expect(summarizeCondition(`('alice'==attribute.actor || 'renovate[bot]'==attribute.actor) && 'org/infra'==attribute.repository`)).toEqual({
      constraints: [
        { ref: 'attribute.actor', op: 'in', values: ['alice', 'renovate[bot]'] },
        { ref: 'attribute.repository', op: 'eq', values: ['org/infra'] },
      ],
      unparsed: [],
    });
  });

  it('in リスト、!=、メソッド呼び出し、添字アクセスを解釈する', () => {
    expect(
      summarizeCondition(
        `assertion.repository_owner_id in ['123', "456"] && attribute.repository.startsWith('org/') && assertion['ref'] != 'refs/heads/dev'`,
      ).constraints,
    ).toEqual([
      { ref: 'assertion.repository_owner_id', op: 'in', values: ['123', '456'] },
      { ref: 'attribute.repository', op: 'startsWith', values: ['org/'] },
      { ref: 'assertion.ref', op: 'ne', values: ['refs/heads/dev'] },
    ]);
  });

  it('解釈できない項は原文のまま unparsed に入れ、残りは解釈する', () => {
    expect(summarizeCondition(`attribute.a == 'x' || attribute.b == 'y' && attribute.c == 'z'`)).toEqual({
      constraints: [],
      unparsed: [`attribute.a == 'x' || attribute.b == 'y' && attribute.c == 'z'`],
    });
    expect(summarizeCondition(`!(attribute.a == 'x') && attribute.b == 'y'`)).toEqual({
      constraints: [{ ref: 'attribute.b', op: 'eq', values: ['y'] }],
      unparsed: [`!(attribute.a == 'x')`],
    });
  });

  it('対応していない構文は全体を unparsed にする', () => {
    expect(summarizeCondition('size(assertion.groups) > 0')).toEqual({ constraints: [], unparsed: ['size(assertion.groups) > 0'] });
  });
});

describe('parseCel', () => {
  it('mapping の式を参照として解析する', () => {
    expect(parseCel('assertion.repository')).toMatchObject({ type: 'ref', path: 'assertion.repository' });
    expect(() => parseCel(`assertion.repository_owner + '/' + assertion.repository`)).toThrow(CelParseError);
  });
});
