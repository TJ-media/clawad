import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { loadPolicy } from '../common/policy';
import { RewardEntryType, RewardLedgerEntry } from '../entities/reward-ledger.entity';
import { RewardService } from '../events/reward.service';
import { Product } from './product.entity';
import { RedemptionEntryType, RedemptionLedgerEntry } from './redemption-ledger.entity';
import { Redemption, RedemptionStatus } from './redemption.entity';

@Injectable()
export class RedemptionService {
  private readonly logger = new Logger(RedemptionService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly rewards: RewardService,
  ) {}

  // --- 상품 카탈로그 (운영자) ---

  async createProduct(name: string, brand: string, pointCost: number, category?: string | null): Promise<Product> {
    const min = loadPolicy().reward.minimumRedemptionPoints;
    if (pointCost < min) {
      throw new BadRequestException({ error: 'POINT_COST_BELOW_MINIMUM', minimum: min });
    }
    const repo = this.dataSource.getRepository(Product);
    return repo.save(repo.create({ name, brand, pointCost, category: category ?? null, active: true }));
  }

  async setProductActive(productId: string, active: boolean): Promise<Product> {
    const repo = this.dataSource.getRepository(Product);
    const product = await repo.findOneBy({ id: productId });
    if (!product) throw new NotFoundException({ error: 'PRODUCT_NOT_FOUND' });
    product.active = active;
    return repo.save(product);
  }

  listActiveProducts(): Promise<Product[]> {
    return this.dataSource.getRepository(Product).find({ where: { active: true }, order: { pointCost: 'ASC' } });
  }

  // --- 교환 (사용자) ---

  /**
   * 교환 신청. 확정 리워드에서 상품 포인트를 차감하고 교환 요청을 만든다.
   * 차감(reward_ledger REDEEM_DEBIT)과 요청 생성을 계정 잠금 단일 트랜잭션에서 원자 처리한다.
   * 검증 중(pending) 포인트로는 교환할 수 없다 — 확정 잔액만 쓴다.
   */
  async requestRedemption(userId: string, productId: string): Promise<Redemption> {
    return this.dataSource.transaction(async (manager) => {
      // 같은 계정의 동시 교환을 직렬화해 잔액 초과 차감을 막는다.
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`clawad:reward:${userId}`]);

      const product = await manager.findOne(Product, { where: { id: productId } });
      if (!product || !product.active) throw new NotFoundException({ error: 'PRODUCT_NOT_AVAILABLE' });

      const balance = await this.rewards.confirmedBalance(userId, manager);
      if (balance < product.pointCost) {
        throw new ConflictException({
          error: 'INSUFFICIENT_CONFIRMED_POINTS',
          confirmedPoints: balance,
          required: product.pointCost,
        });
      }

      const redemption = await manager.save(
        manager.create(Redemption, {
          userId,
          productId,
          pointsDebited: product.pointCost,
          status: RedemptionStatus.REQUESTED,
        }),
      );

      // 확정 포인트 차감(음수 append). 교환 id를 ref로 연결한다.
      await manager.save(
        manager.create(RewardLedgerEntry, {
          userId,
          entryType: RewardEntryType.REDEEM_DEBIT,
          points: -product.pointCost,
          refIdempotencyKey: `redeem:${redemption.id}`,
          reason: 'REDEMPTION',
        }),
      );

      await this.appendLedger(manager, redemption, RedemptionEntryType.REQUEST, `${product.brand} ${product.name}`);
      return redemption;
    });
  }

  listMyRedemptions(userId: string): Promise<Redemption[]> {
    return this.dataSource.getRepository(Redemption).find({ where: { userId }, order: { createdAt: 'DESC' } });
  }

  // --- 지급 처리 (운영자, 수동 발송) ---

  listPending(): Promise<Redemption[]> {
    return this.dataSource
      .getRepository(Redemption)
      .find({ where: { status: RedemptionStatus.REQUESTED }, order: { createdAt: 'ASC' } });
  }

  /** 운영자가 쿠폰을 수동 발송한 뒤 지급 완료로 전이. supplierRef는 주문번호 등 메모. */
  async markDelivered(redemptionId: string, supplierRef?: string): Promise<Redemption> {
    return this.transition(redemptionId, RedemptionStatus.DELIVERED, RedemptionEntryType.DELIVERED, supplierRef);
  }

  /** 발송 실패. 차감한 포인트를 원복한다. */
  async markFailed(redemptionId: string, reason?: string): Promise<Redemption> {
    return this.refundingTransition(
      redemptionId,
      RedemptionStatus.DELIVERY_FAILED,
      RedemptionEntryType.DELIVERY_FAILED,
      reason ?? 'DELIVERY_FAILED',
    );
  }

  /** 취소(사용자 요청·운영자 판단). 차감 포인트 원복. */
  async cancel(redemptionId: string, reason?: string): Promise<Redemption> {
    return this.refundingTransition(
      redemptionId,
      RedemptionStatus.CANCELED,
      RedemptionEntryType.CANCELED,
      reason ?? 'CANCELED',
    );
  }

  // --- 내부 ---

  private async appendLedger(
    manager: EntityManager,
    redemption: Redemption,
    entryType: RedemptionEntryType,
    detail?: string,
  ): Promise<void> {
    await manager.save(
      manager.create(RedemptionLedgerEntry, {
        redemptionId: redemption.id,
        userId: redemption.userId,
        entryType,
        detail: detail ? detail.slice(0, 200) : null,
      }),
    );
  }

  /** 포인트 이동 없는 전이(DELIVERED). REQUESTED에서만 가능. */
  private async transition(
    redemptionId: string,
    toStatus: RedemptionStatus,
    entryType: RedemptionEntryType,
    supplierRef?: string,
  ): Promise<Redemption> {
    return this.dataSource.transaction(async (manager) => {
      const redemption = await manager.findOne(Redemption, {
        where: { id: redemptionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!redemption) throw new NotFoundException({ error: 'REDEMPTION_NOT_FOUND' });
      if (redemption.status !== RedemptionStatus.REQUESTED) {
        throw new BadRequestException({ error: 'NOT_IN_REQUESTED_STATE', status: redemption.status });
      }
      redemption.status = toStatus;
      if (supplierRef !== undefined) redemption.supplierRef = supplierRef.slice(0, 200);
      await manager.save(redemption);
      await this.appendLedger(manager, redemption, entryType, supplierRef);
      return redemption;
    });
  }

  /** 포인트를 원복하며 전이(FAILED·CANCELED). REQUESTED에서만 가능(멱등: 이미 종료면 그대로). */
  private async refundingTransition(
    redemptionId: string,
    toStatus: RedemptionStatus,
    entryType: RedemptionEntryType,
    reason: string,
  ): Promise<Redemption> {
    return this.dataSource.transaction(async (manager) => {
      const redemption = await manager.findOne(Redemption, {
        where: { id: redemptionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!redemption) throw new NotFoundException({ error: 'REDEMPTION_NOT_FOUND' });
      if (redemption.status !== RedemptionStatus.REQUESTED) {
        throw new BadRequestException({ error: 'NOT_IN_REQUESTED_STATE', status: redemption.status });
      }

      // 차감했던 포인트를 원복한다(양수 append). 이미 종료 상태면 위 가드에서 막히므로 이중 원복 없음.
      await manager.save(
        manager.create(RewardLedgerEntry, {
          userId: redemption.userId,
          entryType: RewardEntryType.ADMIN_ADJUST,
          points: redemption.pointsDebited,
          refIdempotencyKey: `redeem-refund:${redemption.id}`,
          reason: `REDEMPTION_REFUND:${reason}`.slice(0, 64),
        }),
      );

      redemption.status = toStatus;
      await manager.save(redemption);
      await this.appendLedger(manager, redemption, entryType, reason);
      return redemption;
    });
  }
}
