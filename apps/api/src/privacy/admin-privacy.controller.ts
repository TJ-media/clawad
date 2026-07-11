import { Controller, HttpCode, HttpStatus, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard';
import { AdminRole } from '../admin/admin-user.entity';
import { AuditInterceptor } from '../admin/audit.interceptor';
import { Roles } from '../admin/roles.decorator';
import { PrivacyService } from './privacy.service';

/** 파기 배치 운영자 API (CLAW-28). SUPERADMIN만. 감사 대상. */
@Controller('internal/v1/privacy')
@UseGuards(AdminGuard)
@UseInterceptors(AuditInterceptor)
@Roles(AdminRole.SUPERADMIN)
export class AdminPrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  /** 탈퇴 계정의 잔여 식별자 파기·정리. 보유기간 경과 원장 파기는 세무 결론(CLAW-13) 후 확장. */
  @Post('run-retention-sweep')
  @HttpCode(HttpStatus.OK)
  runRetentionSweep() {
    return this.privacy.runRetentionSweep();
  }
}
