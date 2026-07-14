import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AdminGuard } from '../admin/admin.guard';
import { MonitoringTokenGuard } from './monitoring-token.guard';
import { ObservabilityService, ObservabilitySnapshot } from './observability.service';

@Controller('internal/v1/observability')
@UseGuards(AdminGuard)
export class ObservabilityController {
  constructor(private readonly observability: ObservabilityService) {}

  /** 관리자용 안전 집계. 원시 이벤트·사용자·기기·토큰 식별자는 반환하지 않는다. */
  @Get('snapshot')
  snapshot(): Promise<ObservabilitySnapshot> {
    return this.observability.snapshot();
  }
}

@Controller('monitor/v1')
@UseGuards(MonitoringTokenGuard)
export class MonitoringController {
  constructor(private readonly observability: ObservabilityService) {}

  /** 내부 Prometheus scraper 전용. 인증값과 요청 URL은 메트릭에 포함하지 않는다. */
  @Get('metrics')
  async metrics(@Res() res: Response): Promise<void> {
    const snapshot = await this.observability.snapshot();
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(this.observability.prometheus(snapshot));
  }
}
