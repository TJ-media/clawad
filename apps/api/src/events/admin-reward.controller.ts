import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import { AdminGuard } from '../admin/admin.guard';
import { AdminRole } from '../admin/admin-user.entity';
import { AuditInterceptor } from '../admin/audit.interceptor';
import { Roles } from '../admin/roles.decorator';
import { RewardService } from './reward.service';

class ClawBackDto {
  @IsString()
  @Length(1, 128)
  idempotencyKey: string;

  @IsString()
  @Length(1, 64)
  reason: string;
}

/** 리워드 배치·회수 운영자 API (CLAW-5). 정산 역할(SETTLER)만. 변경 조작은 감사 기록한다 (CLAW-27). */
@Controller('internal/v1/rewards')
@UseGuards(AdminGuard)
@UseInterceptors(AuditInterceptor)
@Roles(AdminRole.SETTLER)
export class AdminRewardController {
  constructor(private readonly rewards: RewardService) {}

  /** 미적립 ACCEPTED 노출 → accrue_pending. 멱등하게 반복 실행 가능. */
  @Post('run-accrual')
  @HttpCode(HttpStatus.OK)
  runAccrual() {
    return this.rewards.runAccrual();
  }

  /** 사후 검수 통과분 accrue_pending → accrue_confirm. */
  @Post('run-confirmation')
  @HttpCode(HttpStatus.OK)
  runConfirmation() {
    return this.rewards.runConfirmation();
  }

  /** 특정 노출 회수: claw_back + 광고주 크레딧 복원. */
  @Post('claw-back')
  @HttpCode(HttpStatus.OK)
  clawBack(@Body() dto: ClawBackDto) {
    return this.rewards.clawBack(dto.idempotencyKey, dto.reason);
  }
}
