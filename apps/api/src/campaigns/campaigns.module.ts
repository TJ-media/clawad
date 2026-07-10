import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
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
import { AdminGuard } from './admin.guard';
import { BudgetService } from './budget.service';
import { CampaignsService } from './campaigns.service';
import { FrequencyService } from './frequency.service';
import { ServeTokenService } from './serve-token.service';

@Module({
  // JwtAuthGuard가 User·Machine 리포지토리를 쓴다 (인증된 사용자 확정 + 차단 기기 403).
  imports: [TypeOrmModule.forFeature([Advertiser, Campaign, Creative, BillingLedgerEntry, Machine, User]), AuthModule],
  controllers: [AdminCampaignsController, AdDecisionController],
  providers: [CampaignsService, BudgetService, FrequencyService, AdDecisionService, AdminGuard, ServeTokenService],
  exports: [CampaignsService, BudgetService, FrequencyService, AdDecisionService, ServeTokenService],
})
export class CampaignsModule {}
