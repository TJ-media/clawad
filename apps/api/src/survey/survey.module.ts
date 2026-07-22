import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { RewardLedgerEntry } from '../entities/reward-ledger.entity';
import { Machine } from '../entities/machine.entity';
import { User } from '../entities/user.entity';
import { EventsModule } from '../events/events.module';
import { SurveyController } from './survey.controller';
import { SurveyResponse } from './survey-response.entity';
import { SurveyService } from './survey.service';

@Module({
  // JwtAuthGuard가 User·Machine을 쓴다. 확정잔액 계산은 RewardService(EventsModule) 재사용.
  imports: [
    TypeOrmModule.forFeature([SurveyResponse, RewardLedgerEntry, User, Machine]),
    AuthModule,
    EventsModule,
  ],
  controllers: [SurveyController],
  providers: [SurveyService],
  exports: [SurveyService],
})
export class SurveyModule {}
