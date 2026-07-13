import './setup-env';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { loadPolicy } from '../src/common/policy';
import { Machine, MachineStatus } from '../src/entities/machine.entity';
import { seedUser } from './social-helper';

const MAX_DEVICES = loadPolicy().device.maxDevicesPerAccount;

const newMachineId = () => randomBytes(16).toString('hex');

describe('CLAW-22 인증·머신 등록 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = app.get<DataSource>(getDataSourceToken());
  });

  afterAll(async () => {
    await app.close();
  });

  // 공개 로그인은 소셜 전용이다(CLAW-37). 머신 등록 검증용 사용자는 seedUser로 만든다.
  const signup = async () => {
    const { accessToken, refreshToken } = await seedUser(app);
    return { accessToken, refreshToken };
  };

  const registerMachine = (accessToken: string, machineId: string) =>
    request(app.getHttpServer())
      .post('/v1/machines')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ machineId });

  describe('세션 발급', () => {
    it('시드된 사용자는 access/refresh 토큰 쌍을 받는다', async () => {
      const tokens = await signup();
      expect(tokens.accessToken).toBeTruthy();
      expect(tokens.refreshToken).toContain('.');
    });
  });

  describe('refresh 토큰 회전', () => {
    it('refresh 하면 새 쌍을 주고 기존 refresh 토큰은 폐기된다', async () => {
      const { refreshToken } = await signup();

      const rotated = await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refreshToken })
        .expect(200);
      expect(rotated.body.refreshToken).not.toBe(refreshToken);

      // 재사용 시도 → 401
      await request(app.getHttpServer()).post('/v1/auth/refresh').send({ refreshToken }).expect(401);
    });
  });

  describe('머신 등록', () => {
    it('machineId가 32자리 hex가 아니면 400 (하드웨어 식별자 차단)', async () => {
      const { accessToken } = await signup();
      await registerMachine(accessToken, '00:11:22:33:44:55').expect(400);
      await registerMachine(accessToken, 'AABBCCDDEEFF00112233445566778899').expect(400); // 대문자
    });

    it('같은 기기를 다시 등록해도 멱등이며 슬롯을 추가로 쓰지 않는다', async () => {
      const { accessToken } = await signup();
      const machineId = newMachineId();

      await registerMachine(accessToken, machineId).expect(200);
      await registerMachine(accessToken, machineId).expect(200);

      const list = await request(app.getHttpServer())
        .get('/v1/machines')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(list.body).toHaveLength(1);
    });

    it(`${MAX_DEVICES}대를 초과하면 409 MACHINE_LIMIT_EXCEEDED`, async () => {
      const { accessToken } = await signup();
      for (let i = 0; i < MAX_DEVICES; i++) {
        await registerMachine(accessToken, newMachineId()).expect(200);
      }
      const res = await registerMachine(accessToken, newMachineId()).expect(409);
      expect(res.body.error).toBe('MACHINE_LIMIT_EXCEEDED');
      expect(res.body.limit).toBe(MAX_DEVICES);
    });

    it('동시 등록 요청에서도 상한을 넘기지 않는다 (트랜잭션·행 잠금)', async () => {
      const { accessToken } = await signup();
      const ids = Array.from({ length: MAX_DEVICES + 3 }, () => newMachineId());

      const results = await Promise.all(ids.map((id) => registerMachine(accessToken, id)));
      const ok = results.filter((r) => r.status === 200);
      const conflict = results.filter((r) => r.status === 409);

      expect(ok).toHaveLength(MAX_DEVICES);
      expect(conflict).toHaveLength(3);
    });

    it('해제하면 슬롯이 반환되고 행은 RELEASED로 남는다 (삭제 아님)', async () => {
      const { accessToken } = await signup();
      const first = newMachineId();
      await registerMachine(accessToken, first).expect(200);
      for (let i = 1; i < MAX_DEVICES; i++) {
        await registerMachine(accessToken, newMachineId()).expect(200);
      }
      await registerMachine(accessToken, newMachineId()).expect(409);

      await request(app.getHttpServer())
        .delete(`/v1/machines/${first}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      // 슬롯이 비었으므로 새 기기 등록 성공
      await registerMachine(accessToken, newMachineId()).expect(200);

      const rows = await dataSource.getRepository(Machine).find({ where: { machineId: first } });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe(MachineStatus.RELEASED);
    });
  });

  describe('차단된 머신', () => {
    it('차단된 머신 헤더로 인증하면 403 MACHINE_BLOCKED', async () => {
      const { accessToken } = await signup();
      const machineId = newMachineId();
      await registerMachine(accessToken, machineId).expect(200);

      await dataSource
        .getRepository(Machine)
        .update({ machineId }, { status: MachineStatus.BLOCKED, blockedAt: new Date(), blockedReason: 'TEST' });

      const res = await request(app.getHttpServer())
        .get('/v1/machines')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('x-clawad-machine-id', machineId)
        .expect(403);
      expect(res.body.error).toBe('MACHINE_BLOCKED');
    });

    it('차단된 머신은 사용자가 스스로 해제할 수 없다 (403)', async () => {
      const { accessToken } = await signup();
      const machineId = newMachineId();
      await registerMachine(accessToken, machineId).expect(200);
      await dataSource.getRepository(Machine).update({ machineId }, { status: MachineStatus.BLOCKED });

      await request(app.getHttpServer())
        .delete(`/v1/machines/${machineId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
    });
  });

  describe('다계정 (CLAW-19)', () => {
    it('같은 machineId를 다른 계정이 등록해도 차단하지 않는다 — 위험 신호일 뿐', async () => {
      const a = await signup();
      const b = await signup();
      const shared = newMachineId();

      await registerMachine(a.accessToken, shared).expect(200);
      // 자동 차단·자동 부정 처리 금지. 두 번째 계정도 정상 등록된다.
      await registerMachine(b.accessToken, shared).expect(200);
    });
  });

  describe('인증 경계', () => {
    it('토큰 없이 머신 API 호출 시 401', async () => {
      await request(app.getHttpServer()).get('/v1/machines').expect(401);
      await request(app.getHttpServer()).post('/v1/machines').send({ machineId: newMachineId() }).expect(401);
    });

    it('요청 본문의 userId는 무시된다 (서버가 세션에서 확정)', async () => {
      const { accessToken } = await signup();
      // whitelist+forbidNonWhitelisted → 모르는 필드는 400으로 거절된다.
      await request(app.getHttpServer())
        .post('/v1/machines')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ machineId: newMachineId(), userId: randomUUID() })
        .expect(400);
    });
  });
});
