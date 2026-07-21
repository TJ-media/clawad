import { Type } from 'class-transformer';
import { IsDateString, IsOptional, IsUUID } from 'class-validator';

export class AnalyticsQueryDto {
  @IsDateString()
  from: string;

  @IsDateString()
  to: string;

  @IsOptional()
  @IsUUID()
  campaignId?: string;

  @IsOptional()
  @IsUUID()
  creativeId?: string;
}

export class AnalyticsBreakdownQueryDto extends AnalyticsQueryDto {
  @IsOptional()
  @Type(() => String)
  dimension?: 'campaign' | 'creative';
}
