import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { AdminGuard } from '../admin/admin.guard';
import { AdminRole } from '../admin/admin-user.entity';
import { AuditInterceptor } from '../admin/audit.interceptor';
import { Roles } from '../admin/roles.decorator';
import { KillSwitchTarget } from '../entities/kill-switch.entity';
import { EventsService } from './events.service';
import { KillSwitchService } from './kill-switch.service';

class KillSwitchDto {
  @IsEnum(KillSwitchTarget)
  target: KillSwitchTarget;

  @IsString()
  @Length(1, 64)
  targetId: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  reason?: string;
}

/** 운영자 콘솔 내부 API. 정식 권한·감사로그는 CLAW-27에서 교체한다. */
@Controller('internal/v1')
@UseGuards(AdminGuard)
@UseInterceptors(AuditInterceptor)
export class AdminEventsController {
  constructor(
    private readonly events: EventsService,
    private readonly killSwitch: KillSwitchService,
  ) {}

  @Get('abuse-report')
  abuseReport() {
    return this.events.abuseReport();
  }

  // 킬스위치는 최고관리자만. 수집·서빙 차단은 강한 권한이다.
  @Post('kill-switch')
  @HttpCode(HttpStatus.CREATED)
  @Roles(AdminRole.SUPERADMIN)
  enable(@Body() dto: KillSwitchDto) {
    return this.killSwitch.enable(dto.target, dto.targetId, dto.reason);
  }

  @Delete('kill-switch')
  @HttpCode(HttpStatus.OK)
  @Roles(AdminRole.SUPERADMIN)
  disable(@Body() dto: KillSwitchDto) {
    return this.killSwitch.disable(dto.target, dto.targetId);
  }
}
