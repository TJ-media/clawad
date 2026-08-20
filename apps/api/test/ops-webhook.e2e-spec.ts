import './setup-env';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postOpsAlert, resolveWebhookUrl } from '../src/common/ops-webhook';

/**
 * 운영 알림 웹훅 공통부 (CLAW-251). 제보·광고 신청·교환 알림이 모두 이 코드를 쓴다.
 * 이전에는 세 서비스가 같은 코드를 복사해 갖고 있었고 검사가 하나도 없었다.
 */
describe('CLAW-251 운영 알림 웹훅 공통부', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawad-webhook-'));
  const write = (name: string, body: string) => {
    const file = join(dir, name);
    writeFileSync(file, body, 'utf8');
    return file;
  };
  /** 설정 키 → 값 맵을 흉내낸다. */
  const config = (values: Record<string, string>) =>
    ({ get: (key: string) => values[key] }) as unknown as ConfigService;

  describe('URL 해석', () => {
    it('키가 없으면 null — 웹훅 미설정은 오류가 아니다', () => {
      expect(resolveWebhookUrl(config({}), 'A', 'B')).toBeNull();
    });

    it('앞선 키를 우선하고, 비어 있으면 다음 키로 넘어간다', () => {
      const shared = write('shared.txt', 'https://hooks.example.com/shared');
      const own = write('own.txt', 'https://hooks.example.com/own');
      expect(resolveWebhookUrl(config({ OWN: own, SHARED: shared }), 'OWN', 'SHARED')).toBe(
        'https://hooks.example.com/own',
      );
      expect(resolveWebhookUrl(config({ SHARED: shared }), 'OWN', 'SHARED')).toBe(
        'https://hooks.example.com/shared',
      );
    });

    it('파일이 없거나 비어 있으면 null — 던지지 않는다', () => {
      expect(resolveWebhookUrl(config({ A: join(dir, '없는파일.txt') }), 'A')).toBeNull();
      expect(resolveWebhookUrl(config({ A: write('empty.txt', '   \n') }), 'A')).toBeNull();
    });

    // rules §8 — 모든 파일 읽기에서 BOM을 제거한다.
    it('BOM과 개행이 붙어 있어도 읽는다', () => {
      const file = write('bom.txt', '\uFEFFhttps://hooks.example.com/bom\n');
      expect(resolveWebhookUrl(config({ A: file }), 'A')).toBe('https://hooks.example.com/bom');
    });

    it('http(s)가 아닌 스킴은 거부한다', () => {
      for (const raw of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.com/x']) {
        expect(resolveWebhookUrl(config({ A: write('scheme.txt', raw) }), 'A')).toBeNull();
      }
    });

    it('URL 형식이 아니면 null', () => {
      expect(resolveWebhookUrl(config({ A: write('bad.txt', 'hooks.example.com/노스킴') }), 'A')).toBeNull();
    });
  });

  describe('전송', () => {
    const logger = new Logger('테스트');
    const original = global.fetch;
    afterEach(() => { global.fetch = original; });

    it('{text} 한 필드만 JSON으로 보낸다', async () => {
      let seen: { url: string; body: unknown } | null = null;
      global.fetch = (async (url: string, init: RequestInit) => {
        seen = { url, body: JSON.parse(String(init.body)) };
        return { ok: true, status: 200 } as Response;
      }) as unknown as typeof fetch;

      await expect(postOpsAlert('https://hooks.example.com/x', '내용', logger, '라벨')).resolves.toBe(true);
      expect(seen!.url).toBe('https://hooks.example.com/x');
      expect(seen!.body).toEqual({ text: '내용' });
    });

    // 알림 실패가 본 작업(제보·신청·교환 저장)을 되돌리면 사용자가 한 일이 사라진다.
    it('수신기가 4xx·5xx여도 던지지 않고 false', async () => {
      global.fetch = (async () => ({ ok: false, status: 500 }) as Response) as unknown as typeof fetch;
      await expect(postOpsAlert('https://hooks.example.com/x', '내용', logger, '라벨')).resolves.toBe(false);
    });

    it('네트워크가 죽어도 던지지 않고 false', async () => {
      global.fetch = (async () => { throw new Error('연결 실패'); }) as unknown as typeof fetch;
      await expect(postOpsAlert('https://hooks.example.com/x', '내용', logger, '라벨')).resolves.toBe(false);
    });
  });
});
