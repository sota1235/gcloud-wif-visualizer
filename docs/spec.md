# gcloud-wif-visualizer 仕様（ドラフト v0.6）

## 1. 目的

Google Cloud の Workload Identity Federation（WIF）設定を Organization 全体から収集し、
「どの外部ワークロードが、どの経路で、どのリソースにどの権限を持つか」をデータ化・可視化する。

### 想定ユースケース

- **フォワード検索**: 「GitHub リポジトリ `org/repo` は GCP で何ができるか？」
- **リバース検索**: 「このバケット / Secret / SA に、外部のどのワークロードが到達できるか？」
- **監査**: 過剰な権限付与や危険な設定（Lint）を一覧化する
- **変更検知**: 前回のスナップショットから、到達できる権限がどう増減したかを確認する

## 2. スコープ

| 項目 | MVP | 後続 |
|---|---|---|
| データソース | GCP API（ライブ取得） | Terraform 解析 |
| 対象範囲 | Organization 全体 | 複数 Org |
| アクセス経路 | SA impersonation（多段）、Direct resource access、`actAs` 権限の保有検出（7.5 章） | `actAs` 経由の昇格経路の判定（デプロイ権限との組み合わせ） |
| 権限の粒度 | 実リソース単位まで展開（主要なアセットタイプ） | 全アセットタイプ |
| IdP 解釈 | GitHub Actions | GitLab、AWS、Terraform Cloud、汎用 OIDC など |
| IAM | allow ポリシー、org/folder/project からの継承、カスタムロール。IAM Conditions は表示のみで評価しない | Deny ポリシー、PAB、Conditions の簡易評価 |
| 差分 | スナップショット差分（CLI + UI） | CI 連携（差分があれば非ゼロ終了など） |
| GKE 用 WIF（`*.svc.id.goog`） | 対象外 | 検討 |

## 3. ドメインモデル

```
Workload ──▶ Provider ──▶ Principal ─┬─(impersonate)──▶ SA ─(impersonate)─▶ SA … ─┐
             ∈ Pool       ∈ Pool     │                                            ├─(role)──▶ Container(org/folder/project) ──(展開)──▶ Resource
                                     └────────────────────────────────────────────┘
```

### ノード

| 種別 | 主な属性 |
|---|---|
| `Pool` | name, projectId, projectNumber, displayName, disabled |
| `Provider` | name, pool, type, issuerUri, allowedAudiences, attributeMapping, attributeCondition, disabled, idpKind（`github` / `unknown`） |
| `Principal` | 識別子（`principal://…` / `principalSet://…`）, pool, kind（subject / group / attribute / all）, attributeKey, attributeValue |
| `Workload` | 推定された外部ワークロード（6 章）。表示用に階層を持つ（例: GitHub owner → repo → ref/environment） |
| `ServiceAccount` | email, projectId, uniqueId, disabled |
| `Container` | org / folder / project（ancestors を含む） |
| `Resource` | fullResourceName, assetType, project, ancestors |
| `Role` | name, permissions[]（カスタムロールを含めて展開済み）, stage |

### エッジ

| 種別 | from → to | 属性 |
|---|---|---|
| `RESOLVES_TO` | Workload → Principal | 候補の Provider 一覧、推定の確度 |
| `CAN_IMPERSONATE` | Principal \| SA → SA | role, 付与された箇所（SA 自身 / project / folder / org）, condition |
| `HAS_ROLE` | Principal \| SA → Container \| Resource | role, condition, 付与された箇所 |
| `CAN_ACT_AS` | Principal \| SA → SA | role, 付与された箇所, condition（検出のみ。グラフ探索の対象にはしない） |

### 派生データ: 実効アクセス（Effective Access）

グラフを探索して作る「誰が・何に・何の権限で・どの経路で」の行。可視化、テーブル表示、差分のすべてがこの行を基本単位にする。

```ts
type EffectiveAccess = {
  workloadId: string;      // 推定 Workload（不明な場合は Principal）
  principal: string;
  path: string[];          // 例: [principal, sa1@, sa2@]（impersonation の連鎖）
  role: string;
  grantedOn: string;       // バインディングがある箇所（例: projects/foo）
  resource: string;        // 展開後の実リソース（展開できなかったものは grantedOn と同じ）
  expanded: boolean;       // 実リソースまで展開できたか
  conditional: boolean;    // 経路上に IAM Condition があるか
};
```

### 注意点

- **Principal は Pool 単位で、Provider 単位ではない。** 同じ Pool に Provider が複数あると経由 Provider を特定できないため、候補の一覧として保持する。
- **project ID と number の対応を解決する必要がある。** principal の識別子には project number が入るため、収集時に対応表を作る。
- **impersonation の判定はロール名ではなく permission で行う。** `iam.serviceAccounts.getAccessToken` / `getOpenIdToken` / `signJwt` / `signBlob` / `implicitDelegation`、`iam.serviceAccountKeys.create`（鍵を作れれば長期的な資格情報を得られる）を含むロール（カスタムロールを含む）を impersonation 可能とみなす。
- **project / folder / org レベルの impersonation 権限は配下の全 SA に及ぶ。** 例えば project に付与された `roles/iam.serviceAccountTokenCreator` は、その project の全 SA への `CAN_IMPERSONATE` に展開する。

## 4. アーキテクチャ

```
wif-viz collect --org <ORG_ID> -o snapshot.json    # GCP API → 正規化済みスナップショット
wif-viz serve snapshot.json [--base old.json]      # ローカル Web UI（--base で差分モード）
wif-viz diff old.json new.json [--format text|json|markdown]
```

- 収集と表示を分離する。表示時に GCP 認証が不要になり、スナップショットの保存・共有・差分比較ができる。
- 認証は Application Default Credentials を使う。

### 収集フロー（collect）

1. **組織構造**: Cloud Asset `searchAllResources` で org / folder / project を取得する（ancestors、project ID ⇔ number の対応）
2. **WIF 設定**: Cloud Asset で Pool / Provider を列挙し、IAM API で詳細（mapping / condition / issuer）を取得する
3. **ロール定義**: 出現したロールを IAM API で permission に展開してキャッシュする（predefined、org/project のカスタムロール）
4. **起点のバインディング**: Cloud Asset `searchAllIamPolicies`（query: `policy:workloadIdentityPools`）で WIF principal を含むバインディングを取得し、member 文字列で厳密にフィルタする（PoC で確認済み。`policy:principal` はヒットしない）
5. **impersonation の探索（BFS）**:
   - 到達した identity ごとに `searchAllIamPolicies` でバインディングを取得する
   - impersonation 系の permission を含むバインディングを `CAN_IMPERSONATE` とし、行き先の SA を次の探索対象に加える（container に付与されたものは配下の全 SA に展開する）
   - 訪問済みの SA はスキップする（循環対策）。最大深さは `--max-depth`（デフォルト 5）で指定する
   - 自分自身への impersonation（SA に自身の tokenCreator が付いているケース）は self-loop として除外する
6. **リソース展開**: 7 章
7. **正規化**: グラフを構築し、Workload 推定、EffectiveAccess 生成、Lint を実行して `snapshot.json` を出力する

### 必要な権限（すべて読み取り専用、org レベル）

- `roles/cloudasset.viewer`
- `roles/iam.workloadIdentityPoolViewer`
- `roles/iam.roleViewer`
- `roles/browser`

## 5. スナップショット形式

```jsonc
{
  "schemaVersion": 1,
  "collectedAt": "2026-10-19T00:00:00Z",
  "org": { "id": "123", "displayName": "example.com" },
  "options": { "maxDepth": 5, "expandAssetTypes": ["..."] },
  "nodes": [...], "edges": [...],
  "effectiveAccess": [...],
  "findings": [...]   // Lint 結果
}
```

- ノードとエッジの ID は GCP のリソース名から決定的に生成する（差分で比較できるようにするため）。
- 機密情報を含むため、デフォルトで `.gitignore` 対象にする。

## 6. Workload の推定（GitHub Actions）

### 判定

Provider の `issuerUri` が `https://token.actions.githubusercontent.com` であれば GitHub と判定する。GHES はオプションで issuer を追加指定する。

### 推定ロジック

1. **attributeMapping を逆変換する。** `attribute.repository = assertion.repository` のような単純な形であれば、claim 名に戻す。式が複雑な場合（`assertion.a + '/' + assertion.b` など）は、既知のパターンに限って対応する。
2. **Principal から Workload を作る。**

| Principal | 推定される Workload |
|---|---|
| `subject/repo:org/repo:ref:refs/heads/main` | repo `org/repo` の ref `main` |
| `subject/repo:org/repo:environment:prod` | repo `org/repo` の environment `prod` |
| `attribute.repository/org/repo` | repo `org/repo`（全 ref） |
| `attribute.repository_owner/org` | owner `org` 配下の全 repo |
| `attribute.repository_id/12345` など ID 系 | ID のまま表示する（API で名前を解決するのは後続） |
| `attribute.workflow_ref` / `job_workflow_ref` | 特定の（reusable）workflow |
| `*`（Pool 全体） | attributeCondition を満たす全ワークロード |

3. **attributeCondition で絞り込む。** CEL を簡易パースし、`==`、`in [...]`、`startsWith`、`&&`、`||`、括弧の組み合わせだけを解釈する。解釈できない部分は原文のまま注記する。
   - 参照は `assertion.*` と `attribute.*` の両方があり得る（PoC の実データでは `attribute.*` だった）。`attribute.*` は mapping で claim に戻す。
   - 比較はリテラルが左側の場合（`'alice'==attribute.actor`）もあるので、左右どちらの順序も扱う。
   - 例: principalSet が `attribute.environment/terraform-plan` で、condition に `'org/infra'==attribute.repository` がある場合、Workload は「repo `org/infra` の environment `terraform-plan`」になる。principal だけでは repo が決まらないため、condition の解釈は必須。
   - `actor` による制限は、Workload の属性（「実行者 ∈ {…}」）として表示する。

### UI での表示階層

GitHub owner → repository → ref / environment / workflow

### 推定結果（`Workload`）

- **ラベル**: `GitHub org/repo (environment: prod)`、`GitHub org/*`、`GitHub 全リポジトリ` のように、範囲の広さがわかる表現にする。
- **制約（constraints）**: claim ごとの `eq` / `ne` / `in` / `startsWith` / `endsWith` / `contains`。principal 由来か condition 由来かを保持する。
- **確度（confidence）**: condition と、推定に使った mapping をすべて解釈できた場合は `exact`、それ以外は `partial`。推定に使っていない mapping が解釈できなくても `exact` のままにする。
- **到達不能（unreachable）**: principal の値と condition が矛盾する場合（例: principal は `org/other` だが condition は `repository == 'org/infra'`）。Lint の対象にする。
- **sub claim の分解**: GitHub の `sub` は `key:value` の組として分解する（`repo:` → repository、`pull_request` は値なし）。カスタマイズされた sub（`repository_owner_id:123:...`）も同じ方法で扱う。
- **CEL の簡易パーサー**: 対応するのは、文字列・真偽値・リスト、参照（`a.b` / `a['b']`）、`==`、`!=`、`in`、`&&`、`||`、`!`、括弧、`startsWith` / `endsWith` / `contains`。トップレベルの AND の各項を解釈し、同じ参照への `==` の OR は `in` にまとめる。解釈できない項は原文のまま残す。

## 7. 実リソースへの展開

### 方式

container（org / folder / project）に付与されたロールを、配下の実リソースに展開する。

1. ロールの permission を service prefix とリソース種別で分類する（例: `storage.objects.get` → `storage` / `objects`）。
2. **permission → アセットタイプの対応表**（ツールに同梱する）を使って、対象のアセットタイプを決める。
3. Cloud Asset `searchAllResources` で、対象アセットタイプのインベントリを **Org 全体で 1 回だけ** 取得し、各リソースの `project` / `folders` / `organization` で container 配下かどうかを判定する（container ごとに API を呼ばない）。
4. リソースそのものに付与されたバインディング（バケットの IAM など）は、手順 4・5 で既に取得済みのため、そのまま使う。

### MVP で対象にするアセットタイプ（案）

Cloud Storage バケット、BigQuery データセット/テーブル、Secret Manager シークレット、Artifact Registry リポジトリ、Cloud Run サービス/ジョブ、Cloud Functions、Pub/Sub トピック/サブスクリプション、Compute インスタンス、GKE クラスタ、Cloud SQL インスタンス、KMS キー、Service Account

- 対応表にないものは container 単位のまま表示する（`expanded: false`）。
- 展開後の行数が膨らむため、UI ではデフォルトで「アセットタイプ × container」に集約して表示し、ドリルダウンで個別のリソースを見せる。

### Policy Analyzer との比較（PoC 結果）

Cloud Asset `analyzeIamPolicy`（Policy Analyzer）を PoC で試した結果は以下のとおり。

| 項目 | 結果 |
|---|---|
| WIF の principalSet を identity に指定 | **結果 0 件**（エラーにはならないが、マッチしない）。WIF 起点の探索には使えない |
| SA を identity に指定 | 動作する。org レベルの付与も実リソースまで展開される |
| 粒度 | 非常に細かい（Docker イメージのダイジェスト単位まで出る）。ACL がバインディングごとに出るので重複も多い（例: 1 SA で 4,531 件） |
| 実行時間 | SA 1 件あたり 2〜35 秒（付与範囲の広さによる） |
| クォータ | quota project あたり 200 回/日、100 回/分（`AnalyzeIamPolicy Requests`） |

**決定**: impersonation の探索もリソース展開も自前で行う（方式 (a)）。Policy Analyzer は `collect --verify` オプションで、到達した SA を対象に (a) の結果と突き合わせる検証用に残す（15 章の PoC 第 2 段の結果による）。

- 将来、IAM Conditions を評価したくなった場合は、Policy Analyzer の利用を再検討する（Policy Analyzer は条件を評価できる）。

## 7.5 `actAs` 権限の検出

`iam.serviceAccounts.actAs` を持つ identity は、SA をアタッチしたリソース（Cloud Run、Compute など）をデプロイすれば、間接的にその SA の権限を得られる可能性がある。
MVP では、実際にデプロイできるかまでは判定せず、**actAs を持っていること**の検出と提示にとどめる。

- WIF から到達できる identity（Principal と impersonation 先の SA）について、`iam.serviceAccounts.actAs` を含むバインディングを `CAN_ACT_AS` エッジとして記録する。
- container レベルの付与は、impersonation と同じく配下の全 SA に展開する。
- `CAN_ACT_AS` は探索の対象にせず、EffectiveAccess にも含めない。actAs 先の SA が持つ権限は「潜在的に到達できる権限」として、詳細パネルで参考表示する。
- Lint `act-as-reachable` で警告し、対応推奨リスト（9 章）に載せる。

## 8. 差分（diff）

- **比較単位**:
  - EffectiveAccess の行の追加・削除（キーは workloadId + resource + role + path）
  - 設定の変更（Provider の mapping / condition、Pool / Provider の有効・無効）
  - Lint の新規発生・解消
- **CLI**: `wif-viz diff` で text / json / markdown（PR や Slack に貼る用）を出力する。
- **UI**: `serve --base` で差分モードにし、追加された経路を緑、削除された経路を赤でハイライトする。差分の行だけを表示するフィルタを用意する。
- スナップショットの `schemaVersion` が異なる場合はエラーにする（マイグレーションは後続）。

## 9. Web UI

- **グラフビュー**: 左から右へ Workload → Pool/Provider → Principal → SA（多段）→ Container/Resource のレイヤー表示。
  - **フォーカス表示（デフォルト）**: Workload、SA、リソースなどを 1 つ選び、そのノードを通る経路（上流と下流）のサブグラフだけをレイアウトして表示する。フォーカス中にノードをクリックすると、そのノードを中心に表示し直す（ドリルダウン）。対応推奨リストや検索からの遷移先もこの表示にする。
  - **概観表示**: Org 全体を表示する。Workload → SA の層までに集約し、リソースは表示しない（目安として 600 ノード以内に収める）。ノードを選択すると経路をハイライトし、フォーカス表示へ移れる。
  - リソースのまとまり（resourceGroup）は「identity × 付与箇所 × アセットタイプ」の単位で作る。付与箇所だけで作ると、同じ container に権限を持つ別の identity の分までハイライトが広がるため。
- **検索/フィルタ**: Workload、SA、リソース、ロール、プロジェクト、アセットタイプで絞り込む。フォワード / リバースを切り替えられる。
- **テーブルビュー**: EffectiveAccess の一覧。CSV でエクスポートできる。
- **対応推奨リスト**: Lint の結果を「やることリスト」として見せる画面（下記）。
- **差分モード**: 8 章のとおり。

### 対応推奨リスト

Lint の検出結果を、重要度の高い順に「対応したほうがいい項目」として並べる。UI のトップ画面（ダッシュボード）にする。

- **集約**: 同じ原因（同じバインディング、同じ Provider）による検出は 1 項目にまとめ、影響範囲を件数で示す（例: 「このバインディングにより 3 repo が 42 リソースに到達できる」）。
- **各項目に表示する内容**:
  - 重要度、ルール名、何が問題か（1 文）
  - 原因となっている設定（バインディング / Provider）と、それが付与されている場所
  - 影響を受ける Workload とリソースの件数（クリックでグラフ / テーブルに絞り込んで遷移する）
  - 推奨される対応（ルールごとの定型文。例:「attributeCondition に `assertion.repository_owner_id == '...'` を追加する」）
  - 参考にすべき `gcloud` コマンドや Terraform の修正例（任意。ツールが実行することはない）
- **フィルタ / ソート**: 重要度、ルール、プロジェクト、Workload で絞り込みや並べ替えができる。
- **ステータス管理**（任意）: 「対応予定」「許容（理由メモ付き）」をローカルファイル（`.wif-viz/triage.json`）に保存し、許容済みの項目は非表示にできる。キーは検出結果の決定的な ID とし、スナップショットを更新しても引き継ぐ。
- **差分との連携**: 差分モードでは、「新たに発生した項目」と「解消された項目」にバッジを付けて表示する。

### Lint ルール（初期案）

| ID | 内容 | 重要度 | 推奨される対応 |
|---|---|---|---|
| `wildcard-principal-set` | `principalSet://…/*` に権限が付与されている | high | attribute で絞った principalSet に置き換える |
| `github-missing-attribute-condition` | GitHub Provider に attributeCondition がない（他の組織のリポジトリからも通る） | high | owner / repo の ID で条件を設定する |
| `github-name-based-trust` | repository / owner の名前でのみ信頼しており、ID（`repository_id` / `repository_owner_id`）を使っていない（名前の再取得による乗っ取りのリスク） | medium | ID ベースの mapping / condition に移行する |
| `primitive-role` | WIF 経由で owner / editor に到達できる | high | 必要な predefined ロールに絞る |
| `act-as-reachable` | WIF 経由で `iam.serviceAccounts.actAs` を持つ identity に到達できる | medium（actAs 先の SA が強い権限を持つ場合は high） | actAs の付与範囲を特定の SA に限定する |
| `deep-impersonation-chain` | impersonation の連鎖が 2 段以上ある | medium | 直接必要な SA に workloadIdentityUser を付与する |
| `org-level-token-creator` | folder / org レベルで impersonation 権限が付与されている | high | SA 単位の付与に置き換える |
| `disabled-but-bound` | 無効化された Pool / Provider / SA へのバインディングが残っている | low | 不要なバインディングを削除する |
| `dangling-principal` | 存在しない Pool を参照するバインディングがある | medium | 不要なバインディングを削除する |
| `iam-admin-reachable` | WIF 経由で IAM を書き換えられるロール（`*.setIamPolicy`、`resourcemanager.organizationAdmin`、`resourcemanager.projectIamAdmin`、`iam.serviceAccountAdmin`、`iam.workloadIdentityPoolAdmin` など）に到達できる。実質的に権限を際限なく拡大できる | high | 付与範囲を限定する、environment の保護ルール（required reviewers）を必須にする |
| `github-actor-based-trust` | condition が `actor`（ユーザー名）に依存している。actor は名前ベースで、workflow の再実行者によっても変わる | low | owner / repo の ID と environment で制限する |

## 10. 技術スタック（案）

- Node.js 22+ / TypeScript / pnpm workspaces
  - `packages/core`: 型定義、グラフ構築、impersonation の探索、リソース展開、Workload 推定、Lint、差分（API に依存しない純粋なロジック）
  - `packages/collector`: `@google-cloud/asset`、`googleapis`（iam v1）。レート制限とリトライを扱う。
  - `packages/web`: Vite + React + **React Flow（`@xyflow/react`）+ elkjs**。レイアウトは Web Worker で計算する（16 章の PoC 結果による）
  - `packages/cli`: `collect` / `serve` / `diff`
- テスト: Vitest。API レスポンスの fixture を使って core を重点的にテストする。

## 11. 非機能要件

- 読み取り専用であり、GCP に対して書き込みは一切しない。
- `serve` は localhost のみで待ち受ける。
- 規模の目安として、プロジェクト数百・バインディング数千で 10 分以内に収集を終える。リソース展開は対象アセットタイプを絞り、並列実行とリトライで対処する。

## 12. 未決事項

- [ ] 展開対象アセットタイプの最終リスト（`searchAllResources` で検索可能なタイプに限る。対応表のテストで検証する）

## 13. マイルストーン（案）

1. **PoC**: collect の API 検証（principalSet の検索クエリ、Policy Analyzer の可否、規模感）
2. **core**: グラフ構築、impersonation の探索、GitHub の推定、EffectiveAccess の生成（fixture でテスト）
3. **リソース展開と Lint**
4. **Web UI**（対応推奨リスト、グラフ、テーブル）
5. **diff**（CLI、UI の差分モード）

## 14. PoC 結果（2026-10-19、第 1 段）

`poc/src/probe.ts` で、個人 Org（10 プロジェクト、1,519 リソース）に対して実行した。

| 指標 | 値 |
|---|---|
| Pool / Provider | 3 / 3（すべて GitHub Actions） |
| WIF principal を含むバインディング | 4 件（すべて SA への `workloadIdentityUser`、principalSet） |
| 抽出されたエッジ | HAS_ROLE 44 / CAN_ACT_AS 28 / CAN_IMPERSONATE 5（self-loop 1 件を含む） |
| 出現したロール | 36 |
| 収集時間（Policy Analyzer を除く） | 約 41 秒。内訳の大半は `roles.get`（直列で 18 秒）と `providers.get`（8 秒） |

### わかったこと

- `policy:workloadIdentityPools` で WIF のバインディングをまとめて取得できる。
- Policy Analyzer は WIF principal を扱えない（7 章）。
- container レベルの `iam.serviceAccountUser` を展開すると `CAN_ACT_AS` がすぐに増える（28 件）。UI では「付与箇所 × ロール」で集約して表示する必要がある。
- org レベルのロールを持つ SA に到達できると、展開対象が Org 全体になる。集約表示は必須。
- 実データでも `iam-admin-reachable` に相当する経路が見つかり、Lint の価値が高いことを確認した。
- `roles.get` はキャッシュと並列化で短縮できる。predefined ロールの permission は同梱してもよい。
- pnpm 12 では、依存パッケージのビルドスクリプトを `pnpm-workspace.yaml` の `allowBuilds` で明示する必要がある。

## 15. PoC 結果（2026-10-19、第 2 段: リソース展開方式の比較）

`poc/src/expand.ts` で、第 1 段の出力（到達した 4 つの SA と HAS_ROLE 44 件）を入力に、2 つの方式を比較した。

| | (a) 自前（対応表 + インベントリ） | (b) Policy Analyzer（SA ごと） |
|---|---|---|
| 実効アクセス件数（MVP のアセットタイプに限定） | 273 | 273 |
| 一致 | 273 件すべて一致（片方にしかないもの 0 件） | ← |
| 所要時間 | インベントリ取得 2.6 秒 + 展開 23 ミリ秒 | 46.9 秒（SA 1 件あたり 1.4〜22 秒） |
| API 呼び出し | インベントリ 1 回（ページング） | SA の数だけ（クォータ 200 回/日） |
| 生の出力 | — | 8,642 件（Docker イメージなどの下位リソースや、バインディングごとの重複を含む）→ フィルタ後 275 件 |

### 結論

- 対象範囲では (a) と (b) の結果が完全に一致し、(a) は約 18 倍速く、クォータの制約もない。**(a) を採用する。**
- (b) は検証用のオプションとして残す。対応表の漏れや誤りを見つけるのに使える。

### 検証できていないこと（実データに存在しなかったもの）

- カスタムロール
- IAM Conditions 付きのバインディング
- folder 階層（この Org には folder がない）
- リソース単位のバインディング（今回はすべて org / project への付与だった）

これらは fixture を作って core のテストで確認する。可能であれば、より大きな Org で `--verify` を実行して対応表の漏れを確認する。

### その他

- `cloudscheduler.googleapis.com/Job` は `searchAllResources` で検索できなかった（INVALID_ARGUMENT）。対応表のアセットタイプは、検索可能なタイプの一覧と照合するテストを用意する。

## 16. PoC 結果（2026-10-19、描画ライブラリの比較）

`poc/viz`（Vite + React）で、React Flow（`@xyflow/react` 12）と Cytoscape.js（3.34）を比較した。

### 条件

- レイアウトは両方とも elkjs（layered、左→右）で同じ座標を計算し、各ライブラリには描画だけを担当させた。
- 経路ハイライトは同じ関数（上流と下流の BFS）を使った。
- 開発モードの Chrome で計測した。ズームはホイールイベントを 90 フレーム送ったときのフレーム時間。

| データ | ノード / エッジ | ELK レイアウト | | React Flow | Cytoscape.js |
|---|---|---|---|---|---|
| real | 89 / 103 | 0.1 秒 | 初回描画 | 663 ms | 66 ms |
| | | | ハイライト | — | 17 ms |
| synthetic-m | 592 / 913 | 0.6 秒 | 初回描画 | 667 ms | 220 ms |
| | | | ハイライト | 365 ms | 87 ms |
| | | | ズーム（p50 / p95） | 15 / 63 ms | 8 / 18 ms |
| | | | ヒープ / DOM 要素数 | 228 MB / 7,132 | 132 MB / 38 |
| synthetic-l | 3,067 / 4,878 | **7〜8 秒** | 初回描画 | 1,793 ms | 848 ms |
| | | | ハイライト | 923 ms | 254 ms |
| | | | ズーム（p50 / p95） | 61 / 218 ms（カクつく） | 38 / 54 ms |
| | | | ヒープ / DOM 要素数 | 746 MB / 25,708 | 458 MB / 38 |

### わかったこと

- **性能は Cytoscape.js が全規模で優位。** 3,000 ノード規模でも操作できる。React Flow は 600 ノード程度までなら実用的だが、3,000 ノードではズームがカクつく。
- **ノードの見た目は React Flow が作りやすい。** ノードは React コンポーネントなので、Lint バッジ、展開ボタン、ツールチップを自由に作れる。Cytoscape.js は canvas 描画なので、リッチなノードには HTML オーバーレイの拡張が必要。
- **ライブラリより UX 設計の影響が大きい。** 実データ（89 ノード）でも全体表示は読みにくい。特に、org レベルの container から大量の resourceGroup へ扇状にエッジが伸びる。
  - デフォルトは**フォーカス表示**（Workload やリソースを選び、その経路のサブグラフだけを表示する）にするべき。全体表示は概観用。
  - container 配下の resourceGroup は identity 間で共有されるため、ハイライトが広がりすぎる。resourceGroup は「identity × container × アセットタイプ」の単位で作る。
- **ELK は大規模データでは重い。** 3,000 ノードで 7〜8 秒かかるので、Web Worker で実行するか、フォーカス表示のサブグラフだけをレイアウトする。

### 決定

**React Flow + elkjs を採用する。**

- フォーカス表示をデフォルトにすれば、表示されるノードは多くの場合数百以下で、その規模なら React Flow でも十分な速さで動く。
- ノードを React コンポーネントとして作れるので、Lint バッジ、ロール一覧、展開ボタン、対応推奨リストとの連携を作りやすい。
- 実際に PoC の画面を触ったうえで判断した。
- 数千ノードの全体表示が必要になった場合は、概観表示だけ Cytoscape.js に切り替えることを検討する。
