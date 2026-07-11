import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminGuard } from './admin.guard';
import { AdminUser } from './admin-user.entity';
import { AuditInterceptor } from './audit.interceptor';
import { AuditLog } from './audit-log.entity';

/**
 * 관리자 보안 모듈 (CLAW-27). 역할 기반 인가 가드·감사 인터셉터를 다른 모듈이 재사용한다.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AdminUser, AuditLog]), JwtModule.register({})],
  controllers: [AdminAuthController],
  providers: [AdminAuthService, AdminGuard, AuditInterceptor],
  exports: [AdminAuthService, AdminGuard, AuditInterceptor, TypeOrmModule],
})
export class AdminModule {}
