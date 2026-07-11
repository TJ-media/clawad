import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Consent } from '../entities/consent.entity';
import { Identity } from '../entities/identity.entity';
import { ImpressionEvent } from '../entities/impression-event.entity';
import { Machine, MachineStatus } from '../entities/machine.entity';
import { RewardEntryType, RewardLedgerEntry } from '../entities/reward-ledger.entity';
import { User, UserStatus } from '../entities/user.entity';
import { DestructionAction, DestructionLog } from './destruction-log.entity';

export interface WithdrawResult {
  withdrawn: boolean;
  alreadyWithdrawn?: boolean;
  forfeitedPoints?: number;
}

/** 확정 리워드 잔액 = 확정 적립 + 교환차감·조정 + (확정된 적립을 상계하는) 회수. RewardService.summary와 동일 정의. */
const CONFIRMED_BALANCE_SQL = `
  SELECT COALESCE(SUM(r.points),0) AS s FROM reward_ledger r
  WHERE r."userId" = $1 AND (
    r."entryType" IN ('ACCRUE_CONFIRM','REDEEM_DEBIT','ADMIN_ADJUST')
    OR (r."entryType" = 'CLAW_BACK' AND EXISTS (
        SELECT 1 FROM reward_ledger c
        WHERE c."refIdempotencyKey" = r."refIdempotencyKey" AND c."entryType" = 'ACCRUE_CONFIRM'))
  )`;

@Injectable()
export class PrivacyService {
  private readonly logger = new Logger(PrivacyService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private async confirmedPoints(manager: EntityManager, userId: string): Promise<number> {
    const row = await manager.query(CONFIRMED_BALANCE_SQL, [userId]);
    return Number(row[0].s);
  }

  /**
   * 내 정보 내보내기 (GET /v1/me/export). 수집 항목 전체를 기계 판독 JSON으로 반환한다.
   * 비밀번호 해시는 절대 내보내지 않는다.
   */
  async exportData(userId: string): Promise<Record<string, unknown>> {
    const user = await this.dataSource.getRepository(User).findOneBy({ id: userId });
    if (!user) throw new NotFoundException({ error: 'USER_NOT_FOUND' });

    const identities = await this.dataSource
      .getRepository(Identity)
      .find({ where: { userId }, select: { id: true, provider: true, providerSubject: true, createdAt: true } });
    const consents = await this.dataSource.getRepository(Consent).find({ where: { userId } });
    const machines = await this.dataSource.getRepository(Machine).find({ where: { userId } });
    const EXPORT_LIMIT = 1000;
    const [impressions, impressionsTotal] = await this.dataSource
      .getRepository(ImpressionEvent)
      .findAndCount({ where: { userId }, order: { id: 'DESC' }, take: EXPORT_LIMIT });
    const [rewards, rewardsTotal] = await this.dataSource
      .getRepository(RewardLedgerEntry)
      .findAndCount({ where: { userId }, order: { id: 'DESC' }, take: EXPORT_LIMIT });
    const confirmedPoints = await this.confirmedPoints(this.dataSource.manager, userId);

    return {
      exportedAt: new Date().toISOString(),
      user: {
        id: user.id,
        email: user.email,
        status: user.status,
        createdAt: user.createdAt,
        withdrawnAt: user.withdrawnAt,
      },
      // 로그인 수단: 본인의 이메일·소셜 식별자는 본인 데이터다. 비밀번호 해시는 제외.
      identities,
      consents,
      machines: machines.map((m) => ({
        machineId: m.machineId,
        status: m.status,
        registeredAt: m.registeredAt,
      })),
      rewards: { confirmedPoints, total: rewardsTotal, returned: rewards.length, ledger: rewards },
      impressions: { total: impressionsTotal, returned: impressions.length, limit: EXPORT_LIMIT, items: impressions },
      note: '접속 IP·하드웨어 식별자는 수집하지 않으므로 포함되지 않습니다 (privacy-design.md §2, §6.6). total > returned이면 최근순으로 절단된 것입니다.',
    };
  }

  /**
   * 탈퇴 (DELETE /v1/me). 즉시 서비스 이용을 중단하고 직접 식별자를 파기·가명화한다.
   *
   * append-only 원장(노출·리워드·과금)은 삭제하지 않는다 — 세무·정산·분쟁 보관 의무가 있고,
   * userId는 가명 UUID다. 대신 로그인 수단(identities)과 이메일을 파기해 신원 연결을 끊는다.
   *
   * 미지급 확정 리워드가 있으면 차단한다 — 지급(CLAW-26 교환) 후 탈퇴하거나, 포기에 명시 동의해야 한다.
   */
  async withdraw(userId: string, forfeitConfirmedRewards: boolean): Promise<WithdrawResult> {
    return this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, { where: { id: userId }, lock: { mode: 'pessimistic_write' } });
      if (!user) throw new NotFoundException({ error: 'USER_NOT_FOUND' });
      if (user.status === UserStatus.WITHDRAWN) {
        return { withdrawn: true, alreadyWithdrawn: true };
      }

      const confirmed = await this.confirmedPoints(manager, userId);
      let forfeitedPoints = 0;
      if (confirmed > 0) {
        if (!forfeitConfirmedRewards) {
          // 지급 수단(교환)은 CLAW-26. 알파에서 남은 확정 리워드는 포기 동의로만 정리할 수 있다.
          throw new ConflictException({
            error: 'UNPAID_CONFIRMED_REWARDS',
            confirmedPoints: confirmed,
            message: '확정 리워드가 남아 있습니다. 교환 후 탈퇴하거나 포기에 동의해야 합니다.',
          });
        }
        // 포기: 원장에 반대 분개를 남겨 잔액을 0으로 만든다(append-only, 추적 가능).
        await manager.save(
          manager.create(RewardLedgerEntry, {
            userId,
            entryType: RewardEntryType.ADMIN_ADJUST,
            points: -confirmed,
            reason: 'WITHDRAWAL_FORFEIT',
          }),
        );
        forfeitedPoints = confirmed;
      }

      // 로그인 수단 파기: 이메일·비밀번호 해시가 사라져 로그인이 불가능해진다.
      const identityCount = await manager.count(Identity, { where: { userId } });
      await manager.delete(Identity, { userId });

      // 직접 식별자 제거 + 상태 전이. 원장의 가명 userId는 유지된다.
      user.email = null;
      user.status = UserStatus.WITHDRAWN;
      user.withdrawnAt = new Date();
      await manager.save(user);

      // 기기 해제(수집·서빙 중단). 가명 machineId는 유지.
      await manager.update(Machine, { userId, status: MachineStatus.ACTIVE }, { status: MachineStatus.RELEASED });

      await manager.save(
        manager.create(DestructionLog, {
          userId,
          action: DestructionAction.WITHDRAWAL,
          detail: JSON.stringify({
            identitiesDeleted: identityCount,
            emailAnonymized: true,
            machinesReleased: true,
            forfeitedPoints,
            retainedLedgers: ['impression_events', 'reward_ledger'],
          }),
        }),
      );

      return { withdrawn: true, forfeitedPoints };
    });
  }

  /**
   * 파기 배치: 탈퇴한 계정의 직접 식별자가 남아 있지 않은지 재확인·정리하고 로그를 남긴다(멱등).
   *
   * 보유기간 경과 원장(노출·리워드) 자동 파기는 세법상 보관연수가 확정된 뒤 켠다
   * (privacy-design.md §4, CLAW-13 미확정). 지금은 신원 식별자 파기만 강제한다.
   */
  async runRetentionSweep(): Promise<{ sweptUsers: number; residualIdentitiesPurged: number }> {
    const withdrawn = await this.dataSource.getRepository(User).find({ where: { status: UserStatus.WITHDRAWN } });
    let residualPurged = 0;

    for (const user of withdrawn) {
      await this.dataSource.transaction(async (manager) => {
        // 남아 있으면 안 되는 잔여 식별자를 정리한다(멱등).
        const residual = await manager.count(Identity, { where: { userId: user.id } });
        let purged = 0;
        if (residual > 0) {
          await manager.delete(Identity, { userId: user.id });
          purged = residual;
        }
        if (user.email !== null) {
          user.email = null;
          await manager.save(user);
          purged += 1;
        }
        residualPurged += purged;

        // 실제로 정리한 잔여물이 있을 때만 로그를 남긴다(멱등 재실행 시 로그 비대 방지).
        if (purged > 0) {
          await manager.save(
            manager.create(DestructionLog, {
              userId: user.id,
              action: DestructionAction.RETENTION_SWEEP,
              detail: JSON.stringify({ residualIdentitiesPurged: purged }),
            }),
          );
        }
      });
    }

    return { sweptUsers: withdrawn.length, residualIdentitiesPurged: residualPurged };
  }
}
