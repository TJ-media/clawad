import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { BillingLedgerEntry } from '../entities/billing-ledger.entity';
import { Campaign } from '../entities/campaign.entity';
import { ImpressionEvent } from '../entities/impression-event.entity';
import { ImpressionDecisionTransition } from '../entities/impression-decision-transition.entity';
import { KillSwitch } from '../entities/kill-switch.entity';
import { Machine } from '../entities/machine.entity';
import { RewardLedgerEntry } from '../entities/reward-ledger.entity';
import { User } from '../entities/user.entity';
import { AdminEventsController } from './admin-events.controller';
import { AdminRewardController } from './admin-reward.controller';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { KillSwitchService } from './kill-switch.service';
import { RewardController } from './reward.controller';
import { RewardService } from './reward.service';

@Module({
  imports: [
    // JwtAuthGuard가 User·Machine 리포지토리를 쓴다. 리워드는 impression·billing·reward·campaign 원장을 읽는다.
    TypeOrmModule.forFeature([
      ImpressionEvent,
      ImpressionDecisionTransition,
      KillSwitch,
      Machine,
      User,
      RewardLedgerEntry,
      BillingLedgerEntry,
      Campaign,
    ]),
    AuthModule,
    AdminModule, // 관리자 가드·감사 인터셉터
    CampaignsModule, // BudgetService·FrequencyService·ServeTokenService 재사용
  ],
  controllers: [EventsController, AdminEventsController, RewardController, AdminRewardController],
  providers: [EventsService, KillSwitchService, RewardService],
  exports: [EventsService, KillSwitchService, RewardService],
})
export class EventsModule {}
