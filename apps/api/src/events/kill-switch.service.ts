import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  GLOBAL_KILL_SWITCH_ID,
  KillSwitch,
  KillSwitchTarget,
} from '../entities/kill-switch.entity';

const ADS_GATE = 'clawad:kill-switch:ads';
const REWARDS_GATE = 'clawad:kill-switch:rewards';
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const INCIDENT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MACHINE_TARGET_PATTERN = /^[0-9a-f]{32}$/;
// PostgreSQL uuid 출력과 같은 소문자 canonical form만 받는다. 대문자 원문을 varchar에
// 저장하면 실제 user/campaign UUID와 case-sensitive 비교가 어긋나 silent bypass가 된다.
const UUID_TARGET_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

export interface EmergencySwitchResult {
  ads: KillSwitch;
  rewards: KillSwitch;
}

export interface EmergencyResumeResult {
  adsDisabled: number;
  rewardsDisabled: number;
}

@Injectable()
export class KillSwitchService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(KillSwitch) private readonly repo: Repository<KillSwitch>,
  ) {}

  /**
   * 광고 처리 트랜잭션의 shared gate. enable/disable은 같은 키의 exclusive gate를 잡으므로,
   * 중지 API가 커밋·응답한 뒤에는 이전 광고 트랜잭션이 남아 있을 수 없다.
   */
  acquireAdsShared(manager: EntityManager): Promise<unknown> {
    return manager.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))`, [ADS_GATE]);
  }

  /** 적립·확정 배치용 shared gate. CLAW_BACK은 긴급 교정 경로라 이 gate를 사용하지 않는다. */
  acquireRewardsShared(manager: EntityManager): Promise<unknown> {
    return manager.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))`, [REWARDS_GATE]);
  }

  private acquireAdsExclusive(manager: EntityManager): Promise<unknown> {
    return manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [ADS_GATE]);
  }

  private acquireRewardsExclusive(manager: EntityManager): Promise<unknown> {
    return manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [REWARDS_GATE]);
  }

  withAdsShared<T>(operation: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await this.acquireAdsShared(manager);
      return operation(manager);
    });
  }

  withRewardsShared<T>(operation: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await this.acquireRewardsShared(manager);
      return operation(manager);
    });
  }

  /** 대상이 현재 킬스위치에 걸려 있는가. manager를 주면 호출자의 트랜잭션에서 읽는다. */
  async isKilled(target: KillSwitchTarget, targetId: string, manager?: EntityManager): Promise<boolean> {
    const repository = manager ? manager.getRepository(KillSwitch) : this.repo;
    return (await repository.count({ where: { target, targetId, active: true } })) > 0;
  }

  /** global + 사용자 + 머신 + 선택 캠페인을 한 DB 조회로 판정한다. */
  async isAdsKilled(
    manager: EntityManager,
    userId: string,
    machineId: string,
    campaignId?: string,
  ): Promise<boolean> {
    const rows: Array<{ killed: boolean }> = await manager.query(
      `SELECT EXISTS (
         SELECT 1 FROM kill_switches
         WHERE active = true AND (
           (target = $1::kill_switches_target_enum AND "targetId" = $2) OR
           (target = $3::kill_switches_target_enum AND "targetId" = $4) OR
           (target = $5::kill_switches_target_enum AND "targetId" = $6) OR
           ($7::text IS NOT NULL AND target = $8::kill_switches_target_enum AND "targetId" = $7)
         )
       ) AS killed`,
      [
        KillSwitchTarget.GLOBAL_ADS,
        GLOBAL_KILL_SWITCH_ID,
        KillSwitchTarget.USER,
        userId,
        KillSwitchTarget.MACHINE,
        machineId,
        campaignId ?? null,
        KillSwitchTarget.CAMPAIGN,
      ],
    );
    return Boolean(rows[0]?.killed);
  }

  /**
   * 업로드가 stop 뒤로 지연돼도 표시 구간이 과거 kill 활성 구간과 겹쳤으면 영구 거절한다.
   * 현재 active switch는 표시 시각과 무관하게 막아 stop 응답 뒤 신규 ACCEPTED를 만들지 않는다.
   */
  async isAdsKilledForEvent(
    manager: EntityManager,
    userId: string,
    machineId: string,
    campaignId: string,
    startedAt: number,
    endedAt: number,
  ): Promise<boolean> {
    const rows: Array<{ killed: boolean }> = await manager.query(
      `SELECT EXISTS (
         SELECT 1 FROM kill_switches
         WHERE (
           (target = $1::kill_switches_target_enum AND "targetId" = $2) OR
           (target = $3::kill_switches_target_enum AND "targetId" = $4) OR
           (target = $5::kill_switches_target_enum AND "targetId" = $6) OR
           (target = $7::kill_switches_target_enum AND "targetId" = $8)
         ) AND (
           active = true OR (
             "disabledAt" IS NOT NULL AND
             EXTRACT(EPOCH FROM "createdAt") * 1000 < $9::double precision
             AND EXTRACT(EPOCH FROM "disabledAt") * 1000 > $10::double precision
           )
         )
       ) AS killed`,
      [
        KillSwitchTarget.GLOBAL_ADS,
        GLOBAL_KILL_SWITCH_ID,
        KillSwitchTarget.USER,
        userId,
        KillSwitchTarget.MACHINE,
        machineId,
        KillSwitchTarget.CAMPAIGN,
        campaignId,
        endedAt,
        startedAt,
      ],
    );
    return Boolean(rows[0]?.killed);
  }

  async isRewardsPaused(manager: EntityManager): Promise<boolean> {
    return this.isKilled(KillSwitchTarget.GLOBAL_REWARDS, GLOBAL_KILL_SWITCH_ID, manager);
  }

  /** 클라이언트가 다음 sync에서 이미 프리페치한 대상 캠페인 bundle을 폐기하는 데 쓴다. */
  async activeCampaignIds(manager: EntityManager, candidateIds: string[]): Promise<string[]> {
    if (candidateIds.length === 0) return [];
    const rows: Array<{ targetId: unknown }> = await manager.query(
      `SELECT "targetId" FROM kill_switches
       WHERE target = $1::kill_switches_target_enum AND active = true
         AND "targetId" = ANY($2::text[])
       ORDER BY "targetId"`,
      [KillSwitchTarget.CAMPAIGN, candidateIds],
    );
    return rows
      .map((row) => String(row.targetId))
      .filter((targetId) => UUID_TARGET_PATTERN.test(targetId));
  }

  listActive(): Promise<KillSwitch[]> {
    return this.repo.find({ where: { active: true }, order: { createdAt: 'ASC' } });
  }

  private assertTargetId(target: KillSwitchTarget, targetId: string): void {
    if (!targetId) throw new BadRequestException({ error: 'TARGET_ID_REQUIRED' });
    if (target === KillSwitchTarget.GLOBAL_ADS || target === KillSwitchTarget.GLOBAL_REWARDS) {
      if (targetId !== GLOBAL_KILL_SWITCH_ID) {
        throw new BadRequestException({ error: 'GLOBAL_TARGET_ID_REQUIRED', targetId: GLOBAL_KILL_SWITCH_ID });
      }
      return;
    }
    if (target === KillSwitchTarget.MACHINE && !MACHINE_TARGET_PATTERN.test(targetId)) {
      throw new BadRequestException({ error: 'INVALID_MACHINE_TARGET_ID' });
    }
    if (
      (target === KillSwitchTarget.USER || target === KillSwitchTarget.CAMPAIGN) &&
      !UUID_TARGET_PATTERN.test(targetId)
    ) {
      throw new BadRequestException({ error: 'INVALID_UUID_TARGET_ID' });
    }
  }

  private safeReason(reasonCode: string, incidentRef?: string): string {
    if (!REASON_CODE_PATTERN.test(reasonCode)) {
      throw new BadRequestException({ error: 'INVALID_REASON_CODE' });
    }
    if (incidentRef !== undefined && !INCIDENT_REF_PATTERN.test(incidentRef)) {
      throw new BadRequestException({ error: 'INVALID_INCIDENT_REF' });
    }
    return incidentRef ? `${reasonCode}:${incidentRef}` : reasonCode;
  }

  /** transaction_timestamp()은 lock 대기 전 시각이므로 실제 선형화 시각에는 clock_timestamp()을 쓴다. */
  private async databaseNow(manager: EntityManager): Promise<Date> {
    const rows: Array<{ now: Date | string }> = await manager.query(`SELECT clock_timestamp() AS now`);
    return new Date(rows[0].now);
  }

  private async enableWithManager(
    manager: EntityManager,
    target: KillSwitchTarget,
    targetId: string,
    reason: string,
  ): Promise<KillSwitch> {
    const repository = manager.getRepository(KillSwitch);
    const existing = await repository.findOne({ where: { target, targetId, active: true } });
    if (existing) return existing;
    const createdAt = await this.databaseNow(manager);
    // rolling 배포 중 구 인스턴스와 경합해도 23505로 outer transaction을 abort시키지 않는다.
    // partial unique predicate와 같은 conflict target으로 먼저 켠 active 행에 멱등 수렴한다.
    await manager.query(
      `INSERT INTO kill_switches (target, "targetId", active, reason, "createdAt")
       VALUES ($1::kill_switches_target_enum, $2, true, $3, $4)
       ON CONFLICT (target, "targetId") WHERE active = true DO NOTHING`,
      [target, targetId, reason, createdAt],
    );
    return repository.findOneOrFail({ where: { target, targetId, active: true } });
  }

  private async disableWithManager(
    manager: EntityManager,
    target: KillSwitchTarget,
    targetId: string,
    reason: string,
  ): Promise<number> {
    const repository = manager.getRepository(KillSwitch);
    const rows = await repository.find({ where: { target, targetId, active: true } });
    const disabledAt = rows.length ? await this.databaseNow(manager) : null;
    for (const row of rows) {
      row.active = false;
      row.disabledReason = reason;
      row.disabledAt = disabledAt;
      await repository.save(row);
    }
    return rows.length;
  }

  async enable(
    target: KillSwitchTarget,
    targetId: string,
    reasonCode: string,
    incidentRef?: string,
  ): Promise<KillSwitch> {
    this.assertTargetId(target, targetId);
    const reason = this.safeReason(reasonCode, incidentRef);
    return this.dataSource.transaction(async (manager) => {
      if (target === KillSwitchTarget.GLOBAL_REWARDS) await this.acquireRewardsExclusive(manager);
      else await this.acquireAdsExclusive(manager);
      return this.enableWithManager(manager, target, targetId, reason);
    });
  }

  async disable(
    target: KillSwitchTarget,
    targetId: string,
    reasonCode: string,
    incidentRef?: string,
  ): Promise<{ disabled: number }> {
    this.assertTargetId(target, targetId);
    const reason = this.safeReason(reasonCode, incidentRef);
    return this.dataSource.transaction(async (manager) => {
      if (target === KillSwitchTarget.GLOBAL_REWARDS) await this.acquireRewardsExclusive(manager);
      else await this.acquireAdsExclusive(manager);
      return { disabled: await this.disableWithManager(manager, target, targetId, reason) };
    });
  }

  /** 전체 광고와 적립을 한 선형화 지점에서 원자적으로 중지한다. 잠금 순서는 항상 ADS → REWARDS다. */
  async emergencyStop(reasonCode: string, incidentRef?: string): Promise<EmergencySwitchResult> {
    const reason = this.safeReason(reasonCode, incidentRef);
    return this.dataSource.transaction(async (manager) => {
      await this.acquireAdsExclusive(manager);
      await this.acquireRewardsExclusive(manager);
      const ads = await this.enableWithManager(
        manager,
        KillSwitchTarget.GLOBAL_ADS,
        GLOBAL_KILL_SWITCH_ID,
        reason,
      );
      const rewards = await this.enableWithManager(
        manager,
        KillSwitchTarget.GLOBAL_REWARDS,
        GLOBAL_KILL_SWITCH_ID,
        reason,
      );
      return { ads, rewards };
    });
  }

  /** 전체 재개도 한 트랜잭션에서 수행한다. 과거 KILLED 이벤트나 폐기 토큰은 되살리지 않는다. */
  async emergencyResume(reasonCode: string, incidentRef?: string): Promise<EmergencyResumeResult> {
    const reason = this.safeReason(reasonCode, incidentRef);
    return this.dataSource.transaction(async (manager) => {
      await this.acquireAdsExclusive(manager);
      await this.acquireRewardsExclusive(manager);
      return {
        adsDisabled: await this.disableWithManager(
          manager,
          KillSwitchTarget.GLOBAL_ADS,
          GLOBAL_KILL_SWITCH_ID,
          reason,
        ),
        rewardsDisabled: await this.disableWithManager(
          manager,
          KillSwitchTarget.GLOBAL_REWARDS,
          GLOBAL_KILL_SWITCH_ID,
          reason,
        ),
      };
    });
  }
}
