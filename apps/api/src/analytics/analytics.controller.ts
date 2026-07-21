import { Controller, Get, Query, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import { Response } from 'express';
import { AdminGuard } from '../admin/admin.guard';
import { AuditInterceptor } from '../admin/audit.interceptor';
import { AnalyticsBreakdownQueryDto, AnalyticsQueryDto } from './analytics.dto';
import { AnalyticsService } from './analytics.service';

@Controller('internal/v1/analytics')
@UseGuards(AdminGuard)
@UseInterceptors(AuditInterceptor)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('summary') summary(@Query() query: AnalyticsQueryDto) { return this.analytics.summary(query); }
  @Get('funnel') funnel(@Query() query: AnalyticsQueryDto) { return this.analytics.funnel(query); }
  @Get('time-series') timeSeries(@Query() query: AnalyticsQueryDto) { return this.analytics.timeSeries(query); }
  @Get('breakdown') breakdown(@Query() query: AnalyticsBreakdownQueryDto) { return this.analytics.breakdown(query, query.dimension === 'creative' ? 'creative' : 'campaign'); }
  @Get('export.csv') async csv(@Query() query: AnalyticsQueryDto, @Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="clawad-alpha-analytics.csv"');
    res.send(await this.analytics.csv(query));
  }
}
