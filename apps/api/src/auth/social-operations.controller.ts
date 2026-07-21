import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminRole } from '../admin/admin-user.entity';
import { AdminGuard } from '../admin/admin.guard';
import { Roles } from '../admin/roles.decorator';
import { ACTIVE_SOCIAL_PROVIDERS } from '../entities/identity.entity';
import { SocialMetricsService, SocialProviderMetrics } from './social/social-metrics.service';
import { SocialProviderRegistry } from './social/social-provider.registry';

@Controller('admin/v1/auth/social')
@UseGuards(AdminGuard)
@Roles(AdminRole.SUPERADMIN)
export class SocialOperationsController {
  constructor(
    private readonly metrics: SocialMetricsService,
    private readonly registry: SocialProviderRegistry,
  ) {}

  @Get('metrics')
  async getMetrics(): Promise<{ retentionDays: number; providers: Array<SocialProviderMetrics & { enabled: boolean }> }> {
    const enabled = new Set(this.registry.enabledProviders());
    const metrics = await this.metrics.snapshot(ACTIVE_SOCIAL_PROVIDERS);
    return {
      retentionDays: this.metrics.retentionDays,
      providers: metrics.map((item) => ({ ...item, enabled: enabled.has(item.provider) })),
    };
  }
}
