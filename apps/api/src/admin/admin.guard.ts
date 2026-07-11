import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { Repository } from 'typeorm';
import { AdminAuthService } from './admin-auth.service';
import { AdminRole, AdminStatus, AdminUser } from './admin-user.entity';
import { ROLES_KEY } from './roles.decorator';

export interface AdminRequest extends Request {
  admin: { id: string; role: AdminRole };
}

/**
 * 관리자 인증 + 역할 인가 (CLAW-27). 정적 토큰(x-clawad-admin-token)을 대체한다.
 * Bearer 관리자 JWT를 검증하고, @Roles로 지정된 역할을 확인한다. SUPERADMIN은 항상 통과.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AdminAuthService,
    @InjectRepository(AdminUser) private readonly admins: Repository<AdminUser>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AdminRequest>();

    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException({ error: 'ADMIN_TOKEN_REQUIRED' });

    let adminId: string;
    let role: AdminRole;
    try {
      const payload = this.auth.verify(header.slice(7));
      adminId = payload.sub;
      role = payload.role;
    } catch {
      // 토큰 원문을 로그·응답에 남기지 않는다.
      throw new UnauthorizedException({ error: 'ADMIN_TOKEN_INVALID' });
    }

    const admin = await this.admins.findOneBy({ id: adminId });
    if (!admin || admin.status !== AdminStatus.ACTIVE) {
      throw new UnauthorizedException({ error: 'ADMIN_DISABLED' });
    }
    // 토큰 발급 후 역할이 바뀌었을 수 있으니 DB의 현재 역할을 신뢰한다.
    role = admin.role;

    const required = this.reflector.getAllAndOverride<AdminRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && required.length > 0 && role !== AdminRole.SUPERADMIN && !required.includes(role)) {
      throw new ForbiddenException({ error: 'INSUFFICIENT_ROLE', required, role });
    }

    req.admin = { id: admin.id, role };
    return true;
  }
}
