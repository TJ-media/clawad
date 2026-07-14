import { NaverProvider } from '../src/auth/social/naver.provider';

describe('Naver OAuth secret 전송', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('authorization code와 client secret을 URL이 아닌 POST 본문으로 전송한다', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      if (calls.length === 1) return new Response(JSON.stringify({ access_token: 'provider-access-token' }), { status: 200 });
      return new Response(JSON.stringify({ resultcode: '00', response: { id: 'provider-subject' } }), { status: 200 });
    }) as typeof fetch;

    const provider = new NaverProvider({ clientId: 'client-id', clientSecret: 'client-secret' });
    await expect(provider.verify({
      code: 'authorization-code',
      redirectUri: 'https://api.example.com/v1/auth/social/naver/callback',
    })).resolves.toEqual({ subject: 'provider-subject' });

    expect(calls[0].input).toBe('https://nid.naver.com/oauth2.0/token');
    expect(calls[0].input).not.toContain('client-secret');
    expect(calls[0].input).not.toContain('authorization-code');
    const body = calls[0].init?.body as URLSearchParams;
    expect(body.get('client_secret')).toBe('client-secret');
    expect(body.get('code')).toBe('authorization-code');
  });
});
