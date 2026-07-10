import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Advertiser } from '../entities/advertiser.entity';
import { BillingLedgerEntry } from '../entities/billing-ledger.entity';
import { Campaign } from '../entities/campaign.entity';
import { Creative } from '../entities/creative.entity';
import { AdDecisionService } from './ad-decision.service';
import { AdminCampaignsController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { BudgetService } from './budget.service';
import { CampaignsService } from './campaigns.service';
import { FrequencyService } from './frequency.service';

@Module({
  imports: [TypeOrmModule.forFeature([Advertiser, Campaign, Creative, BillingLedgerEntry])],
  controllers: [AdminCampaignsController],
  providers: [CampaignsService, BudgetService, FrequencyService, AdDecisionService, AdminGuard],
  exports: [CampaignsService, BudgetService, FrequencyService, AdDecisionService],
})
export class CampaignsModule {}
