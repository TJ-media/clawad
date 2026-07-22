import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { loadPolicy } from '../common/policy';
import { RewardService } from './reward.service';

/**
 * 리워드 적립·확정 주기 실행 (CLAW-102).
 *
 * runAccrual/runConfirmation은 관리자 엔드포인트로만 노출돼 있어 아무도 호출하지 않았고,
 * ACCEPTED 노출이 reward_ledger로 전환되지 않아 사용자 포인트가 영구히 0이었다.
 *
 * 새 패키지를 들이지 않기 위해(rules §8) @nestjs/schedule 대신 setInterval을 쓴다.
 * 실행 주기는 정책 설정에서 읽는다 — 코드에 숫자를 하드코딩하지 않는다.
 *
 * 두 작업 모두 계정 잠금과 멱등 키 위에서 동작하므로, 실행이 겹치거나 중복돼도
 * 원장이 이중 계상되지 않는다. 그래도 불필요한 경합을 줄이려 실행 중에는 다음 tick을 건너뛴다.
 */
@Injectable()
export class RewardSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RewardSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly rewards: RewardService) {}

  onModuleInit(): void {
    const intervalMs = loadPolicy().scheduler.rewardRunIntervalMs;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      this.logger.warn('REWARD_SCHEDULER_DISABLED');
      return;
    }
    this.timer = setInterval(() => void this.tick(), intervalMs);
    // 스케줄러 때문에 프로세스가 종료되지 못하게 붙잡지 않는다.
    this.timer.unref?.();
    this.logger.log(`REWARD_SCHEDULER_STARTED interval=${intervalMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 한 주기 실행. 예외는 삼키고 다음 주기에 재시도한다 — 스케줄러가 죽으면 적립이 멈춘다. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const accrual = await this.rewards.runAccrual();
      const confirmation = await this.rewards.runConfirmation();
      if (accrual.accruedRows || confirmation.confirmedRows) {
        this.logger.log(
          `REWARD_RUN accrued=${accrual.accruedRows}/${accrual.accruedPoints}P ` +
            `confirmed=${confirmation.confirmedRows}/${confirmation.confirmedPoints}P`,
        );
      }
    } catch {
      // 원문에는 연결 문자열·키가 섞일 수 있어 고정 코드만 남긴다.
      this.logger.warn('REWARD_RUN_FAILED');
    } finally {
      this.running = false;
    }
  }
}
