import { parseArgs } from 'node:util';
import { exportCommands } from '@wif-viz/collector';

const USAGE = `使い方: wif-viz export-commands --org <ORG_ID> --destination gs://<BUCKET>/<PATH> [options]

collect --from-export の入力を作る gcloud コマンドを表示する。

  --org <id>                 対象の Organization ID（必須）
  --destination <gs://...>   エクスポートの書き出し先（必須）
  --billing-project <id>     エクスポートのクォータを付ける project
  --local-dir <path>         ダウンロード先（デフォルト: ./wif-viz-export）`;

export async function exportCommandsCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      org: { type: 'string' },
      destination: { type: 'string' },
      'billing-project': { type: 'string' },
      'local-dir': { type: 'string', default: './wif-viz-export' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || !values.org || !values.destination?.startsWith('gs://')) {
    console.error(USAGE);
    return values.help ? 0 : 1;
  }

  const [resource, iamPolicy, download] = exportCommands({
    orgId: values.org,
    destination: values.destination,
    localDir: values['local-dir'],
    ...(values['billing-project'] ? { billingProject: values['billing-project'] } : {}),
  });
  console.log(`# 1. エクスポートを開始する（非同期。完了は gcloud asset operations describe で確認する）
${resource}
${iamPolicy}

# 2. 完了後にダウンロードする
${download}

# 3. スナップショットを作る
pnpm wif-viz collect --org ${values.org} --from-export ${values['local-dir']}`);
  return 0;
}
