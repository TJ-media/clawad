import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, Not } from 'typeorm';
import { loadPolicy } from '../common/policy';
import { Machine, MachineStatus } from '../entities/machine.entity';
import { User } from '../entities/user.entity';

export interface MachineView {
  machineId: string;
  status: MachineStatus;
  registeredAt: Date;
}

@Injectable()
export class MachinesService {
  private readonly logger = new Logger(MachinesService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** 기기 상한은 정책 설정에서 읽는다. 코드에 숫자를 하드코딩하지 않는다 (CLAW-12). */
  private get maxDevices(): number {
    return loadPolicy().device.maxDevicesPerAccount;
  }

  private toView(m: Machine): MachineView {
    return { machineId: m.machineId, status: m.status, registeredAt: m.registeredAt };
  }

  /**
   * 기기 등록. 멱등 — 이미 활성인 기기를 다시 등록하면 그대로 반환한다.
   * 상한 검사와 삽입은 사용자 행을 잠근 하나의 트랜잭션 안에서 수행한다.
   * 메모리 카운터로 동시성을 보장하지 않는다 (rules §4b).
   */
  async register(userId: string, machineId: string): Promise<MachineView> {
    return this.dataSource.transaction(async (manager) => {
      // 같은 계정의 동시 등록 요청을 직렬화한다.
      await manager.findOne(User, { where: { id: userId }, lock: { mode: 'pessimistic_write' } });

      const existing = await manager.findOne(Machine, { where: { userId, machineId } });

      if (existing?.status === MachineStatus.BLOCKED) {
        throw new ForbiddenException({ error: 'MACHINE_BLOCKED', reason: existing.blockedReason });
      }
      if (existing?.status === MachineStatus.ACTIVE) {
        return this.toView(existing);
      }

      const activeCount = await manager.count(Machine, { where: { userId, status: MachineStatus.ACTIVE } });
      if (activeCount >= this.maxDevices) {
        throw new ConflictException({
          error: 'MACHINE_LIMIT_EXCEEDED',
          limit: this.maxDevices,
          active: activeCount,
          message: '기존 기기를 먼저 해제한 뒤 새 기기를 등록하세요.',
        });
      }

      await this.recordMultiAccountRiskSignal(manager, userId, machineId);

      if (existing) {
        // RELEASED → ACTIVE 재활성화. 행을 새로 만들지 않고 상태만 전이한다.
        existing.status = MachineStatus.ACTIVE;
        existing.releasedAt = null;
        return this.toView(await manager.save(existing));
      }

      const created = manager.create(Machine, { userId, machineId, status: MachineStatus.ACTIVE });
      return this.toView(await manager.save(created));
    });
  }

  /**
   * 같은 machineId가 다른 계정에도 등록돼 있으면 위험 신호만 남긴다.
   * 자동 차단·자동 부정 처리하지 않는다 (CLAW-19). machineId는 하드웨어 지문이 아니므로
   * 동일인·동일 기기를 확정 탐지한다고 표현하지 않는다.
   */
  private async recordMultiAccountRiskSignal(manager: EntityManager, userId: string, machineId: string): Promise<void> {
    const otherAccounts = await manager.count(Machine, {
      where: { machineId, userId: Not(userId), status: MachineStatus.ACTIVE },
    });
    if (otherAccounts > 0) {
      // 이메일·토큰을 로그에 남기지 않는다 (privacy-design.md §6.5).
      this.logger.warn(
        `MULTI_ACCOUNT_RISK: machineId가 다른 활성 계정 ${otherAccounts}건에도 등록됨 — 수동 검토 대상(자동 제재 아님)`,
      );
    }
  }

  async list(userId: string): Promise<MachineView[]> {
    const machines = await this.dataSource.getRepository(Machine).find({
      where: { userId },
      order: { registeredAt: 'ASC' },
    });
    return machines.map((m) => this.toView(m));
  }

  /** 기기 해제. 행을 삭제하지 않고 RELEASED로 전이한다. 차단된 기기는 사용자가 해제할 수 없다. */
  async release(userId: string, machineId: string): Promise<MachineView> {
    return this.dataSource.transaction(async (manager) => {
      await manager.findOne(User, { where: { id: userId }, lock: { mode: 'pessimistic_write' } });

      const machine = await manager.findOne(Machine, { where: { userId, machineId } });
      if (!machine) throw new NotFoundException({ error: 'MACHINE_NOT_FOUND' });
      if (machine.status === MachineStatus.BLOCKED) {
        throw new ForbiddenException({ error: 'MACHINE_BLOCKED', reason: machine.blockedReason });
      }
      if (machine.status === MachineStatus.RELEASED) {
        return this.toView(machine); // 멱등
      }

      machine.status = MachineStatus.RELEASED;
      machine.releasedAt = new Date();
      return this.toView(await manager.save(machine));
    });
  }
}
