import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { AdminGuard } from '../campaigns/admin.guard';
import { ImpressionEvent } from '../entities/impression-event.entity';
import { KillSwitch } from '../entities/kill-switch.entity';
import { Machine } from '../entities/machine.entity';
import { User } from '../entities/user.entity';
import { AdminEventsController } from './admin-events.controller';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { KillSwitchService } from './kill-switch.service';

@Module({
  imports: [
    // JwtAuthGuard가 User·Machine 리포지토리를 쓴다.
    TypeOrmModule.forFeature([ImpressionEvent, KillSwitch, Machine, User]),
    AuthModule,
    CampaignsModule, // BudgetService·FrequencyService·ServeTokenService 재사용
  ],
  controllers: [EventsController, AdminEventsController],
  providers: [EventsService, KillSwitchService, AdminGuard],
  exports: [EventsService, KillSwitchService],
})
export class EventsModule {}
