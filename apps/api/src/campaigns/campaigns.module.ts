import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';
import { Advertiser } from '../entities/advertiser.entity';
import { BillingLedgerEntry } from '../entities/billing-ledger.entity';
import { Campaign } from '../entities/campaign.entity';
import { Creative } from '../entities/creative.entity';
import { Machine } from '../entities/machine.entity';
import { User } from '../entities/user.entity';
import { AdDecisionController } from './ad-decision.controller';
import { AdDecisionService } from './ad-decision.service';
import { AdminCampaignsController } from './admin.controller';
import { BudgetService } from './budget.service';
import { CampaignsService } from './campaigns.service';
import { FrequencyService } from './frequency.service';
import { ServeTokenService } from './serve-token.service';

@Module({
  // JwtAuthGuard가 User·Machine 리포지토리를 쓴다. AdminModule은 관리자 가드·감사 인터셉터를 제공한다.
  imports: [
    TypeOrmModule.forFeature([Advertiser, Campaign, Creative, BillingLedgerEntry, Machine, User]),
    AuthModule,
    AdminModule,
  ],
  controllers: [AdminCampaignsController, AdDecisionController],
  providers: [CampaignsService, BudgetService, FrequencyService, AdDecisionService, ServeTokenService],
  exports: [CampaignsService, BudgetService, FrequencyService, AdDecisionService, ServeTokenService],
})
export class CampaignsModule {}
