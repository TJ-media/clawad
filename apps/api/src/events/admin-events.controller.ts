import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { AdminGuard } from '../campaigns/admin.guard';
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
export class AdminEventsController {
  constructor(
    private readonly events: EventsService,
    private readonly killSwitch: KillSwitchService,
  ) {}

  @Get('abuse-report')
  abuseReport() {
    return this.events.abuseReport();
  }

  @Post('kill-switch')
  @HttpCode(HttpStatus.CREATED)
  enable(@Body() dto: KillSwitchDto) {
    return this.killSwitch.enable(dto.target, dto.targetId, dto.reason);
  }

  @Delete('kill-switch')
  @HttpCode(HttpStatus.OK)
  disable(@Body() dto: KillSwitchDto) {
    return this.killSwitch.disable(dto.target, dto.targetId);
  }
}
