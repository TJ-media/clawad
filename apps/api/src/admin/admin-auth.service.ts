import { Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import { hashPassword, verifyPassword } from '../common/password';
import { AdminRole, AdminStatus, AdminUser } from './admin-user.entity';

export interface AdminTokenPayload {
  sub: string;
  role: AdminRole;
}

@Injectable()
export class AdminAuthService implements OnModuleInit {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(
    @InjectRepository(AdminUser) private readonly admins: Repository<AdminUser>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 부트스트랩: 관리자가 하나도 없으면 env로 SUPERADMIN을 만든다.
   * 없으면 관리 API는 로그인 불가 상태로 남는다(정적 토큰 fallback 없음).
   */
  async onModuleInit(): Promise<void> {
    const bootstrapEnabled = this.config.get<string>('ADMIN_BOOTSTRAP_ENABLED', process.env.NODE_ENV === 'production' ? 'false' : 'true') === 'true';
    const email = this.config.get<string>('ADMIN_BOOTSTRAP_EMAIL');
    const password = this.config.get<string>('ADMIN_BOOTSTRAP_PASSWORD');
    if (!bootstrapEnabled) return;
    if (!email || !password) {
      const count = await this.admins.count();
      if (count === 0) {
        this.logger.warn('관리자가 없고 ADMIN_BOOTSTRAP_EMAIL/PASSWORD도 없습니다. 관리 API를 쓸 수 없습니다.');
      }
      return;
    }
    const existing = await this.admins.findOneBy({ email: email.toLowerCase() });
    if (existing) return;
    await this.admins.save(
      this.admins.create({
        email: email.toLowerCase(),
        passwordHash: await hashPassword(password),
        role: AdminRole.SUPERADMIN,
        status: AdminStatus.ACTIVE,
      }),
    );
    this.logger.log('부트스트랩 SUPERADMIN 생성 완료');
  }

  private secret(): string {
    const secret = this.config.get<string>('ADMIN_JWT_SECRET');
    // 공개 fallback을 두지 않는다. 인증·serveToken 키와도 다른 값을 쓴다.
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
      throw new Error('ADMIN_JWT_SECRET이 없거나 32바이트 미만입니다.');
    }
    return secret;
  }

  async login(email: string, password: string): Promise<{ accessToken: string; role: AdminRole }> {
    const admin = await this.admins.findOneBy({ email: email.trim().toLowerCase() });
    // 존재 여부를 타이밍·응답으로 노출하지 않는다.
    const ok = await verifyPassword(password, admin?.passwordHash ?? null);
    if (!admin || !ok || admin.status !== AdminStatus.ACTIVE) {
      throw new UnauthorizedException({ error: 'INVALID_ADMIN_CREDENTIALS' });
    }
    const expiresIn = this.config.get<string>('ADMIN_TOKEN_TTL', '30m') as JwtSignOptions['expiresIn'];
    const accessToken = await this.jwt.signAsync(
      { sub: admin.id, role: admin.role },
      { secret: this.secret(), expiresIn },
    );
    return { accessToken, role: admin.role };
  }

  verify(token: string): AdminTokenPayload {
    return this.jwt.verify<AdminTokenPayload>(token, { secret: this.secret() });
  }

  /** SUPERADMIN이 관리자를 생성한다. */
  async createAdmin(email: string, password: string, role: AdminRole): Promise<AdminUser> {
    const admin = this.admins.create({
      email: email.trim().toLowerCase(),
      passwordHash: await hashPassword(password),
      role,
      status: AdminStatus.ACTIVE,
    });
    return this.admins.save(admin);
  }
}
