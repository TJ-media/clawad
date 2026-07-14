import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AnalyticsQueryDto } from './analytics.dto';

type Scope = { from: Date; to: Date; campaignId?: string; creativeId?: string };

/**
 * 운영 대시보드 집계. 원본 impression_events가 아니라 최신 판정 전이를 합성한 값만 사용한다.
 * 사용자·기기·토큰 등 원시 식별자는 절대 반환하지 않는다.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly dataSource: DataSource) {}

  private scope(query: AnalyticsQueryDto): Scope {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
      throw new BadRequestException({ error: 'INVALID_DATE_RANGE' });
    }
    return { from, to, campaignId: query.campaignId, creativeId: query.creativeId };
  }

  private where(scope: Scope, alias: string, params: unknown[]) {
    const clauses = [`${alias}."receivedAt" >= $${params.push(scope.from)}`, `${alias}."receivedAt" < $${params.push(scope.to)}`];
    if (scope.campaignId) clauses.push(`${alias}."campaignId" = $${params.push(scope.campaignId)}`);
    if (scope.creativeId) clauses.push(`${alias}."creativeId" = $${params.push(scope.creativeId)}`);
    return clauses.join(' AND ');
  }

  private async effective(scope: Scope) {
    const params: unknown[] = [];
    const where = this.where(scope, 'e', params);
    return this.dataSource.query(`
      SELECT e."campaignId", e."creativeId", e."campaignType", e."userId", e."startedAt", e."endedAt",
             COALESCE(t."toDecision", e.decision) AS decision,
             COALESCE(t.billed, e.billed) AS billed,
             COALESCE(t.reason, e.reason) AS reason,
             e."receivedAt"
      FROM impression_events e
      LEFT JOIN LATERAL (
        SELECT x."toDecision", x.billed, x.reason
        FROM impression_decision_transitions x
        WHERE x."impressionEventId" = e.id
        ORDER BY x.id DESC LIMIT 1
      ) t ON true
      WHERE ${where}
    `, params);
  }

  private async clicks(scope: Scope) {
    const params: unknown[] = [scope.from, scope.to];
    const clauses = ['"createdAt" >= $1', '"createdAt" < $2'];
    if (scope.campaignId) clauses.push(`"campaignId" = $${params.push(scope.campaignId)}`);
    if (scope.creativeId) clauses.push(`"creativeId" = $${params.push(scope.creativeId)}`);
    return this.dataSource.query(`SELECT "campaignId", "creativeId", "createdAt" FROM click_events WHERE ${clauses.join(' AND ')}`, params);
  }

  private metrics(impressions: any[], clicks: any[]) {
    const accepted = impressions.filter((r) => r.decision === 'ACCEPTED');
    const invalid = impressions.filter((r) => r.decision === 'REJECTED');
    const durationMs = accepted.reduce((sum, r) => sum + Math.max(0, Number(r.endedAt) - Number(r.startedAt)), 0);
    const billed = accepted.filter((r) => r.billed).length;
    const uniqueReach = new Set(accepted.map((r) => r.userId)).size;
    const uniqueClicks = clicks.length;
    return {
      // 표시 시작 신호는 아직 수집하지 않는다. 받은 완료 이벤트를 시작 수로 대체하지 않는다.
      renderStarted: null,
      validImpressions: accepted.length,
      invalidImpressions: invalid.length,
      validImpressionRate: null,
      activeDisplayDurationMs: durationMs,
      averageActiveDisplayDurationMs: accepted.length ? Math.floor(durationMs / accepted.length) : 0,
      uniqueReach,
      frequency: uniqueReach ? accepted.length / uniqueReach : 0,
      clicks: clicks.length,
      uniqueClicks,
      ctr: accepted.length ? uniqueClicks / accepted.length : 0,
      billedImpressions: billed,
    };
  }

  async summary(query: AnalyticsQueryDto) {
    const scope = this.scope(query);
    const [impressions, clicks] = await Promise.all([this.effective(scope), this.clicks(scope)]);
    const invalidReasons: Record<string, number> = {};
    for (const row of impressions) {
      if (row.decision === 'REJECTED' && row.reason) invalidReasons[row.reason] = (invalidReasons[row.reason] || 0) + 1;
    }
    const spent = await this.spent(scope);
    return { period: { from: scope.from.toISOString(), to: scope.to.toISOString() }, ...this.metrics(impressions, clicks), invalidReasons, ...spent,
      displayTimeLabel: 'Claude 작업 활성 구간 표시시간' };
  }

  private async spent(scope: Scope) {
    if (!scope.campaignId) return { budgetSpentKrw: null, budgetBurnRate: null };
    const [row] = await this.dataSource.query(
      `SELECT COALESCE(-SUM(CASE WHEN "entryType" = 'CAPTURE' THEN "amountKrw" ELSE 0 END), 0)::bigint AS spent,
              COALESCE(SUM("amountKrw"), 0)::bigint AS available
       FROM billing_ledger WHERE "campaignId" = $1`, [scope.campaignId]);
    const spent = Number(row.spent);
    const available = Number(row.available);
    return { budgetSpentKrw: spent, budgetBurnRate: spent + available > 0 ? spent / (spent + available) : 0 };
  }

  async timeSeries(query: AnalyticsQueryDto) {
    const scope = this.scope(query);
    const [impressions, clicks] = await Promise.all([this.effective(scope), this.clicks(scope)]);
    const byDay = new Map<string, { impressions: any[]; clicks: any[] }>();
    const day = (value: string | Date) => new Date(value).toISOString().slice(0, 10);
    for (const row of impressions) { const key = day(row.receivedAt); const value = byDay.get(key) || { impressions: [], clicks: [] }; value.impressions.push(row); byDay.set(key, value); }
    for (const row of clicks) { const key = day(row.createdAt); const value = byDay.get(key) || { impressions: [], clicks: [] }; value.clicks.push(row); byDay.set(key, value); }
    return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, ...this.metrics(value.impressions, value.clicks) }));
  }

  async breakdown(query: AnalyticsQueryDto, dimension: 'campaign' | 'creative' = 'campaign') {
    const scope = this.scope(query);
    const [impressions, clicks] = await Promise.all([this.effective(scope), this.clicks(scope)]);
    const key = dimension === 'creative' ? 'creativeId' : 'campaignId';
    const groups = new Map<string, { impressions: any[]; clicks: any[] }>();
    for (const row of impressions) { const id = row[key]; if (!id) continue; const value = groups.get(id) || { impressions: [], clicks: [] }; value.impressions.push(row); groups.set(id, value); }
    for (const row of clicks) { const id = row[key]; const value = groups.get(id) || { impressions: [], clicks: [] }; value.clicks.push(row); groups.set(id, value); }
    return [...groups.entries()].map(([id, value]) => ({ [dimension === 'creative' ? 'creativeId' : 'campaignId']: id, ...this.metrics(value.impressions, value.clicks) }))
      .sort((a, b) => b.validImpressions - a.validImpressions);
  }

  async csv(query: AnalyticsQueryDto) {
    const [summary, series, campaigns, creatives] = await Promise.all([this.summary(query), this.timeSeries(query), this.breakdown(query, 'campaign'), this.breakdown(query, 'creative')]);
    const lines = ['section,date,campaignId,creativeId,validImpressions,invalidImpressions,clicks,uniqueClicks,ctr,billedImpressions,activeDisplayDurationMs'];
    const add = (section: string, row: any) => lines.push([section, row.date || '', row.campaignId || '', row.creativeId || '', row.validImpressions, row.invalidImpressions, row.clicks, row.uniqueClicks, row.ctr, row.billedImpressions, row.activeDisplayDurationMs].join(','));
    add('summary', summary); series.forEach((row) => add('daily', row)); campaigns.forEach((row) => add('campaign', row)); creatives.forEach((row) => add('creative', row));
    return lines.join('\n') + '\n';
  }
}
