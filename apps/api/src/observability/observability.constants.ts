export const ROUTE_FAMILIES = [
  '/health',
  '/monitor/v1/metrics',
  '/internal/v1/observability',
  '/v1/auth/social',
  '/v1/auth',
  '/v1/events',
  '/v1/ad-decision',
  '/v1/rewards',
  '/internal/v1/analytics',
  '/internal/v1/kill-switch',
  '/v1/click',
  '/v1/machines',
  '/admin',
  'other',
] as const;

export type RouteFamily = (typeof ROUTE_FAMILIES)[number];

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OTHER'] as const;
export type ObservedHttpMethod = (typeof HTTP_METHODS)[number];

const HTTP_METHOD_SET = new Set<string>(HTTP_METHODS);
export const safeHttpMethod = (value: string): ObservedHttpMethod =>
  HTTP_METHOD_SET.has(value) ? (value as ObservedHttpMethod) : 'OTHER';

/**
 * 원본 URL을 메트릭 label로 쓰지 않는다. OAuth code/state, click token, UUID 등
 * 동적 경로값은 아래의 고정된 저카디널리티 경로군으로만 축약한다.
 */
export function classifyRoute(pathname: string): RouteFamily {
  if (pathname === '/health' || pathname.startsWith('/health/')) return '/health';
  if (pathname.startsWith('/monitor/')) return '/monitor/v1/metrics';
  if (pathname.startsWith('/internal/v1/observability')) return '/internal/v1/observability';
  if (pathname.startsWith('/v1/auth/social/') || pathname.startsWith('/admin/v1/auth/social/')) return '/v1/auth/social';
  if (pathname.startsWith('/v1/auth/') || pathname.startsWith('/admin/v1/auth/')) return '/v1/auth';
  if (pathname === '/v1/events' || pathname.startsWith('/v1/events/')) return '/v1/events';
  if (pathname.startsWith('/v1/ad-decision')) return '/v1/ad-decision';
  if (pathname.startsWith('/v1/rewards') || pathname.startsWith('/internal/v1/rewards')) return '/v1/rewards';
  if (pathname.startsWith('/internal/v1/analytics') || pathname === '/internal/v1/abuse-report') return '/internal/v1/analytics';
  if (pathname.startsWith('/internal/v1/kill-switch')) return '/internal/v1/kill-switch';
  if (pathname.startsWith('/v1/click/')) return '/v1/click';
  if (pathname.startsWith('/v1/machines')) return '/v1/machines';
  if (pathname.startsWith('/admin/') || pathname.startsWith('/internal/')) return '/admin';
  return 'other';
}

export const STATUS_CLASSES = ['1xx', '2xx', '3xx', '4xx', '5xx'] as const;
export type StatusClass = (typeof STATUS_CLASSES)[number];

export function statusClass(statusCode: number): StatusClass {
  if (statusCode >= 500) return '5xx';
  if (statusCode >= 400) return '4xx';
  if (statusCode >= 300) return '3xx';
  if (statusCode >= 200) return '2xx';
  return '1xx';
}

export function safeHttpStatus(statusCode: number): string {
  return Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? String(statusCode) : '500';
}

export const HTTP_LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000] as const;
export const UPLOAD_DELAY_BUCKETS_MS = [
  1_000,
  10_000,
  60_000,
  300_000,
  900_000,
  3_600_000,
  21_600_000,
  86_400_000,
  604_800_000,
] as const;

export const OAUTH_PROVIDERS = ['GOOGLE', 'KAKAO', 'NAVER'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];
export const OAUTH_STAGES = ['start', 'callback', 'exchange'] as const;
export type OAuthStage = (typeof OAUTH_STAGES)[number];

export const OAUTH_OUTCOMES = [
  'SUCCESS',
  'CANCELED',
  'SOCIAL_PROVIDER_UNAVAILABLE',
  'SOCIAL_CODE_EXCHANGE_FAILED',
  'SOCIAL_TOKEN_INVALID',
  'SOCIAL_NONCE_MISMATCH',
  'SOCIAL_SUBJECT_MISSING',
  'SOCIAL_ID_TOKEN_MISSING',
  'SOCIAL_USERINFO_FAILED',
  'SOCIAL_VERIFY_FAILED',
  'PROVIDER_NOT_ENABLED',
  'RETURN_TARGET_NOT_ALLOWED',
  'LINK_REQUIRES_AUTH',
  'PROVIDER_MISMATCH',
  'INVALID_HANDOFF_CODE',
  'USER_SUSPENDED',
  'IDENTITY_ALREADY_LINKED',
  'PROVIDER_ALREADY_LINKED',
  'SIGNUP_REQUIRED',
  'OTHER',
] as const;
export type OAuthOutcome = (typeof OAUTH_OUTCOMES)[number];

const OAUTH_OUTCOME_SET = new Set<string>(OAUTH_OUTCOMES);
export const safeOAuthOutcome = (value: string): OAuthOutcome =>
  OAUTH_OUTCOME_SET.has(value) ? (value as OAuthOutcome) : 'OTHER';

export const IMPRESSION_REASONS = [
  'NONE',
  'BAD_REQUEST',
  'BAD_TOKEN',
  'EXPIRED',
  'TOKEN_USER_MISMATCH',
  'MACHINE_NOT_REGISTERED',
  'MACHINE_NOT_ACTIVE',
  'TOKEN_REUSE',
  'TOKEN_REVOKED',
  'SEQUENCE_ANOMALY',
  'KILLED',
  'BAD_INTERVAL',
  'ABNORMAL_CONTINUOUS',
  'CAMPAIGN_INACTIVE',
  'CONCURRENT_USER_IMPRESSION',
  'IVT',
  'OVER_CAP',
  'OTHER',
] as const;
export type ImpressionReason = (typeof IMPRESSION_REASONS)[number];

const IMPRESSION_REASON_SET = new Set<string>(IMPRESSION_REASONS);
export const safeImpressionReason = (value: unknown): ImpressionReason => {
  if (typeof value !== 'string') return 'OTHER';
  // 운영자가 입력한 상세 reason은 label에 노출하지 않고 고정 저카디널리티 값으로 축약한다.
  if (value.startsWith('IVT:')) return 'IVT';
  return IMPRESSION_REASON_SET.has(value) ? (value as ImpressionReason) : 'OTHER';
};

export const REWARD_ENTRY_TYPES = ['ACCRUE_PENDING', 'ACCRUE_CONFIRM', 'CLAW_BACK'] as const;
export type ObservedRewardEntryType = (typeof REWARD_ENTRY_TYPES)[number];

export const SWITCH_TARGETS = [
  'MACHINE',
  'USER',
  'CAMPAIGN',
  'GLOBAL_ADS',
  'GLOBAL_REWARDS',
  'GLOBAL',
  'OTHER',
] as const;
export type ObservedSwitchTarget = (typeof SWITCH_TARGETS)[number];

const SWITCH_TARGET_SET = new Set<string>(SWITCH_TARGETS);
export const safeSwitchTarget = (value: unknown): ObservedSwitchTarget =>
  typeof value === 'string' && SWITCH_TARGET_SET.has(value) ? (value as ObservedSwitchTarget) : 'OTHER';
