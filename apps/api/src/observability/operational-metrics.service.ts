import { Injectable } from '@nestjs/common';
import {
  HTTP_LATENCY_BUCKETS_MS,
  ObservedHttpMethod,
  RouteFamily,
  safeHttpStatus,
  UPLOAD_DELAY_BUCKETS_MS,
} from './observability.constants';

interface HttpMetricRow {
  routeFamily: RouteFamily;
  method: ObservedHttpMethod;
  status: string;
  requests: number;
  errors: number;
  durationMsSum: number;
  durationMsMax: number;
  durationBuckets: Record<string, number>;
}

export interface HttpMetricSnapshot {
  startedAt: string;
  requests: number;
  errors: number;
  errorRate: number;
  averageLatencyMs: number;
  maxLatencyMs: number;
  rows: HttpMetricRow[];
}

export interface SyncMetricSnapshot {
  uploadRequests: number;
  receivedEvents: number;
  acceptedEvents: number;
  rejectedEvents: number;
  uploadDelaySamples: number;
  uploadDelayMsSum: number;
  uploadDelayMsMax: number;
  averageUploadDelayMs: number;
  uploadDelayBuckets: Record<string, number>;
}

interface EventsResultLike {
  received: number;
  accepted: number;
  rejected: Record<string, number>;
}

interface EventTimeLike {
  endedAt?: unknown;
}

const MAX_OBSERVED_DELAY_MS = 30 * 24 * 60 * 60 * 1_000;

/** 프로세스 내부 누적값. 원본 요청·URL·본문·식별자·오류 문자열은 받지도 저장하지도 않는다. */
@Injectable()
export class OperationalMetricsService {
  private readonly startedAt = new Date().toISOString();
  private readonly http = new Map<string, HttpMetricRow>();
  private readonly sync = {
    uploadRequests: 0,
    receivedEvents: 0,
    acceptedEvents: 0,
    rejectedEvents: 0,
    uploadDelaySamples: 0,
    uploadDelayMsSum: 0,
    uploadDelayMsMax: 0,
    uploadDelayBuckets: Object.fromEntries(UPLOAD_DELAY_BUCKETS_MS.map((bucket) => [String(bucket), 0])),
  };

  recordHttp(routeFamily: RouteFamily, method: ObservedHttpMethod, responseStatus: number, durationMs: number): void {
    const status = safeHttpStatus(responseStatus);
    const key = `${method}:${routeFamily}:${status}`;
    const safeDuration = Number.isFinite(durationMs) ? Math.max(0, Math.min(durationMs, MAX_OBSERVED_DELAY_MS)) : 0;
    const row = this.http.get(key) ?? {
      routeFamily,
      method,
      status,
      requests: 0,
      errors: 0,
      durationMsSum: 0,
      durationMsMax: 0,
      durationBuckets: Object.fromEntries(HTTP_LATENCY_BUCKETS_MS.map((bucket) => [String(bucket), 0])),
    };
    row.requests += 1;
    if (responseStatus >= 400) row.errors += 1;
    row.durationMsSum += safeDuration;
    row.durationMsMax = Math.max(row.durationMsMax, safeDuration);
    for (const bucket of HTTP_LATENCY_BUCKETS_MS) {
      if (safeDuration <= bucket) row.durationBuckets[String(bucket)] += 1;
    }
    this.http.set(key, row);
  }

  recordSyncUpload(result: EventsResultLike, events: EventTimeLike[], observedAt = Date.now()): void {
    const received = Number.isInteger(result.received) && result.received >= 0 ? result.received : 0;
    const accepted = Number.isInteger(result.accepted) && result.accepted >= 0 ? result.accepted : 0;
    const rejected = Object.values(result.rejected ?? {}).reduce(
      (sum, value) => sum + (Number.isInteger(value) && value >= 0 ? value : 0),
      0,
    );
    this.sync.uploadRequests += 1;
    this.sync.receivedEvents += received;
    this.sync.acceptedEvents += accepted;
    this.sync.rejectedEvents += rejected;

    for (const event of events) {
      if (typeof event.endedAt !== 'number' || !Number.isFinite(event.endedAt)) continue;
      const delay = Math.max(0, Math.min(observedAt - event.endedAt, MAX_OBSERVED_DELAY_MS));
      this.sync.uploadDelaySamples += 1;
      this.sync.uploadDelayMsSum += delay;
      this.sync.uploadDelayMsMax = Math.max(this.sync.uploadDelayMsMax, delay);
      for (const bucket of UPLOAD_DELAY_BUCKETS_MS) {
        if (delay <= bucket) this.sync.uploadDelayBuckets[String(bucket)] += 1;
      }
    }
  }

  httpSnapshot(): HttpMetricSnapshot {
    const rows = [...this.http.values()]
      .map((row) => ({ ...row, durationBuckets: { ...row.durationBuckets } }))
      .sort((a, b) => `${a.method}:${a.routeFamily}:${a.status}`.localeCompare(`${b.method}:${b.routeFamily}:${b.status}`));
    const requests = rows.reduce((sum, row) => sum + row.requests, 0);
    const errors = rows.reduce((sum, row) => sum + row.errors, 0);
    const durationMsSum = rows.reduce((sum, row) => sum + row.durationMsSum, 0);
    const maxLatencyMs = rows.reduce((max, row) => Math.max(max, row.durationMsMax), 0);
    return {
      startedAt: this.startedAt,
      requests,
      errors,
      errorRate: requests ? errors / requests : 0,
      averageLatencyMs: requests ? durationMsSum / requests : 0,
      maxLatencyMs,
      rows,
    };
  }

  syncSnapshot(): SyncMetricSnapshot {
    return {
      ...this.sync,
      uploadDelayBuckets: { ...this.sync.uploadDelayBuckets },
      averageUploadDelayMs: this.sync.uploadDelaySamples
        ? this.sync.uploadDelayMsSum / this.sync.uploadDelaySamples
        : 0,
    };
  }
}
