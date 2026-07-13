import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from './admin/admin.module';
import { AdminUser } from './admin/admin-user.entity';
import { AuditLog } from './admin/audit-log.entity';
import { AuthModule } from './auth/auth.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { RedisModule } from './common/redis.module';
import { Advertiser } from './entities/advertiser.entity';
import { BillingLedgerEntry } from './entities/billing-ledger.entity';
import { Campaign } from './entities/campaign.entity';
import { Consent } from './entities/consent.entity';
import { Creative } from './entities/creative.entity';
import { Identity } from './entities/identity.entity';
import { ImpressionEvent } from './entities/impression-event.entity';
import { KillSwitch } from './entities/kill-switch.entity';
import { Machine } from './entities/machine.entity';
import { RewardLedgerEntry } from './entities/reward-ledger.entity';
import { User } from './entities/user.entity';
import { EventsModule } from './events/events.module';
import { MachinesModule } from './machines/machines.module';
import { DestructionLog } from './privacy/destruction-log.entity';
import { PrivacyModule } from './privacy/privacy.module';
import { Product } from './redemption/product.entity';
import { Redemption } from './redemption/redemption.entity';
import { RedemptionLedgerEntry } from './redemption/redemption-ledger.entity';
import { RedemptionModule } from './redemption/redemption.module';
import { InitSchema1783700000000 } from './migrations/1783700000000-InitSchema';
import { CampaignBudget1783710000000 } from './migrations/1783710000000-CampaignBudget';
import { ImpressionEvents1783720000000 } from './migrations/1783720000000-ImpressionEvents';
import { RewardLedger1783730000000 } from './migrations/1783730000000-RewardLedger';
import { AdminSecurity1783740000000 } from './migrations/1783740000000-AdminSecurity';
import { PrivacyRights1783750000000 } from './migrations/1783750000000-PrivacyRights';
import { Redemption1783760000000 } from './migrations/1783760000000-Redemption';
import { ProductCategory1783770000000 } from './migrations/1783770000000-ProductCategory';
import { SocialAuth1783780000000 } from './migrations/1783780000000-SocialAuth';

/** 필수 환경변수. 기본값 fallback을 두지 않는다. */
function requireEnv(config: ConfigService, key: string): string {
  const value = config.get<string>(key);
  if (!value) throw new Error(`${key} 환경변수가 필요합니다. apps/api/.env.example을 참고하세요.`);
  return value;
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '.env.local'] }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        // 기본 포트(5432)를 fallback으로 두지 않는다 — 같은 머신의 다른 프로젝트 DB에
        // 실수로 마이그레이션을 돌리는 사고를 막는다. 값이 없으면 기동 실패시킨다.
        host: config.get<string>('DB_HOST', 'localhost'),
        port: Number(requireEnv(config, 'DB_PORT')),
        username: config.get<string>('DB_USER', 'clawad'),
        password: requireEnv(config, 'DB_PASSWORD'),
        database: config.get<string>('DB_NAME', 'clawad'),
        entities: [User, Identity, Machine, Consent, Advertiser, Campaign, Creative, BillingLedgerEntry, ImpressionEvent, KillSwitch, RewardLedgerEntry, AdminUser, AuditLog, DestructionLog, Product, Redemption, RedemptionLedgerEntry],
        migrations: [InitSchema1783700000000, CampaignBudget1783710000000, ImpressionEvents1783720000000, RewardLedger1783730000000, AdminSecurity1783740000000, PrivacyRights1783750000000, Redemption1783760000000, ProductCategory1783770000000, SocialAuth1783780000000],
        // 운영 스키마는 마이그레이션으로만 바꾼다. synchronize는 어떤 환경에서도 켜지 않는다.
        synchronize: false,
        migrationsRun: true,
      }),
    }),
    RedisModule,
    AdminModule,
    AuthModule,
    MachinesModule,
    CampaignsModule,
    EventsModule,
    PrivacyModule,
    RedemptionModule,
  ],
})
export class AppModule {}
