import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { IsEmail, IsEnum, IsString, Length } from 'class-validator';
import { AdminAuthService } from './admin-auth.service';
import { AdminGuard, AdminRequest } from './admin.guard';
import { AdminRole } from './admin-user.entity';
import { AuditInterceptor } from './audit.interceptor';
import { RateLimit } from '../common/rate-limit';
import { Roles } from './roles.decorator';

class AdminLoginDto {
  @IsEmail()
  @Length(3, 320)
  email: string;

  @IsString()
  @Length(1, 200)
  password: string;
}

class CreateAdminDto {
  @IsEmail()
  @Length(3, 320)
  email: string;

  @IsString()
  @Length(10, 200)
  password: string;

  @IsEnum(AdminRole)
  role: AdminRole;
}

@Controller('admin/v1/auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  /** 관리자 로그인 → 역할 클레임을 담은 단기 JWT. 무인증 라우트. */
  // 무차별 대입 방어 (CLAW-176): IP·계정(email)별 분당 10회. 뚫리면 킬스위치·리워드·이메일 열람까지
  // 넘어가는 최고 위험 경로라 가장 좁게 건다.
  @RateLimit({ limit: 10, windowSec: 60, byEmail: true })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: AdminLoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  /** SUPERADMIN만 관리자를 생성한다. 감사 대상. */
  @Post('admins')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AdminGuard)
  @Roles(AdminRole.SUPERADMIN)
  @UseInterceptors(AuditInterceptor)
  async create(@Req() _req: AdminRequest, @Body() dto: CreateAdminDto) {
    const admin = await this.auth.createAdmin(dto.email, dto.password, dto.role);
    return { id: admin.id, email: admin.email, role: admin.role };
  }
}
