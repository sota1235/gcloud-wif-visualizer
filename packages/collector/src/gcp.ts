import { AssetServiceClient, protos } from '@google-cloud/asset';
import { GoogleAuth } from 'google-auth-library';

type ResourceSearchResult = protos.google.cloud.asset.v1.IResourceSearchResult;
type IamPolicySearchResult = protos.google.cloud.asset.v1.IIamPolicySearchResult;

export interface GcpClientOptions {
  /** API の課金・クォータを付ける project（ADC の quota project を上書きする） */
  quotaProject?: string;
  /** 同時に実行する API 呼び出しの上限 */
  concurrency?: number;
  /** リトライの最大回数 */
  maxRetries?: number;
}

// gRPC の RESOURCE_EXHAUSTED / UNAVAILABLE / DEADLINE_EXCEEDED、HTTP の 429 / 5xx をリトライする
const RETRYABLE_GRPC_CODES = new Set([4, 8, 14]);

function isRetryable(error: unknown): boolean {
  const e = error as { code?: unknown; status?: unknown; response?: { status?: number } };
  if (typeof e.code === 'number' && RETRYABLE_GRPC_CODES.has(e.code)) return true;
  const status = e.response?.status ?? (typeof e.status === 'number' ? e.status : undefined);
  return status === 429 || (status !== undefined && status >= 500);
}

/** 同時実行数を制限する */
function createLimiter(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

export interface GcpClient {
  searchResources(scope: string, assetTypes: string[]): Promise<ResourceSearchResult[]>;
  searchIamPolicies(scope: string, query: string): Promise<IamPolicySearchResult[]>;
  /** IAM REST API（v1）の GET。404 の場合は undefined */
  iamGet<T>(path: string): Promise<T | undefined>;
  /** 呼び出し回数（ログ用） */
  stats: Record<string, number>;
}

export function createGcpClient(options: GcpClientOptions = {}): GcpClient {
  // google-auth-library は GOOGLE_CLOUD_QUOTA_PROJECT を quota project として使う
  if (options.quotaProject) process.env.GOOGLE_CLOUD_QUOTA_PROJECT = options.quotaProject;
  const asset = new AssetServiceClient();
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const limit = createLimiter(options.concurrency ?? 8);
  const maxRetries = options.maxRetries ?? 5;
  const stats: Record<string, number> = {};

  const call = <T>(label: string, task: () => Promise<T>) =>
    limit(async () => {
      stats[label] = (stats[label] ?? 0) + 1;
      for (let attempt = 0; ; attempt++) {
        try {
          return await task();
        } catch (error) {
          if (attempt >= maxRetries || !isRetryable(error)) throw error;
          const delay = Math.min(30_000, 500 * 2 ** attempt) * (0.5 + Math.random());
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    });

  return {
    stats,
    searchResources: (scope, assetTypes) =>
      call('searchAllResources', async () => {
        const results: ResourceSearchResult[] = [];
        for await (const r of asset.searchAllResourcesAsync({ scope, assetTypes, pageSize: 500 }, { autoPaginate: false })) results.push(r);
        return results;
      }),
    searchIamPolicies: (scope, query) =>
      call('searchAllIamPolicies', async () => {
        const results: IamPolicySearchResult[] = [];
        for await (const r of asset.searchAllIamPoliciesAsync({ scope, query, pageSize: 500 }, { autoPaginate: false })) results.push(r);
        return results;
      }),
    iamGet: <T>(path: string) =>
      call('iam.get', async () => {
        const client = await auth.getClient();
        try {
          const res = await client.request<T>({ url: `https://iam.googleapis.com/v1/${path}` });
          return res.data;
        } catch (error) {
          if ((error as { response?: { status?: number } }).response?.status === 404) return undefined;
          throw error;
        }
      }),
  };
}
