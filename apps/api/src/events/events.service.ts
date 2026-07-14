import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DataSource, EntityManager } from 'typeorm';
import { BudgetService } from '../campaigns/budget.service';
import { FrequencyService } from '../campaigns/frequency.service';
import { ServeTokenService } from '../campaigns/serve-token.service';
import { loadPolicy } from '../common/policy';
import { Campaign, CampaignStatus, CampaignType } from '../entities/campaign.entity';
import { BillingEntryType, BillingLedgerEntry } from '../entities/billing-ledger.entity';
import { ImpressionDecisionTransition } from '../entities/impression-decision-transition.entity';
import { ImpressionDecision, ImpressionEvent } from '../entities/impression-event.entity';
import { KillSwitchTarget } from '../entities/kill-switch.entity';
import { Machine, MachineStatus } from '../entities/machine.entity';
import { RewardEntryType, RewardFunding, RewardLedgerEntry } from '../entities/reward-ledger.entity';
import { KillSwitchService } from './kill-switch.service';

/** 클라이언트가 보내는 사실 필드. userId는 여기 없다 — 서버가 세션으로 확정한다 (CLAW-18). */
export interface FactEvent {
  serveToken: string;
  sequence: number;
  machineId: string;
  startedAt: number;
  endedAt: number;
  clientVersion?: string;
}

export interface EventsResult {
  received: number;
  accepted: number;
  rejected: Record<string, number>;
}

/** 캠페인 유형별 자격 판정은 참조 구현을 재사용한다 (server/lib/campaign.js). */
interface CampaignLib {
  eligibility(campaign: { type: string; rewardPolicyId?: string | null; houseRewardOptIn?: boolean }): {
    billingEligible: boolean;
    rewardEligible: boolean;
    testOnly: boolean;
  };
}
interface ConcurrentLib {
  projectConcurrent(
    candidates: { startedAt: number; endedAt: number; impressionKey: string }[],
    toleranceMs: number,
  ): Set<string>;
}
const require_ = createRequire(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const campaignLib: CampaignLib = require_(join(REPO_ROOT, 'server', 'lib', 'campaign.js'));
const concurrentLib: ConcurrentLib = require_(join(REPO_ROOT, 'server', 'lib', 'concurrentDedup.js'));

interface ProjectionRow {
  event: ImpressionEvent;
  effectiveDecision: ImpressionDecision;
  billed: boolean;
  rewardEligible: boolean;
  companyFunded: boolean;
}

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly serveToken: ServeTokenService,
    private readonly budget: BudgetService,
    private readonly frequency: FrequencyService,
    private readonly killSwitch: KillSwitchService,
  ) {}

  /**
   * 노출 검증 파이프라인. 배치의 모든 이벤트는 인증된 한 사용자(userId)의 것이다.
   *
   * 같은 계정의 동시 노출을 한 건만 인정하기 위해, 배치 전체를 계정 advisory 잠금 트랜잭션에서
   * 처리한다. 다른 계정의 배치는 서로 다른 잠금을 잡으므로 병렬 처리된다. capture도 같은
   * 트랜잭션에서 수행해 잠금을 우회하지 않는다.
   */
  async process(userId: string, events: FactEvent[], now = Date.now()): Promise<EventsResult> {
    const rejected: Record<string, number> = {};
    let accepted = 0;
    const bump = (reason: string) => (rejected[reason] = (rejected[reason] || 0) + 1);

    // Redis 부수효과(토큰 소비·빈도 카운터)는 PG 트랜잭션 커밋 후에 실행한다.
    // 트랜잭션이 롤백되면 impression_events 행이 없는데 Redis만 바뀌는 드리프트를 막는다.
    const postCommit: Array<() => Promise<void>> = [];

    await this.dataSource.transaction(async (manager) => {
      // 계정 단위 직렬화. uuid를 정수로 해싱해 advisory 잠금 키로 쓴다.
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`clawad:user:${userId}`]);

      // 같은 배치 안에서는 서버의 안정 정렬을 먼저 적용해 응답 집계도 최종 재투영과 일치시킨다.
      const orderedEvents = [...events].sort((a, b) => {
        const byStart = Number(a?.startedAt ?? 0) - Number(b?.startedAt ?? 0);
        if (byStart !== 0) return byStart;
        return this.stableEventKey(a, now).localeCompare(this.stableEventKey(b, now));
      });
      for (const ev of orderedEvents) {
        const outcome = await this.processOne(manager, userId, ev, now, postCommit);
        if (outcome.decision === ImpressionDecision.ACCEPTED) {
          accepted++;
        } else {
          bump(outcome.reason);
        }
      }
    });

    // 커밋 성공 후에만 Redis 부수효과를 적용한다.
    for (const effect of postCommit) {
      try {
        await effect();
      } catch (e) {
        // 카운터/소비 반영 실패는 방향상 보수적(과대적립 아님)이다. 원장은 이미 확정됐다.
        this.logger.warn(`post-commit 효과 실패: ${(e as Error).message}`);
      }
    }

    return { received: events.length, accepted, rejected };
  }

  private stableEventKey(ev: FactEvent, now: number): string {
    if (typeof ev?.serveToken !== 'string' || typeof ev?.machineId !== 'string' || !Number.isInteger(ev?.sequence)) {
      return '';
    }
    const verified = this.serveToken.verify(ev.serveToken, now);
    return verified.ok ? this.serveToken.idempotencyKey(verified.payload.jti, ev.machineId, ev.sequence) : '';
  }

  private badShape(ev: FactEvent): boolean {
    return (
      typeof ev?.serveToken !== 'string' ||
      !Number.isInteger(ev?.sequence) ||
      ev.sequence <= 0 ||
      typeof ev?.machineId !== 'string' ||
      !/^[0-9a-f]{32}$/.test(ev.machineId) ||
      typeof ev?.startedAt !== 'number' ||
      typeof ev?.endedAt !== 'number'
    );
  }

  private async processOne(
    manager: EntityManager,
    userId: string,
    ev: FactEvent,
    now: number,
    postCommit: Array<() => Promise<void>>,
  ): Promise<{ decision: ImpressionDecision.ACCEPTED } | { decision: ImpressionDecision.REJECTED; reason: string }> {
    const policy = loadPolicy();

    if (this.badShape(ev)) return { decision: ImpressionDecision.REJECTED, reason: 'BAD_REQUEST' };

    // 1. 토큰 서명·만료
    const v = this.serveToken.verify(ev.serveToken, now);
    if (!v.ok) return { decision: ImpressionDecision.REJECTED, reason: v.reason }; // BAD_TOKEN | EXPIRED
    const payload = v.payload;

    // 2. 토큰-기기 바인딩. 토큰은 발급받은 기기에서만 쓸 수 있다.
    if (payload.machineId !== ev.machineId) {
      return { decision: ImpressionDecision.REJECTED, reason: 'BAD_TOKEN' };
    }

    // 토큰-사용자 바인딩. 다른 계정이 토큰을 제출해도 정상 사용자의 멱등 키를
    // 선점하거나 과금·리워드를 만들 수 없도록 원장 기록 전에 거절한다(CLAW-40).
    if (payload.userId !== userId) {
      return { decision: ImpressionDecision.REJECTED, reason: 'TOKEN_USER_MISMATCH' };
    }

    // 3. 서버 생성 멱등 키
    const idem = this.serveToken.idempotencyKey(payload.jti, ev.machineId, ev.sequence);

    // 4. 멱등: 이미 처리된 노출은 이전 결과를 그대로 반환한다(중복 집계·과금 없음).
    //    멱등 재전송을 registry 대조보다 먼저 본다 — 정상 소비된 토큰의 재전송이 폐기로 오판되지 않게.
    const prior = await manager.findOne(ImpressionEvent, { where: { idempotencyKey: idem } });
    if (prior) {
      const effective = await this.effectiveProjection(manager, prior);
      return effective.effectiveDecision === ImpressionDecision.ACCEPTED
        ? { decision: ImpressionDecision.ACCEPTED }
        : { decision: ImpressionDecision.REJECTED, reason: prior.reason || 'DUPLICATE' };
    }

    // 토큰 발급 뒤 머신이 해제·차단될 수 있으므로 수집 시점에도 계정 소유와 ACTIVE
    // 상태를 다시 확인한다. 정상 멱등 재전송은 위에서 기존 최종 결과를 그대로 반환한다.
    const machine = await manager.findOne(Machine, { where: { userId, machineId: ev.machineId } });
    if (!machine) {
      return this.record(manager, userId, ev, payload, idem, ImpressionDecision.REJECTED, 'MACHINE_NOT_REGISTERED');
    }
    if (machine.status !== MachineStatus.ACTIVE) {
      return this.record(manager, userId, ev, payload, idem, ImpressionDecision.REJECTED, 'MACHINE_NOT_ACTIVE');
    }

    // 5. 토큰 재사용: 같은 jti가 다른 멱등 키(다른 machine/sequence)로 이미 원장에 있으면 재사용이다.
    //    (소비된 토큰은 registry에서 사라지므로, 재사용을 registry 대조보다 먼저 정확히 잡는다.)
    const jtiUsed = await manager.count(ImpressionEvent, { where: { tokenJti: payload.jti } });
    if (jtiUsed > 0) {
      return this.record(manager, userId, ev, payload, idem, ImpressionDecision.REJECTED, 'TOKEN_REUSE');
    }

    // 6. 발급 registry 대조: 제출 토큰의 SHA-256이 발급 시 저장값과 일치하는지 본다 (CLAW-18 §2).
    //    폐기(revokeUnused)·미발급 토큰은 known=false → 서명이 유효해도 인정하지 않는다.
    const reg = await this.serveToken.registryMatches(payload.jti, ev.serveToken);
    if (!reg.known || !reg.matches) {
      return this.record(manager, userId, ev, payload, idem, ImpressionDecision.REJECTED, 'TOKEN_REVOKED');
    }

    // 6. 킬스위치 (머신/회원/캠페인). 걸리면 수집 거부(REJECTED KILLED).
    if (
      (await this.killSwitch.isKilled(KillSwitchTarget.MACHINE, ev.machineId)) ||
      (await this.killSwitch.isKilled(KillSwitchTarget.USER, userId)) ||
      (await this.killSwitch.isKilled(KillSwitchTarget.CAMPAIGN, payload.campaignId))
    ) {
      return this.record(manager, userId, ev, payload, idem, ImpressionDecision.REJECTED, 'KILLED');
    }

    // 7. viewability
    if (ev.endedAt - ev.startedAt < policy.impression.minViewMs) {
      return this.record(manager, userId, ev, payload, idem, ImpressionDecision.REJECTED, 'BAD_INTERVAL');
    }

    // 8. 시간 창: 표시 구간이 토큰 유효 구간과 서버 수신 시각을 벗어날 수 없다 (CLAW-18 §5).
    //    허용오차는 정책값. 코드에 하드코딩하지 않는다 (CLAW-12).
    const tolerance = policy.impression.timeWindowToleranceMs;
    const withinWindow =
      ev.startedAt >= payload.issuedAt - tolerance && ev.endedAt <= now + tolerance && ev.startedAt <= ev.endedAt;
    if (!withinWindow) {
      return this.record(manager, userId, ev, payload, idem, ImpressionDecision.REJECTED, 'BAD_INTERVAL');
    }

    // 9. 캠페인 활성 상태
    const campaign = await manager.findOne(Campaign, { where: { id: payload.campaignId } });
    if (!campaign || campaign.status !== CampaignStatus.ACTIVE) {
      return this.record(manager, userId, ev, payload, idem, ImpressionDecision.REJECTED, 'CAMPAIGN_INACTIVE');
    }

    // 10. 동시 노출 전체 재투영. 영향 구간의 기존 승인·동시거절 후보와 새 후보를
    // (startedAt, idempotencyKey) 순서로 다시 계산해 업로드 도착 순서를 제거한다(CLAW-42).
    const projection = await this.concurrentProjection(
      manager,
      userId,
      { startedAt: ev.startedAt, endedAt: ev.endedAt, impressionKey: idem },
      policy.impression.concurrentToleranceMs,
    );
    if (!projection.candidateAccepted) {
      return this.record(
        manager,
        userId,
        ev,
        payload,
        idem,
        ImpressionDecision.REJECTED,
        'CONCURRENT_USER_IMPRESSION',
      );
    }

    // 11. 최종 상한은 Redis가 아니라 같은 계정 잠금 트랜잭션의 PostgreSQL 유효 원장으로 판정한다(CLAW-43).
    // Redis는 ad-decision 단계의 조언적 필터이며, 유실되거나 반영이 늦어도 여기서 과대 승인을 막는다.
    if (await this.postgresCapReached(manager, userId, campaign, projection.changes, policy)) {
      // 상한 초과는 조용히 미적립. 클라이언트 오류가 아니다.
      return this.record(manager, userId, ev, payload, idem, ImpressionDecision.REJECTED, 'OVER_CAP');
    }

    // 새 후보가 모든 검증을 통과한 뒤에만 기존 후보의 판정·과금·리워드 정정을 append한다.
    await this.applyProjectionChanges(manager, projection.changes);

    // --- 여기부터 ACCEPTED ---
    const elig = campaignLib.eligibility({
      type: campaign.type,
      rewardPolicyId: campaign.rewardPolicyId,
      houseRewardOptIn: Boolean(campaign.rewardPolicyId),
    });

    let billed = false;
    let companyFunded = false;
    if (elig.billingEligible) {
      const cap = await this.budget.captureWithManager(manager, campaign.id, idem);
      if (cap.captured) {
        billed = true;
      } else if (cap.reason === 'BUDGET_EXHAUSTED') {
        // 사용자가 유효 표시한 뒤 예산 소진. 광고주 과금 없이 리워드는 회사 재원으로 적립한다.
        companyFunded = elig.rewardEligible;
      }
      // NOT_BILLABLE은 여기 오지 않는다(billingEligible=true).
    }

    // 토큰 소비(CONSUMED 전이)와 빈도 카운터 증가는 커밋 후에 실행한다(Redis 부수효과).
    const advertiserId = campaign.advertiserId;
    const campaignId = campaign.id;
    const creativeId = payload.creativeId;
    const machineId = ev.machineId;
    postCommit.push(async () => {
      await this.serveToken.consume(payload.jti, machineId); // 재사용 불가
      await this.frequency.recordAcceptedImpression(userId, advertiserId, campaignId, creativeId);
    });

    const rewardEligible = elig.rewardEligible;
    await this.record(manager, userId, ev, payload, idem, ImpressionDecision.ACCEPTED, null, {
      billed,
      rewardEligible,
      companyFunded,
    });

    return { decision: ImpressionDecision.ACCEPTED };
  }

  private async effectiveProjection(manager: EntityManager, event: ImpressionEvent): Promise<ProjectionRow> {
    const latest = await manager.findOne(ImpressionDecisionTransition, {
      where: { impressionEventId: event.id },
      order: { id: 'DESC' },
    });
    return {
      event,
      effectiveDecision: latest?.toDecision ?? event.decision,
      billed: latest?.billed ?? event.billed,
      rewardEligible: latest?.rewardEligible ?? event.rewardEligible,
      companyFunded: latest?.companyFunded ?? event.companyFunded,
    };
  }

  private async concurrentProjection(
    manager: EntityManager,
    userId: string,
    candidate: { startedAt: number; endedAt: number; impressionKey: string },
    toleranceMs: number,
  ): Promise<{ candidateAccepted: boolean; changes: Array<{ row: ProjectionRow; target: ImpressionDecision }> }> {
    const found = new Map<string, ProjectionRow>();
    let minStartedAt = candidate.startedAt;
    let maxEndedAt = candidate.endedAt;

    // 연쇄 겹침으로 영향 범위가 넓어질 수 있으므로 새 행이 없을 때까지 구간을 확장한다.
    for (;;) {
      const rows = await manager.query(
        `SELECT e.*,
                COALESCE(t."toDecision"::text, e.decision::text) AS "effectiveDecision",
                COALESCE(t.billed, e.billed) AS "effectiveBilled",
                COALESCE(t."rewardEligible", e."rewardEligible") AS "effectiveRewardEligible",
                COALESCE(t."companyFunded", e."companyFunded") AS "effectiveCompanyFunded"
         FROM impression_events e
         LEFT JOIN LATERAL (
           SELECT x.* FROM impression_decision_transitions x
           WHERE x."impressionEventId" = e.id ORDER BY x.id DESC LIMIT 1
         ) t ON true
         WHERE e."userId" = $1
           AND (e.decision = 'ACCEPTED' OR e.reason = 'CONCURRENT_USER_IMPRESSION' OR t.id IS NOT NULL)
           AND e."startedAt" <= $2::bigint + $4::bigint
           AND e."endedAt" >= $3::bigint - $4::bigint`,
        [userId, maxEndedAt, minStartedAt, toleranceMs],
      );
      let added = false;
      for (const raw of rows) {
        if (found.has(String(raw.id))) continue;
        const event = manager.create(ImpressionEvent, {
          ...raw,
          startedAt: Number(raw.startedAt),
          endedAt: Number(raw.endedAt),
        });
        found.set(String(raw.id), {
          event,
          effectiveDecision: raw.effectiveDecision as ImpressionDecision,
          billed: Boolean(raw.effectiveBilled),
          rewardEligible: Boolean(raw.effectiveRewardEligible),
          companyFunded: Boolean(raw.effectiveCompanyFunded),
        });
        minStartedAt = Math.min(minStartedAt, event.startedAt);
        maxEndedAt = Math.max(maxEndedAt, event.endedAt);
        added = true;
      }
      if (!added) break;
    }

    const candidates = [
      ...[...found.values()].map((r) => ({
        startedAt: r.event.startedAt,
        endedAt: r.event.endedAt,
        impressionKey: r.event.idempotencyKey,
      })),
      candidate,
    ];
    const acceptedKeys = concurrentLib.projectConcurrent(candidates, toleranceMs);
    const changes: Array<{ row: ProjectionRow; target: ImpressionDecision }> = [];
    for (const row of found.values()) {
      const target = acceptedKeys.has(row.event.idempotencyKey)
        ? ImpressionDecision.ACCEPTED
        : ImpressionDecision.REJECTED;
      if (target !== row.effectiveDecision) changes.push({ row, target });
    }
    return { candidateAccepted: acceptedKeys.has(candidate.impressionKey), changes };
  }

  private async applyProjectionChanges(
    manager: EntityManager,
    changes: Array<{ row: ProjectionRow; target: ImpressionDecision }>,
  ): Promise<void> {
    // 먼저 기존 승자의 과금·자격을 되돌려 같은 트랜잭션에서 새 승자에게 예산을 사용할 수 있게 한다.
    const ordered = [...changes].sort((a, b) =>
      a.target === b.target ? 0 : a.target === ImpressionDecision.REJECTED ? -1 : 1,
    );
    for (const change of ordered) await this.appendProjectionTransition(manager, change.row, change.target);
  }

  private async appendProjectionTransition(
    manager: EntityManager,
    current: ProjectionRow,
    target: ImpressionDecision,
  ): Promise<void> {
    const event = current.event;
    const ordinal = (await manager.count(ImpressionDecisionTransition, { where: { impressionEventId: event.id } })) + 1;
    let billed = false;
    let rewardEligible = false;
    let companyFunded = false;

    if (target === ImpressionDecision.REJECTED) {
      if (current.billed) {
        const captures: BillingLedgerEntry[] = await manager.query(
          `SELECT * FROM billing_ledger
           WHERE "entryType" = 'CAPTURE'
             AND ("idempotencyKey" = $1 OR "idempotencyKey" LIKE $2)
           ORDER BY id DESC LIMIT 1`,
          [event.idempotencyKey, `reproject-capture:${event.id}:%`],
        );
        const capture = captures[0];
        if (capture) {
          await manager.save(
            manager.create(BillingLedgerEntry, {
              advertiserId: capture.advertiserId,
              campaignId: capture.campaignId,
              entryType: BillingEntryType.REFUND,
              amountKrw: Math.abs(Number(capture.amountKrw)),
              idempotencyKey: `reproject-refund:${event.id}:${ordinal}`,
              reason: 'CONCURRENT_REPROJECTION',
            }),
          );
        }
      }
    } else {
      const campaign = await manager.findOneByOrFail(Campaign, { id: event.campaignId });
      const elig = campaignLib.eligibility({
        type: event.campaignType,
        rewardPolicyId: campaign.rewardPolicyId,
        houseRewardOptIn: Boolean(campaign.rewardPolicyId),
      });
      rewardEligible = elig.rewardEligible;
      if (elig.billingEligible) {
        const cap = await this.budget.captureWithManager(
          manager,
          event.campaignId,
          `reproject-capture:${event.id}:${ordinal}`,
        );
        if (cap.captured) billed = true;
        else if (cap.reason === 'BUDGET_EXHAUSTED') companyFunded = rewardEligible;
      }
    }

    await this.appendRewardProjectionAdjustment(manager, current, target, ordinal, companyFunded);
    await manager.save(
      manager.create(ImpressionDecisionTransition, {
        impressionEventId: event.id,
        fromDecision: current.effectiveDecision,
        toDecision: target,
        reason: 'CONCURRENT_REPROJECTION',
        billed,
        rewardEligible,
        companyFunded,
      }),
    );
  }

  private async appendRewardProjectionAdjustment(
    manager: EntityManager,
    current: ProjectionRow,
    target: ImpressionDecision,
    ordinal: number,
    promotedCompanyFunded: boolean,
  ): Promise<void> {
    const event = current.event;
    const base = (
      await manager.query(
        `SELECT COALESCE(SUM(CASE WHEN "entryType"='ACCRUE_PENDING' THEN points ELSE 0 END),0) AS pending,
                BOOL_OR("entryType"='ACCRUE_CONFIRM') AS confirmed,
                BOOL_OR("entryType"='CLAW_BACK') AS clawed
         FROM reward_ledger WHERE "refIdempotencyKey" = $1`,
        [event.idempotencyKey],
      )
    )[0];
    const pending = Number(base.pending);
    if (pending === 0 || base.clawed) return; // IVT 회수는 동시 노출 정정이 되살리지 않는다.
    const adjustment = (
      await manager.query(
        `SELECT COALESCE(SUM(points),0) AS sum FROM reward_ledger
         WHERE "entryType"='REPROJECTION_ADJUST' AND "refIdempotencyKey" LIKE $1`,
        [`reproject-reward:${event.id}:%`],
      )
    )[0];
    const currentNet = pending + Number(adjustment.sum);
    const targetNet = target === ImpressionDecision.ACCEPTED ? pending : 0;
    const delta = targetNet - currentNet;
    if (delta === 0) return;
    await manager.save(
      manager.create(RewardLedgerEntry, {
        userId: event.userId,
        entryType: RewardEntryType.REPROJECTION_ADJUST,
        points: delta,
        refIdempotencyKey: `reproject-reward:${event.id}:${ordinal}`,
        funding: promotedCompanyFunded || current.companyFunded ? RewardFunding.COMPANY : RewardFunding.ADVERTISER,
        reason: base.confirmed ? 'CONCURRENT_REPROJECTION_CONFIRMED' : 'CONCURRENT_REPROJECTION_PENDING',
      }),
    );
  }

  private async postgresCapReached(
    manager: EntityManager,
    userId: string,
    campaign: Campaign,
    changes: Array<{ row: ProjectionRow; target: ImpressionDecision }>,
    policy: ReturnType<typeof loadPolicy>,
  ): Promise<boolean> {
    const countRows = await manager.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE e."campaignId" = $2)::int AS campaign,
              COUNT(*) FILTER (WHERE c."advertiserId" = $3)::int AS advertiser,
              to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day
       FROM impression_events e
       JOIN campaigns c ON c.id = e."campaignId"
       LEFT JOIN LATERAL (
         SELECT t.* FROM impression_decision_transitions t
         WHERE t."impressionEventId" = e.id ORDER BY t.id DESC LIMIT 1
       ) dt ON true
       WHERE e."userId" = $1
         AND COALESCE(dt."toDecision"::text, e.decision::text) = 'ACCEPTED'
         AND e."receivedAt" >= date_trunc('day', transaction_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
         AND e."receivedAt" < (date_trunc('day', transaction_timestamp() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC'`,
      [userId, campaign.id, campaign.advertiserId],
    );
    const counts = countRows[0] as { total: number; campaign: number; advertiser: number; day: string };
    let total = Number(counts.total) + 1;
    let campaignCount = Number(counts.campaign) + 1;
    let advertiserCount = Number(counts.advertiser) + 1;

    const changedCampaignIds = [...new Set(changes.map(({ row }) => row.event.campaignId))];
    const changedCampaigns: Array<{ id: string; advertiserId: string }> = changedCampaignIds.length
      ? await manager.query(`SELECT id, "advertiserId" FROM campaigns WHERE id = ANY($1::uuid[])`, [changedCampaignIds])
      : [];
    const advertiserByCampaign = new Map(changedCampaigns.map((row) => [row.id, row.advertiserId]));

    for (const { row, target } of changes) {
      const receivedDay = new Date(row.event.receivedAt).toISOString().slice(0, 10);
      if (receivedDay !== counts.day) continue;
      const delta = target === ImpressionDecision.ACCEPTED ? 1 : -1;
      total += delta;
      if (row.event.campaignId === campaign.id) campaignCount += delta;
      if (advertiserByCampaign.get(row.event.campaignId) === campaign.advertiserId) advertiserCount += delta;
    }

    const advertiserLimitRows = await manager.query(
      `SELECT "dailyImpressionLimit" FROM advertisers WHERE id = $1`,
      [campaign.advertiserId],
    );
    const advertiserLimit = advertiserLimitRows[0]?.dailyImpressionLimit as number | null | undefined;
    return (
      total > policy.reward.dailyAcceptedImpressionLimit ||
      campaignCount > policy.frequency.perCampaignDailyImpressionLimit ||
      (campaign.type === CampaignType.PAID && advertiserLimit != null && advertiserCount > Number(advertiserLimit))
    );
  }

  private async record(
    manager: EntityManager,
    userId: string,
    ev: FactEvent,
    payload: { jti: string; campaignId: string; campaignType: string; creativeId: string; userId: string },
    idem: string,
    decision: ImpressionDecision,
    reason: string | null,
    flags: { billed?: boolean; rewardEligible?: boolean; companyFunded?: boolean } = {},
  ): Promise<{ decision: ImpressionDecision.ACCEPTED } | { decision: ImpressionDecision.REJECTED; reason: string }> {
    await manager.save(
      manager.create(ImpressionEvent, {
        idempotencyKey: idem,
        tokenJti: payload.jti,
        campaignId: payload.campaignId,
        campaignType: payload.campaignType,
        creativeId: payload.creativeId ?? null,
        userId,
        machineId: ev.machineId,
        sequence: ev.sequence,
        startedAt: ev.startedAt,
        endedAt: ev.endedAt,
        decision,
        reason,
        billed: flags.billed ?? false,
        rewardEligible: flags.rewardEligible ?? false,
        companyFunded: flags.companyFunded ?? false,
        clientVersion: ev.clientVersion ?? null,
      }),
    );
    return decision === ImpressionDecision.ACCEPTED
      ? { decision: ImpressionDecision.ACCEPTED }
      : { decision: ImpressionDecision.REJECTED, reason: reason || 'REJECTED' };
  }

  /** 사유별 카운트 집계 (GET /internal/v1/abuse-report). */
  async abuseReport(): Promise<{ total: number; accepted: number; byReason: Record<string, number> }> {
    const rows = await this.dataSource.query(`
      SELECT projected.decision, projected.reason, COUNT(*) AS count
      FROM (
        SELECT COALESCE(t."toDecision"::text, e.decision::text) AS decision,
               CASE WHEN t.id IS NOT NULL THEN
                 CASE WHEN t."toDecision" = 'REJECTED' THEN 'CONCURRENT_USER_IMPRESSION' ELSE NULL END
               ELSE e.reason END AS reason
        FROM impression_events e
        LEFT JOIN LATERAL (
          SELECT x.* FROM impression_decision_transitions x
          WHERE x."impressionEventId" = e.id ORDER BY x.id DESC LIMIT 1
        ) t ON true
      ) projected
      GROUP BY projected.decision, projected.reason
    `) as Array<{ decision: string; reason: string | null; count: string }>;

    let total = 0;
    let accepted = 0;
    const byReason: Record<string, number> = {};
    for (const r of rows) {
      const n = Number(r.count);
      total += n;
      if (r.decision === ImpressionDecision.ACCEPTED) accepted += n;
      else if (r.reason) byReason[r.reason] = (byReason[r.reason] || 0) + n;
    }
    return { total, accepted, byReason };
  }
}
