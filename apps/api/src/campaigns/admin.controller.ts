import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Advertiser } from '../entities/advertiser.entity';
import { BillingLedgerEntry } from '../entities/billing-ledger.entity';
import { Campaign } from '../entities/campaign.entity';
import { Creative } from '../entities/creative.entity';
import { AdminGuard } from './admin.guard';
import { BudgetService } from './budget.service';
import { CampaignsService } from './campaigns.service';
import {
  CreateAdvertiserDto,
  CreateCampaignDto,
  CreateCreativeDto,
  CreditBudgetDto,
  ReviewCreativeDto,
  TransitionCampaignDto,
} from './dto';

/** 운영자 콘솔용 내부 API. 광고주에게 직접 노출하는 API가 아니다 (CLAW-23 §API). */
@Controller('internal/v1')
@UseGuards(AdminGuard)
export class AdminCampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly budget: BudgetService,
  ) {}

  @Post('advertisers')
  @HttpCode(HttpStatus.CREATED)
  createAdvertiser(@Body() dto: CreateAdvertiserDto): Promise<Advertiser> {
    return this.campaigns.createAdvertiser(dto.name, dto.dailyImpressionLimit ?? null);
  }

  @Post('campaigns')
  @HttpCode(HttpStatus.CREATED)
  createCampaign(@Body() dto: CreateCampaignDto): Promise<Campaign> {
    return this.campaigns.createCampaign({
      advertiserId: dto.advertiserId,
      name: dto.name,
      type: dto.type,
      pricePerImpressionKrw: dto.pricePerImpressionKrw,
      rewardPolicyId: dto.rewardPolicyId ?? null,
      startsAt: dto.startsAt ?? null,
      endsAt: dto.endsAt ?? null,
    });
  }

  @Get('campaigns/:id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<Campaign | null> {
    return this.campaigns.get(id);
  }

  @Post('campaigns/:id/transition')
  @HttpCode(HttpStatus.OK)
  transition(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TransitionCampaignDto): Promise<Campaign> {
    return this.campaigns.transition(id, dto.to, dto.reviewNote);
  }

  @Post('campaigns/:id/creatives')
  @HttpCode(HttpStatus.CREATED)
  addCreative(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateCreativeDto): Promise<Creative> {
    return this.campaigns.addCreativeVersion(id, {
      text: dto.text,
      brand: dto.brand,
      landingUrl: dto.landingUrl ?? null,
    });
  }

  @Post('creatives/:id/review')
  @HttpCode(HttpStatus.OK)
  reviewCreative(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewCreativeDto): Promise<Creative> {
    return this.campaigns.reviewCreative(id, dto.approve, dto.reviewNote);
  }

  /** 예산 충전·보너스·환급. CAPTURE는 이 경로로 만들 수 없다. */
  @Post('campaigns/:id/budget/credit')
  @HttpCode(HttpStatus.CREATED)
  credit(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreditBudgetDto): Promise<BillingLedgerEntry> {
    return this.budget.credit(id, dto.entryType, dto.amountKrw, dto.reason);
  }

  @Get('campaigns/:id/budget')
  async budgetOf(@Param('id', ParseUUIDPipe) id: string): Promise<{ availableKrw: number }> {
    return { availableKrw: await this.budget.availableKrw(id) };
  }
}
