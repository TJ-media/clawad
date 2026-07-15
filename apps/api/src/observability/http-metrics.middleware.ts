import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { performance } from 'node:perf_hooks';
import { classifyRoute, safeHttpMethod } from './observability.constants';
import { OperationalMetricsService } from './operational-metrics.service';

/** 요청 내용은 보지 않고 고정 경로군·HTTP 상태·처리 시간만 누적한다. */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: OperationalMetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const family = classifyRoute(req.path);
    const method = safeHttpMethod(req.method);
    const started = performance.now();
    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      this.metrics.recordHttp(family, method, res.statusCode, performance.now() - started);
    };
    res.once('finish', record);
    res.once('close', record);
    next();
  }
}
