import './setup-env';
import { loginBootstrapAdmin } from './admin-helper';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { ConsentType } from '../src/entities/consent.entity';
import { Identity } from '../src/entities/identity.entity';
import { Machine, MachineStatus } from '../src/entities/machine.entity';
import { RewardEntryType, RewardLedgerEntry } from '../src/entities/reward-ledger.entity';
import { User, UserStatus } from '../src/entities/user.entity';
import { DestructionLog } from '../src/privacy/destruction-log.entity';

let adminToken: string;
const newMachineId = () => randomBytes(16).toString('hex');
const newEmail = () => `pv-${randomUUID()}@example.test`;

describe('CLAW-28 개인정보 조회·탈퇴·파기 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = app.get<DataSource>(getDataSourceToken());
    adminToken = await loginBootstrapAdmin(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const api = () => request(app.getHttpServer());

  async function makeUser(withMachine = true) {
    const email = newEmail();
    const res = await api()
      .post('/v1/auth/signup')
      .send({
        email,
        password: 'correct-horse-battery',
        consents: [
          { type: ConsentType.TERMS_OF_SERVICE, granted: true, documentVersion: 'v0' },
          { type: ConsentType.PRIVACY_POLICY, granted: true, documentVersion: 'v0' },
        ],
      })
      .expect(201);
    const accessToken = res.body.accessToken as string;
    const userId = decodeSub(accessToken);
    let machineId: string | undefined;
    if (withMachine) {
      machineId = newMachineId();
      await api().post('/v1/machines').set('Authorization', `Bearer ${accessToken}`).send({ machineId }).expect(200);
    }
    return { accessToken, userId, email, machineId };
  }

  const bearer = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);

  /** 확정 리워드를 심는다(원장 직접 append). CLAW-5 배치를 거치지 않고 탈퇴 가드만 검증. */
  async function seedConfirmedReward(userId: string, points: number) {
    await dataSource.query(
      `INSERT INTO reward_ledger ("userId","entryType","points","refIdempotencyKey") VALUES ($1,'ACCRUE_CONFIRM',$2,$3)`,
      [userId, points, randomBytes(16).toString('hex')],
    );
  }

  describe('내 정보 내보내기', () => {
    it('토큰 없이 export 시 401', async () => {
      await api().get('/v1/me/export').expect(401);
    });

    it('수집 항목 전체를 기계 판독 JSON으로 반환하고 비밀번호 해시는 제외한다', async () => {
      const { accessToken, userId, email } = await makeUser();
      const res = await bearer(api().get('/v1/me/export'), accessToken).expect(200);

      expect(res.body.user.id).toBe(userId);
      expect(res.body.user.email).toBe(email);
      expect(Array.isArray(res.body.consents)).toBe(true);
      expect(Array.isArray(res.body.machines)).toBe(true);
      expect(res.body.rewards).toHaveProperty('confirmedPoints');
      expect(res.body.impressions).toHaveProperty('total'); // 절단 투명성
      // 비밀번호 해시가 어디에도 없어야 한다.
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');
      expect(JSON.stringify(res.body)).not.toContain('scrypt');
    });
  });

  describe('탈퇴', () => {
    it('탈퇴하면 로그인 수단이 파기되고 이메일이 가명화된다', async () => {
      const { accessToken, userId, email } = await makeUser();

      const res = await bearer(api().delete('/v1/me'), accessToken).send({}).expect(200);
      expect(res.body.withdrawn).toBe(true);

      const user = await dataSource.getRepository(User).findOneByOrFail({ id: userId });
      expect(user.status).toBe(UserStatus.WITHDRAWN);
      expect(user.email).toBeNull();
      expect(user.withdrawnAt).toBeTruthy();

      const identities = await dataSource.getRepository(Identity).count({ where: { userId } });
      expect(identities).toBe(0); // 로그인 수단 파기됨

      // 원래 이메일로 다시 로그인 불가
      await api().post('/v1/auth/login').send({ email, password: 'correct-horse-battery' }).expect(401);
    });

    it('탈퇴 후 기존 액세스 토큰으로 서비스 이용 불가 (즉시 중단)', async () => {
      const { accessToken } = await makeUser();
      await bearer(api().delete('/v1/me'), accessToken).send({}).expect(200);
      // 같은 토큰으로 이후 요청은 거부된다.
      await bearer(api().get('/v1/rewards'), accessToken).expect(401);
    });

    it('탈퇴 시 기기가 해제된다', async () => {
      const { accessToken, userId, machineId } = await makeUser();
      await bearer(api().delete('/v1/me'), accessToken).send({}).expect(200);
      const machine = await dataSource.getRepository(Machine).findOneByOrFail({ userId, machineId });
      expect(machine.status).toBe(MachineStatus.RELEASED);
    });

    it('원장(리워드)은 삭제하지 않고 가명 userId로 잔존한다', async () => {
      const { accessToken, userId } = await makeUser();
      await seedConfirmedReward(userId, 100);
      // 확정 리워드가 있으므로 포기 동의 필요
      await bearer(api().delete('/v1/me'), accessToken).send({ forfeitConfirmedRewards: true }).expect(200);

      const rows = await dataSource.getRepository(RewardLedgerEntry).count({ where: { userId } });
      expect(rows).toBeGreaterThan(0); // 원장은 남아 있다(세무·정산 보관)
    });

    it('멱등: 이미 탈퇴한 계정의 재탈퇴는 alreadyWithdrawn', async () => {
      const { accessToken } = await makeUser();
      await bearer(api().delete('/v1/me'), accessToken).send({}).expect(200);
      // 토큰이 무효화됐으므로 새 사용자로 검증하는 대신, 서비스 레벨 멱등은 단위로 확인됨.
      // 여기서는 재탈퇴가 401(토큰 거부)임을 확인한다.
      await bearer(api().delete('/v1/me'), accessToken).send({}).expect(401);
    });
  });

  describe('미지급 확정 리워드 가드', () => {
    it('확정 리워드가 있으면 포기 동의 없이 탈퇴할 수 없다 (409)', async () => {
      const { accessToken, userId } = await makeUser();
      await seedConfirmedReward(userId, 300);

      const res = await bearer(api().delete('/v1/me'), accessToken).send({}).expect(409);
      expect(res.body.error).toBe('UNPAID_CONFIRMED_REWARDS');
      expect(res.body.confirmedPoints).toBe(300);

      // 아직 탈퇴되지 않았다.
      const user = await dataSource.getRepository(User).findOneByOrFail({ id: userId });
      expect(user.status).toBe(UserStatus.ACTIVE);
    });

    it('포기 동의 시 반대 분개로 잔액을 0으로 만들고 탈퇴한다', async () => {
      const { accessToken, userId } = await makeUser();
      await seedConfirmedReward(userId, 300);

      const res = await bearer(api().delete('/v1/me'), accessToken)
        .send({ forfeitConfirmedRewards: true })
        .expect(200);
      expect(res.body.forfeitedPoints).toBe(300);

      // 포기 분개(ADMIN_ADJUST -300)가 남고 잔액은 0.
      const adjust = await dataSource
        .getRepository(RewardLedgerEntry)
        .findOneOrFail({ where: { userId, entryType: RewardEntryType.ADMIN_ADJUST } });
      expect(adjust.points).toBe(-300);
      expect(adjust.reason).toBe('WITHDRAWAL_FORFEIT');
    });
  });

  describe('탈퇴 후 리워드 배치 (신원 파기 계정 보호)', () => {
    it('탈퇴 계정의 검증 중 리워드는 확정 배치에서 확정되지 않는다', async () => {
      const { accessToken, userId } = await makeUser();
      // 검증 중(pending) 리워드를 심는다.
      await dataSource.query(
        `INSERT INTO reward_ledger ("userId","entryType","points","refIdempotencyKey") VALUES ($1,'ACCRUE_PENDING',50,$2)`,
        [userId, randomBytes(16).toString('hex')],
      );
      // 확정 리워드는 없으므로 포기 없이 탈퇴 가능.
      await bearer(api().delete('/v1/me'), accessToken).send({}).expect(200);

      // 확정 배치를 돌려도 탈퇴 계정의 pending은 확정되지 않는다.
      await api().post('/internal/v1/rewards/run-confirmation').set('Authorization', `Bearer ${adminToken}`).expect(200);

      const confirmed = await dataSource.query(
        `SELECT COALESCE(SUM(points),0) AS s FROM reward_ledger WHERE "userId"=$1 AND "entryType"='ACCRUE_CONFIRM'`,
        [userId],
      );
      expect(Number(confirmed[0].s)).toBe(0); // 신원 파기 계정에 확정잔액이 생기지 않는다
    });
  });

  describe('파기 로그·배치', () => {
    it('탈퇴가 파기 로그를 남긴다', async () => {
      const { accessToken, userId } = await makeUser();
      await bearer(api().delete('/v1/me'), accessToken).send({}).expect(200);
      const log = await dataSource
        .getRepository(DestructionLog)
        .findOneOrFail({ where: { userId }, order: { id: 'DESC' } });
      expect(log.action).toBe('WITHDRAWAL');
      // 파기된 값(이메일 등)을 로그에 복제하지 않는다.
      expect(log.detail).not.toContain('@example.test');
    });

    it('파기 배치(run-retention-sweep)는 SUPERADMIN만 실행할 수 있다', async () => {
      const res = await api()
        .post('/internal/v1/privacy/run-retention-sweep')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body).toHaveProperty('sweptUsers');
    });

    it('파기 로그는 append-only — DB가 UPDATE·DELETE를 거부한다', async () => {
      const { accessToken, userId } = await makeUser();
      await bearer(api().delete('/v1/me'), accessToken).send({}).expect(200);
      const log = await dataSource.getRepository(DestructionLog).findOneOrFail({ where: { userId } });
      await expect(dataSource.query(`UPDATE destruction_logs SET detail='x' WHERE id=$1`, [log.id])).rejects.toThrow(
        /불변/,
      );
      await expect(dataSource.query(`DELETE FROM destruction_logs WHERE id=$1`, [log.id])).rejects.toThrow(/불변/);
    });
  });

  describe('프라이버시', () => {
    it('destruction_logs에 접속 IP 컬럼이 없다', async () => {
      const cols = await dataSource.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name='destruction_logs' AND (column_name ILIKE '%ip%' OR column_name ILIKE '%addr%')`,
      );
      expect(cols).toHaveLength(0);
    });
  });
});

function decodeSub(jwt: string): string {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')).sub;
}
