// attributeCondition / attributeMapping で使われる CEL の一部だけを解釈する簡易パーサー。
// 対応: 文字列・真偽値・リスト、参照（a.b.c / a['b']）、==, !=, in, &&, ||, !, 括弧、
//       startsWith / endsWith / contains メソッド。それ以外はパースエラーにする。

export type CelNode =
  | { type: 'or' | 'and'; items: CelNode[]; start: number; end: number }
  | { type: 'not'; expr: CelNode; start: number; end: number }
  | { type: 'cmp'; op: '==' | '!=' | 'in'; left: CelNode; right: CelNode; start: number; end: number }
  | { type: 'call'; method: string; receiver: CelNode; args: CelNode[]; start: number; end: number }
  | { type: 'ref'; path: string; start: number; end: number }
  | { type: 'lit'; value: string | boolean; start: number; end: number }
  | { type: 'list'; items: CelNode[]; start: number; end: number };

type Token =
  | { kind: 'str'; value: string; start: number; end: number }
  | { kind: 'ident'; value: string; start: number; end: number }
  | { kind: 'op'; value: string; start: number; end: number };

export class CelParseError extends Error {}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '"' || ch === "'") {
      const start = i++;
      let value = '';
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\') i++;
        value += source[i++] ?? '';
      }
      if (i >= source.length) throw new CelParseError(`unterminated string at ${start}`);
      tokens.push({ kind: 'str', value, start, end: ++i });
    } else if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) i++;
      tokens.push({ kind: 'ident', value: source.slice(start, i), start, end: i });
    } else {
      const two = source.slice(i, i + 2);
      if (['==', '!=', '&&', '||'].includes(two)) {
        tokens.push({ kind: 'op', value: two, start: i, end: i + 2 });
        i += 2;
      } else if ('!()[],.'.includes(ch)) {
        tokens.push({ kind: 'op', value: ch, start: i, end: i + 1 });
        i++;
      } else {
        throw new CelParseError(`unsupported character '${ch}' at ${i}`);
      }
    }
  }
  return tokens;
}

export function parseCel(source: string): CelNode {
  const tokens = tokenize(source);
  let pos = 0;

  const peek = () => tokens[pos];
  const isOp = (value: string) => peek()?.kind === 'op' && peek()?.value === value;
  const expectOp = (value: string) => {
    if (!isOp(value)) throw new CelParseError(`expected '${value}' at ${peek()?.start ?? source.length}`);
    return tokens[pos++]!;
  };

  const parseOr = (): CelNode => {
    const items = [parseAnd()];
    while (isOp('||')) {
      pos++;
      items.push(parseAnd());
    }
    return items.length === 1 ? items[0]! : { type: 'or', items, start: items[0]!.start, end: items.at(-1)!.end };
  };

  const parseAnd = (): CelNode => {
    const items = [parseUnary()];
    while (isOp('&&')) {
      pos++;
      items.push(parseUnary());
    }
    return items.length === 1 ? items[0]! : { type: 'and', items, start: items[0]!.start, end: items.at(-1)!.end };
  };

  const parseUnary = (): CelNode => {
    if (isOp('!')) {
      const start = tokens[pos++]!.start;
      const expr = parseUnary();
      return { type: 'not', expr, start, end: expr.end };
    }
    return parseComparison();
  };

  const parseComparison = (): CelNode => {
    const left = parseOperand();
    const token = peek();
    const op = token?.kind === 'op' && (token.value === '==' || token.value === '!=') ? token.value : token?.kind === 'ident' && token.value === 'in' ? 'in' : undefined;
    if (!op) return left;
    pos++;
    const right = parseOperand();
    return { type: 'cmp', op, left, right, start: left.start, end: right.end };
  };

  const parseOperand = (): CelNode => {
    let node = parsePrimary();
    // メソッド呼び出し（ref 以外のレシーバー、例: (a).startsWith('x')）
    while (isOp('.')) {
      pos++;
      const name = peek();
      if (name?.kind !== 'ident') throw new CelParseError(`expected method name at ${name?.start ?? source.length}`);
      pos++;
      node = parseCall(node, name.value);
    }
    return node;
  };

  const parseArgs = (): CelNode[] => {
    expectOp('(');
    const args: CelNode[] = [];
    while (!isOp(')')) {
      args.push(parseOr());
      if (!isOp(')')) expectOp(',');
    }
    expectOp(')');
    return args;
  };

  const parseCall = (receiver: CelNode, method: string): CelNode => {
    const args = parseArgs();
    return { type: 'call', method, receiver, args, start: receiver.start, end: tokens[pos - 1]!.end };
  };

  const parsePrimary = (): CelNode => {
    const token = peek();
    if (!token) throw new CelParseError('unexpected end of expression');

    if (token.kind === 'str') {
      pos++;
      return { type: 'lit', value: token.value, start: token.start, end: token.end };
    }
    if (token.kind === 'op' && token.value === '(') {
      pos++;
      const expr = parseOr();
      const close = expectOp(')');
      // 原文を切り出せるよう、範囲に括弧を含める
      return { ...expr, start: token.start, end: close.end };
    }
    if (token.kind === 'op' && token.value === '[') {
      const start = tokens[pos++]!.start;
      const items: CelNode[] = [];
      while (!isOp(']')) {
        items.push(parseOr());
        if (!isOp(']')) expectOp(',');
      }
      const end = expectOp(']').end;
      return { type: 'list', items, start, end };
    }
    if (token.kind === 'ident') {
      if (token.value === 'true' || token.value === 'false') {
        pos++;
        return { type: 'lit', value: token.value === 'true', start: token.start, end: token.end };
      }
      // 参照のパス。最後のセグメントの後に '(' が来たらメソッド呼び出しとみなす
      const segments = [token.value];
      const start = token.start;
      let end = token.end;
      pos++;
      for (;;) {
        if (isOp('.') && tokens[pos + 1]?.kind === 'ident') {
          const name = tokens[pos + 1]!;
          if (tokens[pos + 2]?.kind === 'op' && tokens[pos + 2]?.value === '(') {
            pos += 2;
            return parseCall({ type: 'ref', path: segments.join('.'), start, end }, name.value);
          }
          segments.push(name.value);
          end = name.end;
          pos += 2;
        } else if (isOp('[') && tokens[pos + 1]?.kind === 'str' && tokens[pos + 2]?.kind === 'op' && tokens[pos + 2]?.value === ']') {
          segments.push(tokens[pos + 1]!.value);
          end = tokens[pos + 2]!.end;
          pos += 3;
        } else {
          break;
        }
      }
      return { type: 'ref', path: segments.join('.'), start, end };
    }
    throw new CelParseError(`unexpected token '${token.value}' at ${token.start}`);
  };

  const node = parseOr();
  if (pos < tokens.length) throw new CelParseError(`unexpected token '${tokens[pos]!.value}' at ${tokens[pos]!.start}`);
  return node;
}

// ---- 条件の要約 ----

export type ConstraintOp = 'eq' | 'ne' | 'in' | 'startsWith' | 'endsWith' | 'contains';

/** 参照 1 つに対する制約（例: attribute.repository == 'org/repo'） */
export interface Constraint {
  /** 参照パス（attribute.repository、assertion.sub など） */
  ref: string;
  op: ConstraintOp;
  values: string[];
}

export interface ConditionSummary {
  /** トップレベルの AND を構成する、解釈できた制約 */
  constraints: Constraint[];
  /** 解釈できなかった部分式（原文） */
  unparsed: string[];
}

const METHOD_OPS: Record<string, ConstraintOp> = { startsWith: 'startsWith', endsWith: 'endsWith', contains: 'contains' };

function atomic(node: CelNode): Constraint | undefined {
  if (node.type === 'cmp') {
    const [ref, other] = node.left.type === 'ref' ? [node.left, node.right] : [node.right, node.left];
    if (ref.type !== 'ref') return undefined;
    if (node.op === 'in') {
      if (node.left.type !== 'ref' || other.type !== 'list') return undefined;
      const values = other.items.map((item) => (item.type === 'lit' && typeof item.value === 'string' ? item.value : undefined));
      return values.every((v) => v !== undefined) ? { ref: ref.path, op: 'in', values: values as string[] } : undefined;
    }
    if (other.type !== 'lit' || typeof other.value !== 'string') return undefined;
    return { ref: ref.path, op: node.op === '==' ? 'eq' : 'ne', values: [other.value] };
  }
  if (node.type === 'call' && node.receiver.type === 'ref' && METHOD_OPS[node.method]) {
    const [arg] = node.args;
    if (node.args.length !== 1 || arg?.type !== 'lit' || typeof arg.value !== 'string') return undefined;
    return { ref: node.receiver.path, op: METHOD_OPS[node.method]!, values: [arg.value] };
  }
  return undefined;
}

/** 同じ参照に対する == / in の OR を 1 つの in にまとめる */
function orGroup(node: CelNode): Constraint | undefined {
  if (node.type !== 'or') return undefined;
  const parts = node.items.map((item) => atomic(item));
  const first = parts[0];
  if (!first || !parts.every((p) => p && p.ref === first.ref && (p.op === 'eq' || p.op === 'in'))) return undefined;
  return { ref: first.ref, op: 'in', values: [...new Set(parts.flatMap((p) => p!.values))] };
}

export function summarizeCondition(source: string): ConditionSummary {
  let node: CelNode;
  try {
    node = parseCel(source);
  } catch {
    return { constraints: [], unparsed: [source.trim()] };
  }
  const terms = node.type === 'and' ? node.items : [node];
  const summary: ConditionSummary = { constraints: [], unparsed: [] };
  for (const term of terms) {
    const constraint = atomic(term) ?? orGroup(term);
    if (constraint) {
      summary.constraints.push(constraint);
    } else {
      summary.unparsed.push(source.slice(term.start, term.end).trim());
    }
  }
  return summary;
}
