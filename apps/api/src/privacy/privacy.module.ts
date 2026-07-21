import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';
import { Consent } from '../entities/consent.entity';
import { Identity } from '../entities/identity.entity';
import { ImpressionEvent } from '../entities/impression-event.entity';
import { Machine } from '../entities/machine.entity';
import { RewardLedgerEntry } from '../entities/reward-ledger.entity';
import { User } from '../entities/user.entity';
import { EventsModule } from '../events/events.module';
import { AdminPrivacyController } from './admin-privacy.controller';
import { DestructionLog } from './destruction-log.entity';
import { PrivacyController } from './privacy.controller';
import { PrivacyService } from './privacy.service';

@Module({
  imports: [
    // JwtAuthGuard가 User·Machine을 쓴다. 서비스는 identity·consent·impression·reward 원장을 읽고 파기 로그를 남긴다.
    TypeOrmModule.forFeature([User, Identity, Consent, Machine, ImpressionEvent, RewardLedgerEntry, DestructionLog]),
    AuthModule,
    AdminModule,
    EventsModule, // RewardService의 확정 잔액 공식을 내보내기·탈퇴에서도 단일 원본으로 사용한다.
  ],
  controllers: [PrivacyController, AdminPrivacyController],
  providers: [PrivacyService],
  exports: [PrivacyService],
})
export class PrivacyModule {}
