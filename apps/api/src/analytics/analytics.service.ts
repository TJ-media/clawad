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
             e."renderStarted",
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
    // 표시 시작 신호(renderStarted, CLAW-71)가 실린 수신 이벤트 수. 미전송 레거시는 제외된다.
    const renderStarted = impressions.filter((r) => r.renderStarted != null).length;
    return {
      renderStarted,
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

  /** 광고 결정(serveToken 발급) 수. 사용자 미식별 집계 로그에서 servedAt 범위로 센다 (CLAW-71). */
  private async decidedCount(scope: Scope): Promise<number> {
    const params: unknown[] = [scope.from, scope.to];
    const clauses = ['"servedAt" >= $1', '"servedAt" < $2'];
    if (scope.campaignId) clauses.push(`"campaignId" = $${params.push(scope.campaignId)}`);
    if (scope.creativeId) clauses.push(`"creativeId" = $${params.push(scope.creativeId)}`);
    const [row] = await this.dataSource.query(
      `SELECT COUNT(*)::bigint AS count FROM ad_serve_log WHERE ${clauses.join(' AND ')}`,
      params,
    );
    return Number(row?.count ?? 0);
  }

  /**
   * 노출 퍼널 (CLAW-71): 광고 결정 → 표시 시작 → 수신 → 유효 노출 / 거절.
   * 각 단계 수와 전환율·손실 구간을 반환한다. 원시 식별자는 담지 않는다.
   * 주의: decided(ad_serve_log)와 renderStarted는 이 기능 배포 이후분만 채워지므로,
   * 배포 경계를 걸친 구간에서는 전환율이 과소·과대로 보일 수 있다(손실은 음수 방지).
   */
  async funnel(query: AnalyticsQueryDto) {
    const scope = this.scope(query);
    const [impressions, decided] = await Promise.all([this.effective(scope), this.decidedCount(scope)]);
    const received = impressions.length;
    const rendered = impressions.filter((r: any) => r.renderStarted != null).length;
    const valid = impressions.filter((r: any) => r.decision === 'ACCEPTED').length;
    const rejectedRows = impressions.filter((r: any) => r.decision === 'REJECTED');
    const rejectedReasons: Record<string, number> = {};
    for (const row of rejectedRows) {
      if (row.reason) rejectedReasons[row.reason] = (rejectedReasons[row.reason] || 0) + 1;
    }
    const rate = (num: number, den: number) => (den > 0 ? num / den : null);
    return {
      period: { from: scope.from.toISOString(), to: scope.to.toISOString() },
      stages: { decided, rendered, received, valid, rejected: rejectedRows.length },
      conversion: {
        decidedToRendered: rate(rendered, decided),
        renderedToValid: rate(valid, rendered),
        decidedToValid: rate(valid, decided),
      },
      loss: {
        // 발급됐지만 표시 시작 신호가 오지 않음(클라이언트 미표시·미업로드 의심 구간).
        decidedNotRendered: Math.max(0, decided - rendered),
        // 표시는 됐지만 유효 노출/승인에 도달하지 못함(5초 미달·중복·상한 등).
        renderedNotValid: Math.max(0, rendered - valid),
      },
      rejectedReasons,
    };
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
