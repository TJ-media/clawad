import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Length,
  Min,
} from 'class-validator';
import { BillingEntryType } from '../entities/billing-ledger.entity';
import { CampaignStatus, CampaignType } from '../entities/campaign.entity';

export class CreateAdvertiserDto {
  @IsString()
  @Length(1, 200)
  name: string;

  /** null이면 무제한. */
  @IsOptional()
  @IsInt()
  @Min(1)
  dailyImpressionLimit?: number;
}

export class CreateCampaignDto {
  @IsUUID()
  advertiserId: string;

  @IsString()
  @Length(1, 200)
  name: string;

  @IsEnum(CampaignType)
  type: CampaignType;

  /** PAID가 아니면 0이어야 한다. */
  @IsInt()
  @Min(0)
  pricePerImpressionKrw: number;

  /** HOUSE가 회사 재원으로 리워드를 적립할 때만. TEST는 금지. */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  rewardPolicyId?: string;

  @IsOptional()
  @Type(() => Date)
  startsAt?: Date;

  @IsOptional()
  @Type(() => Date)
  endsAt?: Date;
}

export class TransitionCampaignDto {
  @IsEnum(CampaignStatus)
  to: CampaignStatus;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  reviewNote?: string;
}

export class CreateCreativeDto {
  @IsString()
  @Length(1, 120)
  text: string;

  @IsString()
  @Length(1, 60)
  brand: string;

  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['https'] })
  @Length(1, 2048)
  landingUrl?: string;
}

export class ReviewCreativeDto {
  @IsBoolean()
  approve: boolean;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  reviewNote?: string;
}

export class CreditBudgetDto {
  @IsEnum(BillingEntryType)
  entryType: BillingEntryType;

  @IsInt()
  @Min(1)
  amountKrw: number;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  reason?: string;
}
