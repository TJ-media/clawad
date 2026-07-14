import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { loadPolicy } from '../common/policy';
import { BillingEntryType, BillingLedgerEntry } from '../entities/billing-ledger.entity';
import { ImpressionDecision, ImpressionEvent } from '../entities/impression-event.entity';
import { RewardEntryType, RewardFunding, RewardLedgerEntry } from '../entities/reward-ledger.entity';

export interface RewardSummary {
  /** 확정 리워드 잔액 = Σ확정 − Σ회수 − Σ교환차감 + Σ운영자조정. */
  confirmedPoints: number;
  /** 검증 중(아직 확정·회수되지 않은 적립 예정). */
  verifyingPoints: number;
}

@Injectable()
export class RewardService {
  private readonly logger = new Logger(RewardService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** UTC 일자 문자열. CLAW-6 빈도 서비스와 같은 기준(계정 단위 일일 상한). */
  private dayOf(receivedAt: Date): string {
    return receivedAt.toISOString().slice(0, 10);
  }

  /**
   * 적립 배치: CLAW-6이 남긴 ACCEPTED·rewardEligible 노출 중 아직 적립되지 않은 것을
   * accrue_pending으로 옮긴다. 노출 1건 = 원장 1행(ref=멱등키, UNIQUE)이라 멱등하다.
   *
   * 포인트는 정책(pointsForImpressions)으로 계산하고, 정수 반올림 오차는 계정·일자별
   * 누적 캐리로 흡수한다. 일일 적립 상한(dailyRewardLimit)을 초과하면 0P 행으로 표시해
   * 재처리되지 않게 한다(초과분 미적립).
   */
  async runAccrual(now = new Date()): Promise<{ accruedRows: number; accruedPoints: number }> {
    const legacyPolicy = loadPolicy().reward;

    let accruedRows = 0;
    let accruedPoints = 0;

    // 적립 대상 사용자 목록: 미적립 rewardEligible ACCEPTED 노출이 있는 계정.
    // 탈퇴(WITHDRAWN) 계정은 제외한다 — 신원 파기된 계정에 새 리워드를 만들지 않는다 (CLAW-28).
    const users: { userId: string }[] = await this.dataSource.query(`
      SELECT DISTINCT ie."userId"
      FROM impression_events ie
      LEFT JOIN LATERAL (
        SELECT t.* FROM impression_decision_transitions t
        WHERE t."impressionEventId" = ie.id ORDER BY t.id DESC LIMIT 1
      ) dt ON true
      LEFT JOIN reward_ledger rl
        ON rl."refIdempotencyKey" = ie."idempotencyKey" AND rl."entryType" = 'ACCRUE_PENDING'
      JOIN users u ON u.id = ie."userId"
      WHERE COALESCE(dt."toDecision"::text, ie.decision::text) = 'ACCEPTED'
        AND COALESCE(dt."rewardEligible", ie."rewardEligible") = true AND rl."id" IS NULL
        AND u.status <> 'WITHDRAWN'
    `);

    for (const { userId } of users) {
      await this.dataSource.transaction(async (manager) => {
        // 같은 계정의 동시 적립을 직렬화한다.
        await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`clawad:reward:${userId}`]);

        // 미적립 노출을 시간순으로. companyFunded로 재원을 구분한다.
        const pendingIds: Array<{ id: string; companyFunded: boolean }> = await manager.query(
          `SELECT ie.id, COALESCE(dt."companyFunded", ie."companyFunded") AS "companyFunded"
           FROM impression_events ie
           LEFT JOIN LATERAL (
             SELECT t.* FROM impression_decision_transitions t
             WHERE t."impressionEventId" = ie.id ORDER BY t.id DESC LIMIT 1
           ) dt ON true
           LEFT JOIN reward_ledger rl
             ON rl."refIdempotencyKey" = ie."idempotencyKey" AND rl."entryType" = 'ACCRUE_PENDING'
           WHERE ie."userId" = $1
             AND COALESCE(dt."toDecision"::text, ie.decision::text) = 'ACCEPTED'
             AND COALESCE(dt."rewardEligible", ie."rewardEligible") = true
             AND rl.id IS NULL ORDER BY ie.id ASC`,
          [userId],
        );
        const pending = pendingIds.length
          ? await manager.find(ImpressionEvent, { where: { id: In(pendingIds.map((r) => String(r.id))) } })
          : [];
        const effectiveFunding = new Map(pendingIds.map((row) => [String(row.id), Boolean(row.companyFunded)]));
        pending.sort((a, b) => Number(a.id) - Number(b.id));

        // 계정·일자별 누적(count/accrued) 상태를 기존 원장에서 복원한다.
        const dayState = new Map<string, { units: number; accrued: number }>();
        const loadDay = async (day: string) => {
          if (dayState.has(day)) return dayState.get(day)!;
          // 이미 적립된 이 계정·이 날짜의 노출 수·누적 포인트.
          const row = await manager.query(
            `SELECT COALESCE(SUM(COALESCE(ie."rewardPerThousandSnapshot", $3)),0) AS units,
                    COALESCE(SUM(rl.points + COALESCE(adj.points, 0)),0) AS pts
             FROM reward_ledger rl
             JOIN impression_events ie ON ie."idempotencyKey" = rl."refIdempotencyKey"
             LEFT JOIN LATERAL (
               SELECT t.* FROM impression_decision_transitions t
               WHERE t."impressionEventId" = ie.id ORDER BY t.id DESC LIMIT 1
             ) dt ON true
             LEFT JOIN LATERAL (
               SELECT SUM(a.points) AS points FROM reward_ledger a
               WHERE a."entryType" = 'REPROJECTION_ADJUST'
                 AND a."refIdempotencyKey" LIKE 'reproject-reward:' || ie.id || ':%'
             ) adj ON true
             WHERE rl."userId" = $1 AND rl."entryType" = 'ACCRUE_PENDING'
               AND COALESCE(dt."toDecision"::text, ie.decision::text) = 'ACCEPTED'
               AND COALESCE(dt."rewardEligible", ie."rewardEligible") = true
               AND (ie."receivedAt" AT TIME ZONE 'UTC')::date = $2::date`,
            [userId, day, legacyPolicy.rewardPerThousandAcceptedImpressions],
          );
          const state = { units: Number(row[0].units), accrued: Number(row[0].pts) };
          dayState.set(day, state);
          return state;
        };

        for (const ie of pending) {
          const day = this.dayOf(ie.receivedAt);
          const state = await loadDay(day);

          const rate = ie.rewardPerThousandSnapshot ?? legacyPolicy.rewardPerThousandAcceptedImpressions;
          const dailyLimit = ie.dailyRewardLimitSnapshot ?? legacyPolicy.dailyRewardLimit;
          state.units += rate;
          // 캐리: 누적 목표 포인트에서 이미 적립한 만큼을 뺀 증분.
          const uncapped = Math.floor(state.units / 1000);
          const target = Math.max(state.accrued, Math.min(uncapped, dailyLimit));
          const pts = target - state.accrued;
          state.accrued = target;

          // pts=0의 원인 구분: 일일 상한 초과(DAILY_CAP) vs 캐리 반올림(정상, 사유 없음).
          const reason = pts === 0 && uncapped > dailyLimit ? 'DAILY_CAP' : null;

          await manager.save(
            manager.create(RewardLedgerEntry, {
              userId,
              entryType: RewardEntryType.ACCRUE_PENDING,
              points: pts,
              refIdempotencyKey: ie.idempotencyKey,
              funding: effectiveFunding.get(String(ie.id)) ? RewardFunding.COMPANY : RewardFunding.ADVERTISER,
              reason,
              policySnapshotId: ie.policySnapshotId,
              policyVersion: ie.policyVersion,
              rewardPolicyId: ie.rewardPolicyId,
              rewardPerThousandSnapshot: ie.rewardPerThousandSnapshot,
            }),
          );
          accruedRows += 1;
          accruedPoints += pts;
        }
      });
    }

    return { accruedRows, accruedPoints };
  }

  /**
   * 확정 배치: 사후 부정 검수를 통과한 accrue_pending을 accrue_confirm으로 확정한다.
   * 이미 회수(claw_back)됐거나 확정된 건은 건너뛴다. 멱등.
   */
  async runConfirmation(): Promise<{ confirmedRows: number; confirmedPoints: number }> {
    // 확정 대상: accrue_pending 중, 같은 ref로 confirm도 claw_back도 없는 것.
    // 탈퇴(WITHDRAWN) 계정은 확정하지 않는다 — 신원 파기된 계정에 뒤늦게 확정잔액이 생기지 않게 한다 (CLAW-28).
    const rows: Array<{
      refIdempotencyKey: string;
      userId: string;
      points: string;
      policySnapshotId: string | null;
      policyVersion: number | null;
      rewardPolicyId: string | null;
      rewardPerThousandSnapshot: number | null;
    }> = await this.dataSource.query(`
      SELECT p."refIdempotencyKey", p."userId", p."points", p."policySnapshotId",
             p."policyVersion", p."rewardPolicyId", p."rewardPerThousandSnapshot"
      FROM reward_ledger p
      JOIN impression_events ie ON ie."idempotencyKey" = p."refIdempotencyKey"
      LEFT JOIN LATERAL (
        SELECT t.* FROM impression_decision_transitions t
        WHERE t."impressionEventId" = ie.id ORDER BY t.id DESC LIMIT 1
      ) dt ON true
      JOIN users u ON u.id = p."userId"
      WHERE p."entryType" = 'ACCRUE_PENDING'
        AND u.status <> 'WITHDRAWN'
        AND COALESCE(dt."toDecision"::text, ie.decision::text) = 'ACCEPTED'
        AND NOT EXISTS (
          SELECT 1 FROM reward_ledger x
          WHERE x."refIdempotencyKey" = p."refIdempotencyKey"
            AND x."entryType" IN ('ACCRUE_CONFIRM','CLAW_BACK')
        )
    `);

    let confirmedRows = 0;
    let confirmedPoints = 0;
    const repo = this.dataSource.getRepository(RewardLedgerEntry);
    for (const r of rows) {
      try {
        await repo.save(
          repo.create({
            userId: r.userId,
            entryType: RewardEntryType.ACCRUE_CONFIRM,
            points: Number(r.points),
            refIdempotencyKey: r.refIdempotencyKey,
            policySnapshotId: r.policySnapshotId,
            policyVersion: r.policyVersion,
            rewardPolicyId: r.rewardPolicyId,
            rewardPerThousandSnapshot: r.rewardPerThousandSnapshot,
          }),
        );
        confirmedRows += 1;
        confirmedPoints += Number(r.points);
      } catch (e) {
        // UNIQUE(ref, entryType) 경합(다른 배치가 먼저 확정) — 멱등하게 무시.
        this.logger.warn(`확정 건너뜀(${r.refIdempotencyKey}): ${(e as Error).message}`);
      }
    }
    return { confirmedRows, confirmedPoints };
  }

  /**
   * 회수: 특정 노출을 사후 부정으로 판정해 리워드를 회수하고 광고주 크레딧을 복원한다.
   * 이미 교환된 경우에도 마이너스 분개를 남긴다(다음 확정분에서 차감된다 — 교환은 CLAW-26).
   */
  async clawBack(idempotencyKey: string, reason: string): Promise<{ clawedPoints: number; refunded: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const impression = await manager.findOne(ImpressionEvent, { where: { idempotencyKey } });
      if (!impression) throw new BadRequestException({ error: 'IMPRESSION_NOT_FOUND' });
      const latestTransition = (
        await manager.query(
          `SELECT * FROM impression_decision_transitions
           WHERE "impressionEventId" = $1 ORDER BY id DESC LIMIT 1`,
          [impression.id],
        )
      )[0] as { billed?: boolean } | undefined;

      // 이 노출로 적립된 순 포인트(pending 기준). 확정 여부와 무관하게 회수 대상.
      const accrued: { sum: string } = (
        await manager.query(
          `SELECT COALESCE(SUM(points),0) AS sum FROM reward_ledger
           WHERE ("refIdempotencyKey" = $1 AND "entryType" = 'ACCRUE_PENDING')
              OR ("entryType" = 'REPROJECTION_ADJUST' AND "refIdempotencyKey" LIKE $2)`,
          [idempotencyKey, `reproject-reward:${impression.id}:%`],
        )
      )[0];
      const clawedAlready: { sum: string } = (
        await manager.query(
          `SELECT COALESCE(SUM(points),0) AS sum FROM reward_ledger
           WHERE "refIdempotencyKey" = $1 AND "entryType" = 'CLAW_BACK'`,
          [idempotencyKey],
        )
      )[0];
      const net = Number(accrued.sum) + Number(clawedAlready.sum); // clawedAlready는 음수
      if (net > 0) {
        await manager.save(
          manager.create(RewardLedgerEntry, {
            userId: impression.userId,
            entryType: RewardEntryType.CLAW_BACK,
            points: -net,
            refIdempotencyKey: idempotencyKey,
            reason,
            policySnapshotId: impression.policySnapshotId,
            policyVersion: impression.policyVersion,
            rewardPolicyId: impression.rewardPolicyId,
            rewardPerThousandSnapshot: impression.rewardPerThousandSnapshot,
          }),
        );
      }

      // 광고주 과금이 있었으면 크레딧 복원(billing ivt_refund). 회사 재원·미과금 건은 복원할 과금이 없다.
      // 같은 트랜잭션에서 append해 회수와 복원이 함께 확정되게 한다.
      // 멱등: IVT_REFUND에 결정적 키를 부여해, claw-back을 두 번 호출해도 예산이 이중 복원되지 않게 한다.
      let refunded = false;
      if (latestTransition?.billed ?? impression.billed) {
        const refundKey = `ivtrefund:${idempotencyKey}`;
        const existingRefund = await manager.findOne(BillingLedgerEntry, { where: { idempotencyKey: refundKey } });
        if (!existingRefund) {
          // 실제 capture한 금액을 원장에서 읽어 그대로 복원한다(현재 단가가 아니라 캡처 시점 금액).
          const captures: BillingLedgerEntry[] = await manager.query(
            `SELECT * FROM billing_ledger
             WHERE "entryType" = 'CAPTURE'
               AND ("idempotencyKey" = $1 OR "idempotencyKey" LIKE $2)
             ORDER BY id DESC LIMIT 1`,
            [idempotencyKey, `reproject-capture:${impression.id}:%`],
          );
          const capture = captures[0];
          const amount = capture ? Math.abs(capture.amountKrw) : 0;
          if (amount > 0) {
            await manager.save(
              manager.create(BillingLedgerEntry, {
                advertiserId: capture!.advertiserId,
                campaignId: impression.campaignId,
                entryType: BillingEntryType.IVT_REFUND,
                amountKrw: amount, // 복원은 양수 append
                idempotencyKey: refundKey,
                reason: `IVT:${reason}`.slice(0, 64),
                policySnapshotId: capture!.policySnapshotId,
                policyVersion: capture!.policyVersion,
                rewardPolicyId: capture!.rewardPolicyId,
                unitPriceKrw: capture!.unitPriceKrw,
              }),
            );
            refunded = true;
          }
        }
      }
      return { clawedPoints: net, refunded };
    });
  }

  /**
   * 확정 리워드 잔액 = 확정 적립(+) + 교환차감·운영자조정(부호대로) + 확정된 적립을 상계하는 회수(−)만.
   * 교환(CLAW-26)이 이 값을 기준으로 차감한다. manager를 주면 같은 트랜잭션에서 계산한다.
   */
  async confirmedBalance(userId: string, manager?: EntityManager): Promise<number> {
    const runner = manager ?? this.dataSource.manager;
    const row = await runner.query(
      `SELECT COALESCE(SUM(r.points),0) AS s FROM reward_ledger r
       WHERE r."userId" = $1 AND (
         r."entryType" IN ('ACCRUE_CONFIRM','REDEEM_DEBIT','ADMIN_ADJUST')
         OR (r."entryType" = 'REPROJECTION_ADJUST' AND r.reason = 'CONCURRENT_REPROJECTION_CONFIRMED')
         OR (r."entryType" = 'CLAW_BACK' AND EXISTS (
             SELECT 1 FROM reward_ledger c
             WHERE c."refIdempotencyKey" = r."refIdempotencyKey" AND c."entryType" = 'ACCRUE_CONFIRM'))
       )`,
      [userId],
    );
    return Number(row[0].s);
  }

  async summary(userId: string): Promise<RewardSummary> {
    // 확정 전에 회수된 pending은 verifying에서만 빠지고 확정 잔액을 음수로 만들지 않는다.
    const confirmedPoints = await this.confirmedBalance(userId);
    // 검증 중 = 아직 확정·회수되지 않은 accrue_pending 합.
    const verifyingRow = await this.dataSource.query(
      `SELECT
         COALESCE(SUM(p.points),0) +
         COALESCE((
           SELECT SUM(a.points) FROM reward_ledger a
           JOIN impression_events ie ON ie.id = split_part(a."refIdempotencyKey", ':', 3)::bigint
           WHERE a."userId" = $1 AND a."entryType" = 'REPROJECTION_ADJUST'
             AND a.reason = 'CONCURRENT_REPROJECTION_PENDING'
             AND NOT EXISTS (
               SELECT 1 FROM reward_ledger c
               WHERE c."refIdempotencyKey" = ie."idempotencyKey" AND c."entryType" = 'ACCRUE_CONFIRM'
             )
         ),0) AS s
       FROM reward_ledger p
       WHERE p."userId" = $1 AND p."entryType" = 'ACCRUE_PENDING'
         AND NOT EXISTS (
           SELECT 1 FROM reward_ledger x
           WHERE x."refIdempotencyKey" = p."refIdempotencyKey"
             AND x."entryType" IN ('ACCRUE_CONFIRM','CLAW_BACK'))`,
      [userId],
    );
    return {
      confirmedPoints,
      verifyingPoints: Number(verifyingRow[0].s),
    };
  }

  async history(userId: string, limit = 100): Promise<RewardLedgerEntry[]> {
    return this.dataSource.getRepository(RewardLedgerEntry).find({
      where: { userId },
      order: { id: 'DESC' },
      take: Math.min(limit, 500),
    });
  }
}
