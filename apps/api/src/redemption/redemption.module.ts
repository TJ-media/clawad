import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';
import { RewardLedgerEntry } from '../entities/reward-ledger.entity';
import { User } from '../entities/user.entity';
import { Machine } from '../entities/machine.entity';
import { EventsModule } from '../events/events.module';
import { AdminRedemptionController } from './admin-redemption.controller';
import { Product } from './product.entity';
import { RedemptionController } from './redemption.controller';
import { RedemptionLedgerEntry } from './redemption-ledger.entity';
import { Redemption } from './redemption.entity';
import { RedemptionService } from './redemption.service';

@Module({
  imports: [
    // JwtAuthGuard가 User·Machine을 쓴다. 확정잔액 계산은 RewardService(EventsModule) 재사용.
    TypeOrmModule.forFeature([Product, Redemption, RedemptionLedgerEntry, RewardLedgerEntry, User, Machine]),
    AuthModule,
    AdminModule,
    EventsModule,
  ],
  controllers: [RedemptionController, AdminRedemptionController],
  providers: [RedemptionService],
  exports: [RedemptionService],
})
export class RedemptionModule {}
