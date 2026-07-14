import {
  Global,
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { HttpMetricsMiddleware } from './http-metrics.middleware';
import { MonitoringTokenGuard } from './monitoring-token.guard';
import { MonitoringController, ObservabilityController } from './observability.controller';
import { ObservabilityService } from './observability.service';
import { OperationalMetricsService } from './operational-metrics.service';

/**
 * 저카디널리티 운영 관측 모듈. AppModule에서 한 번 import하면 sync 업로드 hook도
 * 같은 OperationalMetricsService를 전역으로 재사용한다.
 */
@Global()
@Module({
  imports: [AdminModule],
  controllers: [ObservabilityController, MonitoringController],
  providers: [OperationalMetricsService, ObservabilityService, MonitoringTokenGuard, HttpMetricsMiddleware],
  exports: [OperationalMetricsService, ObservabilityService],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(HttpMetricsMiddleware)
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
