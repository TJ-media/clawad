import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

@Module({ imports: [AdminModule], controllers: [AnalyticsController], providers: [AnalyticsService] })
export class AnalyticsModule {}
