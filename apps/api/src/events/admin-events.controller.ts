import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';
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

  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{0,63}$/)
  reasonCode: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/)
  incidentRef?: string;
}

class EmergencySwitchDto {
  /** 낮은 카디널리티 안전 코드. 토큰·이메일 등 자유 입력은 받지 않는다. */
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{0,63}$/)
  reasonCode: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/)
  incidentRef?: string;
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

  @Get('kill-switches')
  @Roles(AdminRole.SUPERADMIN)
  activeKillSwitches() {
    return this.killSwitch.listActive();
  }

  /** 전체 광고 발급·신규 승인과 적립·확정 배치를 한 트랜잭션에서 중지한다. */
  @Post('emergency-stop')
  @HttpCode(HttpStatus.CREATED)
  @Roles(AdminRole.SUPERADMIN)
  emergencyStop(@Body() dto: EmergencySwitchDto) {
    return this.killSwitch.emergencyStop(dto.reasonCode, dto.incidentRef);
  }

  /** 전체 광고·적립 재개. 과거 KILLED 이벤트와 폐기 토큰은 복원하지 않는다. */
  @Post('emergency-resume')
  @HttpCode(HttpStatus.OK)
  @Roles(AdminRole.SUPERADMIN)
  emergencyResume(@Body() dto: EmergencySwitchDto) {
    return this.killSwitch.emergencyResume(dto.reasonCode, dto.incidentRef);
  }

  // 킬스위치는 최고관리자만. 수집·서빙 차단은 강한 권한이다.
  @Post('kill-switch')
  @HttpCode(HttpStatus.CREATED)
  @Roles(AdminRole.SUPERADMIN)
  enable(@Body() dto: KillSwitchDto) {
    return this.killSwitch.enable(dto.target, dto.targetId, dto.reasonCode, dto.incidentRef);
  }

  @Delete('kill-switch')
  @HttpCode(HttpStatus.OK)
  @Roles(AdminRole.SUPERADMIN)
  disable(@Body() dto: KillSwitchDto) {
    return this.killSwitch.disable(dto.target, dto.targetId, dto.reasonCode, dto.incidentRef);
  }
}
