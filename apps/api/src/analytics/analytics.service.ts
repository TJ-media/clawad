import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AnalyticsQueryDto } from './analytics.dto';
import { loadPolicy, policyDayKey } from '../common/policy';

type Scope = { from: Date; to: Date; campaignId?: string; creativeId?: string };

// 기기 등록 직후에는 광고를 볼 시간이 없다. 이 유예가 지난 기기만 오버레이 도달 여부를 판정한다.
// 짧으면 정상 설치가 미도달로 잡히고, 길면 회귀를 늦게 본다.
const OVERLAY_REACH_SETTLE_HOURS = 24;

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

  /**
   * 설치 퍼널: 기기 등록 → 첫 광고 표시 도달.
   *
   * CLAW-134 이후 광고를 표시하는 창구는 오버레이뿐이다. 따라서 등록된 지 충분히 지났는데
   * 노출이 한 건도 없는 기기는 오버레이가 설치되지 않았거나 실행되지 않는다는 신호다.
   * 이 비율이 CLAW-146(자체 도메인 배포) 착수 여부의 판단 근거가 된다.
   *
   * **새 수집 항목을 만들지 않는다.** 처리방침이 오류 로그 미수집을 명시하므로 실패 "사유"는
   * 서버로 오지 않는다. 여기서는 이미 있는 machines·impression_events만으로 규모를 센다.
   * 사유는 단말 표시(CLAW-144)와 문의 창구로만 확인한다.
   *
   * 캠페인·소재 필터는 적용하지 않는다 — 설치는 캠페인에 속한 사건이 아니다.
   */
  async installFunnel(query: AnalyticsQueryDto) {
    const scope = this.scope(query);
    const settleBefore = new Date(Date.now() - OVERLAY_REACH_SETTLE_HOURS * 3600 * 1000);
    // impression_events에는 "machineId" 인덱스가 없다. 기기마다 EXISTS를 걸면 기기 수 × 이벤트
    // 전체 스캔이 되어, 기기 4천·이벤트 9만 규모에서 이미 14초가 걸렸다. 노출 기기 집합을
    // 한 번만 만들어 조인하면 같은 결과가 46ms다. 이벤트는 앞으로도 계속 늘어나는 표다.
    const [row] = await this.dataSource.query(`
      SELECT
        COUNT(*)::bigint AS registered,
        COUNT(i."machineId")::bigint AS reached
      FROM machines m
      LEFT JOIN (SELECT DISTINCT "machineId" FROM impression_events) i ON i."machineId" = m."machineId"
      WHERE m."registeredAt" >= $1 AND m."registeredAt" < $2 AND m."registeredAt" < $3
    `, [scope.from, scope.to, settleBefore]);
    const registered = Number(row?.registered ?? 0);
    const reached = Number(row?.reached ?? 0);
    return {
      period: { from: scope.from.toISOString(), to: scope.to.toISOString() },
      // 이 시각 이후 등록분은 아직 판정하지 않는다. 분모에서 빠진다.
      settledBefore: settleBefore.toISOString(),
      stages: { registered, reachedOverlay: reached },
      conversion: { registeredToOverlay: registered > 0 ? reached / registered : null },
      // 오버레이 미도달 = 광고·적립이 0인 기기. 설치가 끝까지 성공하지 못한 규모다.
      loss: { registeredNotReached: Math.max(0, registered - reached) },
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
    // 리포트의 "하루"는 상한·적립의 "하루"와 같아야 한다 (CLAW-151). 어긋나면 운영자가
    // 리포트 수치와 일일 상한을 나란히 놓고 진단할 때 조용히 틀린 결론이 나온다.
    const shiftMinutes = loadPolicy().reward.policyDayShiftMinutes;
    const day = (value: string | Date) => policyDayKey(new Date(value), shiftMinutes);
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

  /**
   * 알파 운영 현황: 가입·기기·활동 사용자·리워드 집계.
   * 총계(users/machines/rewards)는 전체 기간 기준이고, 시계열·기간 값만 from/to 범위를 따른다.
   * campaignId/creativeId 필터는 활동(activity) 집계에만 적용된다.
   * 전부 집계값이며 사용자·기기 등 원시 식별자는 반환하지 않는다.
   */
  async alphaOverview(query: AnalyticsQueryDto) {
    const scope = this.scope(query);
    // 정책일 경계 (CLAW-151). 가입자 집계는 DB에서 날짜를 떼므로 SQL도 같은 만큼 민다 —
    // JS 쪽(activeByDay)만 옮기면 같은 리포트 안에서 가입자와 활성 사용자가 다른 하루를 센다.
    const shiftMinutes = loadPolicy().reward.policyDayShiftMinutes;
    const [userRows, signupRows, machineRows, rewardTypeRows, confirmedRow, verifyingRow, impressions] = await Promise.all([
      this.dataSource.query(`SELECT status, COUNT(*)::bigint AS count FROM users GROUP BY status`),
      this.dataSource.query(
        `SELECT to_char(("createdAt" AT TIME ZONE 'UTC') + make_interval(mins => $3::int), 'YYYY-MM-DD') AS date,
                COUNT(*)::bigint AS count
         FROM users WHERE "createdAt" >= $1 AND "createdAt" < $2 GROUP BY 1 ORDER BY 1`,
        [scope.from, scope.to, shiftMinutes],
      ),
      this.dataSource.query(`SELECT status, COUNT(*)::bigint AS count FROM machines GROUP BY status`),
      this.dataSource.query(
        `SELECT "entryType", COUNT(*)::bigint AS entries, COALESCE(SUM(points),0)::bigint AS points,
                COUNT(DISTINCT "userId")::bigint AS users
         FROM reward_ledger GROUP BY "entryType"`,
      ),
      // 확정 잔액 합(플랫폼 전체). 산식은 RewardService.confirmedBalance와 동일해야 한다.
      this.dataSource.query(
        `SELECT COALESCE(SUM(r.points),0)::bigint AS s FROM reward_ledger r
         WHERE r."entryType" IN ('ACCRUE_CONFIRM','PROMO_ACCRUE','REDEEM_DEBIT','ADMIN_ADJUST')
            OR (r."entryType" = 'REPROJECTION_ADJUST' AND r.reason = 'CONCURRENT_REPROJECTION_CONFIRMED')
            OR (r."entryType" = 'CLAW_BACK' AND EXISTS (
                SELECT 1 FROM reward_ledger c
                WHERE c."refIdempotencyKey" = r."refIdempotencyKey"
                  AND c."entryType" IN ('ACCRUE_CONFIRM','PROMO_ACCRUE')))`,
      ),
      // 검증 중 합(아직 확정·회수되지 않은 accrue_pending). RewardService.summary와 동일 산식.
      this.dataSource.query(
        `SELECT COALESCE(SUM(p.points),0)::bigint AS s FROM reward_ledger p
         WHERE p."entryType" = 'ACCRUE_PENDING'
           AND NOT EXISTS (
             SELECT 1 FROM reward_ledger x
             WHERE x."refIdempotencyKey" = p."refIdempotencyKey"
               AND x."entryType" IN ('ACCRUE_CONFIRM','CLAW_BACK'))`,
      ),
      this.effective(scope),
    ]);

    const byStatus = (rows: Array<{ status: string; count: string }>) => {
      const out: Record<string, number> = {};
      let total = 0;
      for (const row of rows) { out[row.status] = Number(row.count); total += Number(row.count); }
      return { total, byStatus: out };
    };

    const signupsByDay = signupRows.map((row: { date: string; count: string }) => ({ date: row.date, count: Number(row.count) }));
    const day = (value: string | Date) => policyDayKey(new Date(value), shiftMinutes);
    const activeByDay = new Map<string, { activeUsers: Set<string>; viewers: Set<string>; validImpressions: number }>();
    const activeUsers = new Set<string>();
    const viewers = new Set<string>();
    for (const row of impressions) {
      const key = day(row.receivedAt);
      const value = activeByDay.get(key) || { activeUsers: new Set<string>(), viewers: new Set<string>(), validImpressions: 0 };
      value.activeUsers.add(row.userId);
      activeUsers.add(row.userId);
      if (row.decision === 'ACCEPTED') {
        value.viewers.add(row.userId);
        viewers.add(row.userId);
        value.validImpressions++;
      }
      activeByDay.set(key, value);
    }

    const rewardsByType: Record<string, { entries: number; points: number; users: number }> = {};
    for (const row of rewardTypeRows) {
      rewardsByType[row.entryType] = { entries: Number(row.entries), points: Number(row.points), users: Number(row.users) };
    }

    return {
      period: { from: scope.from.toISOString(), to: scope.to.toISOString() },
      users: { ...byStatus(userRows), newInPeriod: signupsByDay.reduce((sum: number, row: { count: number }) => sum + row.count, 0), signupsByDay },
      machines: byStatus(machineRows),
      activity: {
        activeUsers: activeUsers.size,
        viewers: viewers.size,
        byDay: [...activeByDay.entries()].sort(([a], [b]) => a.localeCompare(b))
          .map(([date, value]) => ({ date, activeUsers: value.activeUsers.size, viewers: value.viewers.size, validImpressions: value.validImpressions })),
      },
      rewards: {
        byType: rewardsByType,
        confirmedBalancePoints: Number(confirmedRow[0].s),
        verifyingPoints: Number(verifyingRow[0].s),
      },
    };
  }

  async csv(query: AnalyticsQueryDto) {
    const [summary, series, campaigns, creatives] = await Promise.all([this.summary(query), this.timeSeries(query), this.breakdown(query, 'campaign'), this.breakdown(query, 'creative')]);
    const lines = ['section,date,campaignId,creativeId,validImpressions,invalidImpressions,clicks,uniqueClicks,ctr,billedImpressions,activeDisplayDurationMs'];
    const add = (section: string, row: any) => lines.push([section, row.date || '', row.campaignId || '', row.creativeId || '', row.validImpressions, row.invalidImpressions, row.clicks, row.uniqueClicks, row.ctr, row.billedImpressions, row.activeDisplayDurationMs].join(','));
    add('summary', summary); series.forEach((row) => add('daily', row)); campaigns.forEach((row) => add('campaign', row)); creatives.forEach((row) => add('creative', row));
    return lines.join('\n') + '\n';
  }
}
