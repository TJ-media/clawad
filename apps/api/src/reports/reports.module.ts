import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';
import { RewardLedgerEntry } from '../entities/reward-ledger.entity';
import { Machine } from '../entities/machine.entity';
import { User } from '../entities/user.entity';
import { EventsModule } from '../events/events.module';
import { AdminReportsController } from './admin-reports.controller';
import { Report } from './report.entity';
import { ReportNotifierService } from './report-notifier.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  // JwtAuthGuard가 User·Machine을 쓴다. 확정잔액 계산은 RewardService(EventsModule) 재사용.
  // AdminGuard·AuditInterceptor는 AdminModule에서 온다.
  imports: [
    TypeOrmModule.forFeature([Report, RewardLedgerEntry, User, Machine]),
    AuthModule,
    AdminModule,
    EventsModule,
  ],
  controllers: [ReportsController, AdminReportsController],
  providers: [ReportsService, ReportNotifierService],
  exports: [ReportsService],
})
export class ReportsModule {}
