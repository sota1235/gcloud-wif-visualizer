# gcloud-wif-visualizer

Google Cloud の Workload Identity Federation（WIF）の設定を Organization 全体から収集し、
**どの外部ワークロード（GitHub Actions など）が、どの経路で、どのリソースに、どの権限を持つか** をデータ化・可視化するツールです。

- WIF の principal を起点に、SA の impersonation（多段）や actAs を辿って到達できる権限を求めます
- project / folder / org に付与されたロールを、配下の実リソース（バケット、Secret、Cloud Run など）まで展開します
- Provider の attributeMapping / attributeCondition から、GitHub の repo / environment / ref などを推定します
- 危険な設定や経路を Lint で検出し、「対応推奨リスト」としてブラウザで確認できます

> [!NOTE]
> 開発中のツールです。仕様は [docs/spec.md](docs/spec.md) を参照してください。

## 必要なもの

- Node.js 22 以上
- pnpm 12
- Google Cloud SDK（`gcloud`）と Application Default Credentials（ADC）
- 対象 Organization に対する、以下の読み取り権限
  - `roles/cloudasset.viewer`
  - `roles/iam.workloadIdentityPoolViewer`
  - `roles/iam.roleViewer`
  - `roles/browser`
- API のクォータを付ける project で、以下の API が有効になっていること
  - `cloudasset.googleapis.com`
  - `iam.googleapis.com`

GCP に対しては読み取り専用の API しか呼びません。

## セットアップ

```sh
pnpm install
gcloud auth application-default login
```

## 使い方

### 1. スナップショットを収集する

```sh
pnpm wif-viz collect --org <ORG_ID> --quota-project <PROJECT_ID> -o my-org.snapshot.json
```

| オプション | 説明 | デフォルト |
|---|---|---|
| `--org <id>` | 対象の Organization ID（必須） | |
| `-o, --output <path>` | 出力先 | `wif-viz-<org>-<日付>.snapshot.json` |
| `--max-depth <n>` | impersonation を辿る SA の段数の上限 | `5` |
| `--quota-project <id>` | API のクォータを付ける project（ADC の quota project を上書き） | ADC の設定 |
| `--concurrency <n>` | API の同時呼び出し数 | `8` |

収集が終わると、Lint の件数（high / medium / low）が表示されます。

### 2. ブラウザで表示する

```sh
pnpm wif-viz serve my-org.snapshot.json
```

http://127.0.0.1:4000/ を開いてください（`--port` で変更できます）。表示には GCP の認証は不要です。

画面でできること:

- **対応推奨リスト**: Lint の検出結果を、重要度と影響範囲の大きさの順に表示します。項目を選ぶと、推奨される対応と、原因となっている経路がグラフに表示されます
- **ワークロード**: 推定した外部ワークロードを選ぶと、そのワークロードから到達できる権限の経路を表示します
- **概観**: Workload → principal → SA の層だけを表示します
- **詳細パネル**: ノードを選ぶと、ワークロードの推定根拠、SA のロール、到達できるリソースの一覧などを表示します。「このノードを中心に表示」で、そのノードを通る経路だけに絞り込めます

## Lint ルール

| ルール | 内容 | 重要度 |
|---|---|---|
| `primitive-role` | WIF 経由で `roles/owner` / `roles/editor` に到達できる | high |
| `iam-admin-reachable` | WIF 経由で IAM / WIF の設定を書き換えられる permission に到達できる | high |
| `wildcard-principal-set` | Pool 内のすべての ID（`principalSet://…/*`）に権限が付与されている | high |
| `github-missing-attribute-condition` | GitHub の Provider に attributeCondition がない | high |
| `org-level-token-creator` | folder / org レベルで impersonation 権限が付与されている | high |
| `act-as-reachable` | WIF 経由で `iam.serviceAccounts.actAs` に到達できる（actAs 先の SA が強い権限を持つ場合は high） | medium / high |
| `github-name-based-trust` | repo / owner を名前だけで信頼しており、ID で制限していない | medium |
| `deep-impersonation-chain` | SA の impersonation が 2 段以上連鎖している | medium |
| `dangling-principal` | Org 内に存在しない Pool を参照するバインディングがある | medium |
| `github-actor-based-trust` | attributeCondition が実行者（actor）に依存している | low |
| `disabled-but-bound` | 無効化された Pool や、存在しない SA へのバインディングが残っている | low |
| `unreachable-principal` | principal が attributeCondition と矛盾し、バインディングが使われない | low |

impersonation は、`iam.serviceAccounts.getAccessToken` などに加えて `iam.serviceAccountKeys.create`（SA の鍵の作成）も対象として判定します。

## 注意事項

- **スナップショットには組織の権限情報が含まれます。** 取り扱いに注意してください。`*.snapshot.json` は `.gitignore` の対象です
- `serve` は localhost（`127.0.0.1`）でのみ待ち受けます
- IAM Conditions は評価せず、条件付きであることだけを表示します。Deny ポリシーや Principal Access Boundary は考慮していません
- GKE 用の Workload Identity Federation（`*.svc.id.goog`）は対象外です
- ワークロードの推定は GitHub Actions に対応しています。その他の IdP は claim と値をそのまま表示します

## 構成

```
packages/
  core/       グラフ構築、impersonation の探索、ワークロード推定、リソース展開、Lint、差分（API に依存しない純粋なロジック）
  collector/  GCP API（Cloud Asset Inventory / IAM）からの収集
  web/        ブラウザ UI（React + React Flow + elkjs）と serve 用のサーバー
  cli/        wif-viz コマンド
poc/          技術検証用のスクリプトとビューア
docs/spec.md  仕様
```

## 開発

```sh
pnpm test       # 全パッケージのテスト
pnpm typecheck  # 全パッケージの型チェック
```

## 今後の予定

- テーブル表示と CSV の書き出し
- `wif-viz diff` とブラウザの差分モード（スナップショット間の権限の増減）
- 対応推奨リストのトリアージ状態（対応予定 / 許容）の保存
- Policy Analyzer による結果の突き合わせ（`collect --verify`）
- 配布用のビルド
