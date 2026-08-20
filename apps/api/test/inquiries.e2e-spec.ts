import './setup-env';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { loadPolicy, pricePerImpressionKrw } from '../src/common/policy';
import { AdminRole } from '../src/admin/admin-user.entity';
import { Inquiry, InquiryStatus } from '../src/inquiries/inquiry.entity';
import { loginAsRole, loginBootstrapAdmin } from './admin-helper';

const ADVERTISER = loadPolicy().advertiser;
const PRICE = pricePerImpressionKrw(ADVERTISER.defaultCpmKrw);

/** 통과하는 최소 신청. 각 테스트가 필요한 필드만 덮어쓴다. */
const validBody = (over: Record<string, unknown> = {}) => ({
  creativeText: '개발자를 위한 로그 분석 도구',
  brandName: '테스트광고주',
  depositAmountKrw: ADVERTISER.minDepositKrw,
  depositorName: '김테스트',
  contact: 'advertiser@example.com',
  ...over,
});

describe('CLAW-249 광고 신청 접수 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let settler: string;
  let reviewer: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = app.get<DataSource>(getDataSourceToken());
    const superToken = await loginBootstrapAdmin(app);
    settler = await loginAsRole(app, superToken, AdminRole.SETTLER);
    reviewer = await loginAsRole(app, superToken, AdminRole.REVIEWER);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.getRepository(Inquiry).clear();
  });

  const api = () => request(app.getHttpServer());
  const auth = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);

  it('로그인 없이 접수된다 — 광고주는 우리 서비스 계정이 없다', async () => {
    const res = await api().post('/v1/inquiries').send(validBody()).expect(201);
    expect(res.body.status).toBe(InquiryStatus.RECEIVED);
    expect(res.body.inquiryId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('예상 노출 횟수를 서버가 계산한다 — 클라이언트 값을 받지 않는다', async () => {
    const amount = ADVERTISER.minDepositKrw;
    const res = await api()
      .post('/v1/inquiries')
      // 클라이언트가 보낸 estimatedImpressions는 whitelist 검증에 걸려 거절된다.
      .send(validBody({ depositAmountKrw: amount }))
      .expect(201);
    expect(res.body.pricePerImpressionKrw).toBe(PRICE);
    expect(res.body.estimatedImpressions).toBe(Math.floor(amount / PRICE));
  });

  it('클라이언트가 노출 횟수·단가를 실어 보내면 거절한다 (rules §2)', async () => {
    await api()
      .post('/v1/inquiries')
      .send(validBody({ estimatedImpressions: 999999, pricePerImpressionKrw: 1 }))
      .expect(400);
  });

  it('입금액이 정책 범위를 벗어나면 400이다', async () => {
    await api().post('/v1/inquiries').send(validBody({ depositAmountKrw: ADVERTISER.minDepositKrw - 1 })).expect(400);
    await api().post('/v1/inquiries').send(validBody({ depositAmountKrw: ADVERTISER.maxDepositKrw + 1 })).expect(400);
    await api().post('/v1/inquiries').send(validBody({ depositAmountKrw: -1 })).expect(400);
    // 소수는 IsInt에서 걸린다 — 원 단위 아래를 받지 않는다.
    await api().post('/v1/inquiries').send(validBody({ depositAmountKrw: 10000.5 })).expect(400);
  });

  it('연락처 종류를 서버가 판정하고, 형식이 아니면 거절한다', async () => {
    await api().post('/v1/inquiries').send(validBody({ contact: '010-1234-5678' })).expect(201);
    await api().post('/v1/inquiries').send(validBody({ contact: 'me@example.com' })).expect(201);
    await api().post('/v1/inquiries').send(validBody({ contact: '전화주세요' })).expect(400);
    await api().post('/v1/inquiries').send(validBody({ contact: '02-123-4567' })).expect(400);

    const rows = await dataSource.getRepository(Inquiry).find({ order: { createdAt: 'ASC' } });
    expect(rows.map((r) => r.contactType)).toEqual(['PHONE', 'EMAIL']);
    // 전화번호는 하이픈을 떼고 저장한다 — 운영자가 그대로 걸 수 있게.
    expect(rows[0].contact).toBe('01012345678');
  });

  it('링크는 https만 받는다 — 화면 검증 결과를 믿지 않는다', async () => {
    await api().post('/v1/inquiries').send(validBody({ linkUrl: 'example.com' })).expect(201);
    await api().post('/v1/inquiries').send(validBody({ linkUrl: 'http://example.com' })).expect(400);
    await api().post('/v1/inquiries').send(validBody({ linkUrl: 'javascript:alert(1)' })).expect(400);

    const [row] = await dataSource.getRepository(Inquiry).find();
    expect(row.linkUrl).toBe('https://example.com/');
  });

  it('제어문자와 연속 공백을 정화하고 상한까지 자른다', async () => {
    await api()
      .post('/v1/inquiries')
      .send(validBody({ creativeText: `줄바꿈\n낀\t문구 ${'가'.repeat(80)}`, brandName: '  공백  브랜드  ' }))
      .expect(201);

    const [row] = await dataSource.getRepository(Inquiry).find();
    expect(row.creativeText).not.toMatch(/[\n\t]/);
    expect([...row.creativeText].length).toBe(48);
    expect(row.brandName).toBe('공백 브랜드');
  });

  it('빈 문구·빈 광고주명·빈 예금주는 거절한다', async () => {
    await api().post('/v1/inquiries').send(validBody({ creativeText: '   ' })).expect(400);
    await api().post('/v1/inquiries').send(validBody({ brandName: '' })).expect(400);
    await api().post('/v1/inquiries').send(validBody({ depositorName: ' ' })).expect(400);
  });

  it('허니팟이 차 있으면 성공처럼 응답하되 저장하지 않는다', async () => {
    await api().post('/v1/inquiries').send(validBody({ company: '봇이 채운 값' })).expect(201);
    expect(await dataSource.getRepository(Inquiry).count()).toBe(0);
  });

  it('접수 시점 단가를 박아 둔다 — 정책이 바뀌어도 신청 조건이 남는다', async () => {
    await api().post('/v1/inquiries').send(validBody()).expect(201);
    const [row] = await dataSource.getRepository(Inquiry).find();
    expect(row.pricePerImpressionKrwAtReceipt).toBe(PRICE);
  });

  it('접속 IP를 저장하지 않는다 (rules §6)', () => {
    const columns = dataSource.getMetadata(Inquiry).columns.map((c) => c.propertyName);
    expect(columns).not.toContain('ip');
    expect(columns.some((name) => /ip$|ipAddress|remoteAddr/i.test(name))).toBe(false);
  });

  it('노출 단가는 신청 전용 경로로만 내려간다 — 이용자 정책에 싣지 않는다', async () => {
    const limits = await api().get('/v1/inquiries/limits').expect(200);
    expect(limits.body).toEqual({
      pricePerImpressionKrw: PRICE,
      minDepositKrw: ADVERTISER.minDepositKrw,
      maxDepositKrw: ADVERTISER.maxDepositKrw,
    });
    // 원본 CPM은 어디에도 내려가지 않는다 — 광고주가 적립액과의 관계를 역산할 수 없어야 한다.
    expect(limits.body.defaultCpmKrw).toBeUndefined();

    // 리워드 샵이 읽는 응답에 광고주 단가가 섞이면 사용자 화면에서 둘이 나란히 보인다.
    const policy = await api().get('/v1/policy').expect(200);
    expect(policy.body.advertiser).toBeUndefined();
  });

  it('운영 목록은 연락처를 마스킹하고 예금주는 그대로 보여준다', async () => {
    await api().post('/v1/inquiries').send(validBody({ contact: 'advertiser@example.com' })).expect(201);

    const res = await auth(api().get('/internal/v1/inquiries'), reviewer).expect(200);
    expect(res.body[0].depositorName).toBe('김테스트');
    expect(res.body[0].contactMasked).not.toContain('advertiser@example.com');
    expect(res.body[0].contact).toBeUndefined();
  });

  it('연락처 원문은 감사에 남는 POST로만 연다', async () => {
    await api().post('/v1/inquiries').send(validBody()).expect(201);
    const [row] = await dataSource.getRepository(Inquiry).find();

    await auth(api().post(`/internal/v1/inquiries/${row.id}/contact`), reviewer).expect(403);
    const res = await auth(api().post(`/internal/v1/inquiries/${row.id}/contact`), settler).expect(200);
    expect(res.body.contact).toBe('advertiser@example.com');
  });

  it('운영자만 상태를 전이한다', async () => {
    await api().post('/v1/inquiries').send(validBody()).expect(201);
    const [row] = await dataSource.getRepository(Inquiry).find();

    await api().post(`/internal/v1/inquiries/${row.id}/status`).send({ status: 'RUNNING' }).expect(401);

    const res = await auth(api().post(`/internal/v1/inquiries/${row.id}/status`), settler)
      .send({ status: InquiryStatus.DEPOSIT_CONFIRMED, note: '8/20 입금 확인' })
      .expect(200);
    expect(res.body.status).toBe(InquiryStatus.DEPOSIT_CONFIRMED);
    expect(res.body.note).toBe('8/20 입금 확인');
  });
});
