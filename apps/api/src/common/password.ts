import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LEN = 64;
const SALT_LEN = 16;
const PREFIX = 'scrypt';

/**
 * 비밀번호 해시. node 내장 scrypt만 사용한다 — 네이티브 빌드가 필요한 외부 해시 패키지를 추가하지 않는다.
 * 형식: scrypt$<saltHex>$<hashHex>
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = await scrypt(password, salt, KEY_LEN);
  return `${PREFIX}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** 타이밍 안전 비교. 저장된 해시가 없거나 형식이 깨져도 예외를 던지지 않고 false를 반환한다. */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== PREFIX) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[1], 'hex');
    expected = Buffer.from(parts[2], 'hex');
  } catch {
    return false;
  }
  if (expected.length !== KEY_LEN) return false;

  const actual = await scrypt(password, salt, KEY_LEN);
  return timingSafeEqual(actual, expected);
}
