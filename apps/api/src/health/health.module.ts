import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { PublicPolicyController } from './public-policy.controller';

@Module({ controllers: [HealthController, PublicPolicyController] })
export class HealthModule {}
