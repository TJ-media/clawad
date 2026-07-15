const SENSITIVE_KEY_PARTS = [
  'password',
  'secret',
  'token',
  'authorization',
  'cookie',
  'email',
  'subject',
  'handoffcode',
  'oauthcode',
  'authorizationcode',
  'projectpath',
  'filepath',
  'filename',
  'prompt',
  'terminalcommand',
] as const;

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

function sensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (normalized === 'state' || normalized === 'code') return true;
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

/** 자유 문자열에 실수로 포함된 대표 인증정보·PII를 고정 마커로 바꾼다. */
function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, '***')
    .replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '***')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '***')
    .replace(/(?:client[\s_-]*secret|access[\s_-]*token|refresh[\s_-]*token)\s*[:=]\s*[^\s,;]+/gi, '***')
    .replace(/[A-Za-z]:\\[^\s,;]+|\/(?:Users|home|workspace|private|tmp)\/[^\s,;]+/g, '***')
    .slice(0, 500);
}

/**
 * 감사로그·알림용 재귀 sanitizer. 원본 객체를 바꾸지 않고 깊이·개수를 제한한다.
 * 민감 키는 값의 형태와 무관하게 전부 마스킹한다.
 */
export function sanitizeOperationalValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[TRUNCATED]';
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeOperationalValue(item, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 100);

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
    output[key] = sensitiveKey(key) ? '***' : sanitizeOperationalValue(item, depth + 1);
  }
  return output;
}
