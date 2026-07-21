import './setup-env';
import { loginBootstrapAdmin, loginAsRole } from './admin-helper';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AdminRole } from '../src/admin/admin-user.entity';
import { AuditLog } from '../src/admin/audit-log.entity';
import { KillSwitchTarget } from '../src/entities/kill-switch.entity';

describe('CLAW-27 관리자 권한·감사로그 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let superToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = app.get<DataSource>(getDataSourceToken());
    superToken = await loginBootstrapAdmin(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const api = () => request(app.getHttpServer());
  const bearer = (r: request.Test, token: string) => r.set('Authorization', `Bearer ${token}`);

  describe('인증', () => {
    it('부트스트랩 SUPERADMIN으로 로그인해 토큰을 받는다', () => {
      expect(superToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/); // JWT 3-part
    });

    it('잘못된 비밀번호는 401이며 계정 존재 여부를 구분하지 않는다', async () => {
      const wrong = await api()
        .post('/admin/v1/auth/login')
        .send({ email: process.env.ADMIN_BOOTSTRAP_EMAIL, password: 'wrong' })
        .expect(401);
      const noUser = await api()
        .post('/admin/v1/auth/login')
        .send({ email: 'nobody@clawad.test', password: 'wrong' })
        .expect(401);
      expect(wrong.body.error).toBe('INVALID_ADMIN_CREDENTIALS');
      expect(noUser.body.error).toBe('INVALID_ADMIN_CREDENTIALS');
    });

    it('토큰 없이 내부 API 호출 시 401', async () => {
      await api().post('/internal/v1/advertisers').send({ name: 'x' }).expect(401);
    });

    it('잘못된 JWT는 401', async () => {
      await bearer(api().post('/internal/v1/advertisers'), 'garbage.jwt.here').send({ name: 'x' }).expect(401);
    });
  });

  describe('역할 기반 인가 (RBAC)', () => {
    it('SETTLER는 리워드 배치를 실행할 수 있다', async () => {
      const settler = await loginAsRole(app, superToken, AdminRole.SETTLER);
      await bearer(api().post('/internal/v1/rewards/run-accrual'), settler).expect(200);
    });

    it('REVIEWER는 리워드 배치를 실행할 수 없다 (403)', async () => {
      const reviewer = await loginAsRole(app, superToken, AdminRole.REVIEWER);
      const res = await bearer(api().post('/internal/v1/rewards/run-accrual'), reviewer).expect(403);
      expect(res.body.error).toBe('INSUFFICIENT_ROLE');
    });

    it('SETTLER는 킬스위치를 켤 수 없다 (SUPERADMIN 전용, 403)', async () => {
      const settler = await loginAsRole(app, superToken, AdminRole.SETTLER);
      await bearer(api().post('/internal/v1/kill-switch'), settler)
        .send({ target: KillSwitchTarget.CAMPAIGN, targetId: randomUUID(), reasonCode: 'SECURITY_TEST' })
        .expect(403);
    });

    it('SUPERADMIN은 모든 조작을 통과한다', async () => {
      await bearer(api().post('/internal/v1/kill-switch'), superToken)
        .send({ target: KillSwitchTarget.CAMPAIGN, targetId: randomUUID(), reasonCode: 'SECURITY_TEST' })
        .expect(201);
    });

    it('킬스위치 대상 ID에 자유 문자열·PII를 받지 않는다', async () => {
      await bearer(api().post('/internal/v1/kill-switch'), superToken)
        .send({ target: KillSwitchTarget.USER, targetId: 'someone@example.com', reasonCode: 'SECURITY_TEST' })
        .expect(400);
      await bearer(api().post('/internal/v1/kill-switch'), superToken)
        .send({ target: KillSwitchTarget.MACHINE, targetId: '00:11:22:33:44:55', reasonCode: 'SECURITY_TEST' })
        .expect(400);
      await bearer(api().post('/internal/v1/kill-switch'), superToken)
        .send({ target: KillSwitchTarget.CAMPAIGN, targetId: randomUUID().toUpperCase(), reasonCode: 'SECURITY_TEST' })
        .expect(400);
    });

    it('전체 긴급 중지·재개는 SUPERADMIN만 수행하고 안전 사유 형식을 강제한다', async () => {
      const settler = await loginAsRole(app, superToken, AdminRole.SETTLER);
      await bearer(api().post('/internal/v1/emergency-stop'), settler)
        .send({ reasonCode: 'ALPHA_INCIDENT', incidentRef: 'CLAW-65' })
        .expect(403);
      await bearer(api().post('/internal/v1/emergency-stop'), superToken)
        .send({ reasonCode: 'token=secret', incidentRef: 'someone@example.com' })
        .expect(400);

      await bearer(api().post('/internal/v1/emergency-stop'), superToken)
        .send({ reasonCode: 'ALPHA_INCIDENT', incidentRef: 'CLAW-65' })
        .expect(201);
      await bearer(api().post('/internal/v1/emergency-resume'), superToken)
        .send({ reasonCode: 'ALPHA_RECOVERY', incidentRef: 'CLAW-65' })
        .expect(200);
    });

    it('REVIEWER는 광고주를 생성할 수 없다 (SUPERADMIN 전용)', async () => {
      const reviewer = await loginAsRole(app, superToken, AdminRole.REVIEWER);
      await bearer(api().post('/internal/v1/advertisers'), reviewer).send({ name: 'x' }).expect(403);
    });

    it('SETTLER만 관리자를 만들 수 없다 (SUPERADMIN 전용)', async () => {
      const settler = await loginAsRole(app, superToken, AdminRole.SETTLER);
      await bearer(api().post('/admin/v1/auth/admins'), settler)
        .send({ email: `x-${randomUUID()}@clawad.test`, password: 'x'.repeat(12), role: AdminRole.REVIEWER })
        .expect(403);
    });
  });

  describe('감사로그', () => {
    it('변경 조작을 감사로그에 기록한다 (행위자·액션)', async () => {
      const before = await dataSource.getRepository(AuditLog).count();
      const adv = await bearer(api().post('/internal/v1/advertisers'), superToken)
        .send({ name: `audit-${randomUUID().slice(0, 8)}` })
        .expect(201);
      const after = await dataSource.getRepository(AuditLog).count();
      expect(after).toBeGreaterThan(before);

      const log = await dataSource
        .getRepository(AuditLog)
        .findOneOrFail({ where: { action: 'POST /internal/v1/advertisers' }, order: { id: 'DESC' } });
      expect(log.actorRole).toBe(AdminRole.SUPERADMIN);
      expect(log.actorAdminId).toBeTruthy();
    });

    it('감사로그 params에 비밀값·PII를 마스킹한다', async () => {
      await bearer(api().post('/admin/v1/auth/admins'), superToken)
        .send({ email: `mask-${randomUUID()}@clawad.test`, password: 'super-secret-pw', role: AdminRole.REVIEWER })
        .expect(201);
      const log = await dataSource
        .getRepository(AuditLog)
        .findOneOrFail({ where: { action: 'POST /admin/v1/auth/admins' }, order: { id: 'DESC' } });
      expect(log.params).toContain('***');
      expect(log.params).not.toContain('super-secret-pw');
      expect(log.params).not.toContain('mask-'); // 이메일도 마스킹
    });

    it('중첩·표기 변형 인증정보와 경로도 감사로그에서 마스킹한다', async () => {
      const { maskParams } = await import('../src/admin/audit.interceptor');
      const params = maskParams({
        nested: {
          clientSecret: 'copied-secret',
          handoff_code: 'copied-code',
          Authorization: 'Bearer copied-token',
          emailAddress: 'person@example.test',
          projectPath: '/Users/person/private-project',
        },
        reasonCode: 'INCIDENT_DRILL',
      })!;
      expect(params).toContain('INCIDENT_DRILL');
      for (const forbidden of ['copied-secret', 'copied-code', 'copied-token', 'person@example', '/Users/person']) {
        expect(params).not.toContain(forbidden);
      }
    });

    it('조회(GET)는 감사하지 않는다', async () => {
      const before = await dataSource.getRepository(AuditLog).count();
      await bearer(api().get('/internal/v1/abuse-report'), superToken).expect(200);
      const after = await dataSource.getRepository(AuditLog).count();
      expect(after).toBe(before);
    });

    it('감사로그는 append-only — DB가 UPDATE·DELETE를 거부한다', async () => {
      // 감사 대상 조작을 하나 만들어 로그를 확보한다.
      await bearer(api().post('/internal/v1/advertisers'), superToken)
        .send({ name: `ap-${randomUUID().slice(0, 8)}` })
        .expect(201);
      const log = await dataSource.getRepository(AuditLog).findOneOrFail({ where: {}, order: { id: 'DESC' } });
      await expect(dataSource.query(`UPDATE audit_logs SET action='x' WHERE id=$1`, [log.id])).rejects.toThrow(
        /불변/,
      );
      await expect(dataSource.query(`DELETE FROM audit_logs WHERE id=$1`, [log.id])).rejects.toThrow(/불변/);
    });
  });

  describe('프라이버시', () => {
    it('audit_logs·admin_users에 접속 IP 컬럼이 없다', async () => {
      const cols = await dataSource.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name IN ('audit_logs','admin_users') AND (column_name ILIKE '%ip%' OR column_name ILIKE '%addr%')`,
      );
      expect(cols).toHaveLength(0);
    });
  });
});
