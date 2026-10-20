import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { collectSnapshot, createGcpClient } from '@wif-viz/collector';
import { findingsOf } from '@wif-viz/core';

const USAGE = `使い方: wif-viz collect --org <ORG_ID> [options]

  --org <id>              対象の Organization ID（必須）
  -o, --output <path>     出力先（デフォルト: wif-viz-<org>-<日付>.snapshot.json）
  --max-depth <n>         impersonation を辿る SA の段数の上限（デフォルト: 5）
  --quota-project <id>    API のクォータを付ける project（ADC の quota project を上書き）
  --concurrency <n>       API の同時呼び出し数（デフォルト: 8）`;

export async function collectCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      org: { type: 'string' },
      output: { type: 'string', short: 'o' },
      'max-depth': { type: 'string', default: '5' },
      'quota-project': { type: 'string' },
      concurrency: { type: 'string', default: '8' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || !values.org) {
    console.error(USAGE);
    return values.help ? 0 : 1;
  }

  const startedAt = performance.now();
  const gcp = createGcpClient({
    ...(values['quota-project'] ? { quotaProject: values['quota-project'] } : {}),
    concurrency: Number(values.concurrency),
  });
  const { snapshot, warnings } = await collectSnapshot(gcp, {
    orgId: values.org,
    maxDepth: Number(values['max-depth']),
    log: (message) => console.error(`  ${message}`),
  });

  const output = values.output ?? `wif-viz-${values.org}-${snapshot.collectedAt.slice(0, 10)}.snapshot.json`;
  await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`);

  for (const warning of warnings) console.error(`警告: ${warning}`);
  const findings = findingsOf(snapshot);
  const count = (severity: string) => findings.filter((f) => f.severity === severity).length;
  console.error(
    `\n${output} に保存しました（${((performance.now() - startedAt) / 1000).toFixed(1)} 秒、API 呼び出し ${JSON.stringify(gcp.stats)}）`,
  );
  console.error(`Lint: high ${count('high')} / medium ${count('medium')} / low ${count('low')}`);
  console.error('※ スナップショットには組織の権限情報が含まれます。共有やコミットに注意してください。');
  return 0;
}
