import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AdminRole } from '../src/admin/admin-user.entity';

/** 부트스트랩 SUPERADMIN으로 로그인해 관리자 JWT를 얻는다 (CLAW-27). */
export async function loginBootstrapAdmin(app: INestApplication): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/admin/v1/auth/login')
    .send({
      email: process.env.ADMIN_BOOTSTRAP_EMAIL,
      password: process.env.ADMIN_BOOTSTRAP_PASSWORD,
    })
    .expect(200);
  return res.body.accessToken as string;
}

/** 지정한 역할의 관리자를 만들고 로그인해 JWT를 얻는다. */
export async function loginAsRole(
  app: INestApplication,
  superToken: string,
  role: AdminRole,
): Promise<string> {
  const email = `admin-${role.toLowerCase()}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@clawad.test`;
  const password = 'role-admin-password-123';
  await request(app.getHttpServer())
    .post('/admin/v1/auth/admins')
    .set('Authorization', `Bearer ${superToken}`)
    .send({ email, password, role })
    .expect(201);
  const res = await request(app.getHttpServer())
    .post('/admin/v1/auth/login')
    .send({ email, password })
    .expect(200);
  return res.body.accessToken as string;
}
