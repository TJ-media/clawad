import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { loadPolicy } from '../common/policy';
import { RewardEntryType, RewardFunding, RewardLedgerEntry } from '../entities/reward-ledger.entity';
import { KillSwitchService } from '../events/kill-switch.service';
import { maskEmail } from '../redemption/redemption.service';
import { RewardService } from '../events/reward.service';
import { Report, ReportStatus } from './report.entity';
import { ReportNotifierService } from './report-notifier.service';

export interface ReportView {
  id: string;
  body: string;
  status: ReportStatus;
  createdAt: Date;
  reply: string | null;
  repliedAt: Date | null;
  rewardPoints: number;
  read: boolean;
}

export interface ReportSubmitResult {
  reportId: string;
  submittedAt: Date;
}

/** 운영자 목록 항목. 이메일은 마스킹해서 내려간다 — 원문은 별도 경로로만 본다. */
export interface AdminReportView {
  id: string;
  userId: string;
  body: string;
  status: ReportStatus;
  createdAt: Date;
  reply: string | null;
  repliedAt: Date | null;
  rewardPoints: number;
  /** 마스킹된 답변 이메일. 없으면 null. */
  replyEmailMasked: string | null;
}

export interface ReportReplyResult {
  reportId: string;
  repliedAt: Date;
  rewardedPoints: number;
  balancePoints: number;
}

/** 이메일 형식은 최소한만 본다 — 실제 도달 가능 여부는 발송 시점에 드러난다. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 제어문자 제거. 설문 자유 응답과 같은 처리다. */
function stripControlChars(value: string): string {
  return [...value].filter((c) => {
    const code = c.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  }).join('');
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

/**
 * 이용자 제보 (CLAW-234).
 *
 * 포상 지급은 설문 완료 리워드(SurveyService)와 **같은 순서**를 따른다 — 킬스위치 확인 →
 * 계정별 advisory lock → 원장 append → 잔액 재계산. balance 필드를 직접 쓰지 않는다 (rules §4).
 *
 * 설문과 다른 점은 **답변과 포상을 분리**한다는 것이다. 포상은 선택이고, 리워드가 중지된 동안에도
 * 답변 자체는 나갈 수 있어야 한다 — 사용자를 기다리게 할 이유가 없다.
 */
@Injectable()
export class ReportsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly rewards: RewardService,
    private readonly killSwitch: KillSwitchService,
    private readonly notifier: ReportNotifierService,
  ) {}

  private policy() {
    return loadPolicy().bugReport;
  }

  /** 포상 리워드의 멱등 키. 제보 1건당 하나만 존재한다. */
  private refKey(reportId: string): string {
    return `report:${reportId}`;
  }

  /** 화면이 보여줄 정책값. 숫자를 화면에 하드코딩하지 않기 위해 서버가 내려준다 (rules §5). */
  limits(): { maxBodyLength: number; dailySubmitLimit: number; maxRewardPoints: number } {
    const policy = this.policy();
    return {
      maxBodyLength: policy.maxBodyLength,
      dailySubmitLimit: policy.dailySubmitLimit,
      maxRewardPoints: policy.maxRewardPoints,
    };
  }

  async submit(
    userId: string,
    rawBody: string,
    replyEmail?: string,
    replyEmailConsent?: boolean,
  ): Promise<ReportSubmitResult> {
    const policy = this.policy();
    const body = stripControlChars(String(rawBody ?? '')).trim();
    if (!body) throw new BadRequestException({ error: 'EMPTY_BODY' });
    if (body.length > policy.maxBodyLength) throw new BadRequestException({ error: 'BODY_TOO_LONG' });

    // 이메일은 선택이다. 넣었으면 동의가 함께 와야 한다 — 쿠폰 발송 이메일과 같은 규칙 (CLAW-74).
    const email = typeof replyEmail === 'string' ? replyEmail.trim() : '';
    if (email && !EMAIL_PATTERN.test(email)) throw new BadRequestException({ error: 'INVALID_EMAIL' });
    if (email && !replyEmailConsent) throw new BadRequestException({ error: 'EMAIL_CONSENT_REQUIRED' });

    const report = await this.dataSource.transaction(async (manager) => {
      // 계정당 하루 제출 상한. 익명 제출을 열지 않았어도 한 계정이 도배할 수 있다.
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const todayCount = await manager
        .createQueryBuilder(Report, 'r')
        .where('r."userId" = :userId AND r."createdAt" >= :since', { userId, since })
        .getCount();
      if (todayCount >= policy.dailySubmitLimit) {
        throw new ConflictException({ error: 'DAILY_SUBMIT_LIMIT_EXCEEDED' });
      }
      return manager.save(manager.create(Report, {
        userId,
        body,
        status: ReportStatus.OPEN,
        replyEmail: email || null,
        replyEmailConsentAt: email ? new Date() : null,
      }));
    });

    // 알림 실패가 제보 저장을 되돌리지 않는다 — 사용자가 쓴 글이 사라지면 안 된다.
    await this.notifier.notifySubmitted(report);
    return { reportId: report.id, submittedAt: report.createdAt };
  }

  async listMine(userId: string): Promise<{ reports: ReportView[]; unread: number }> {
    const rows = await this.dataSource.getRepository(Report).find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    const reports = rows.map((r) => ({
      id: r.id,
      body: r.body,
      status: r.status,
      createdAt: r.createdAt,
      reply: r.reply,
      repliedAt: r.repliedAt,
      rewardPoints: r.rewardPoints,
      read: r.readAt !== null,
    }));
    // 안 읽은 답변만 센다. 답변이 없는 제보는 읽을 것이 없다.
    const unread = rows.filter((r) => r.repliedAt !== null && r.readAt === null).length;
    return { reports, unread };
  }

  /** 답변 읽음 처리. 멱등이다 — 이미 읽었으면 시각을 덮어쓰지 않는다. */
  async markRead(userId: string, reportId: string): Promise<{ reportId: string; read: boolean }> {
    const repo = this.dataSource.getRepository(Report);
    const report = await repo.findOne({ where: { id: reportId, userId } });
    if (!report) throw new NotFoundException({ error: 'REPORT_NOT_FOUND' });
    if (report.repliedAt && !report.readAt) {
      await repo.update({ id: reportId, userId }, { readAt: new Date() });
    }
    return { reportId, read: true };
  }

  /**
   * 운영자 목록. 미답변이 위로 온다.
   *
   * **이메일은 마스킹해서 내려간다.** 목록 화면은 훑어보는 자리라 원문이 어깨너머·스크린샷으로
   * 새기 쉽다. 수동 발송에 필요한 원문은 `revealEmail`로 건별로만 꺼내고 감사 로그에 남긴다.
   */
  async listForAdmin(): Promise<AdminReportView[]> {
    const rows = await this.dataSource.getRepository(Report).find({
      order: { status: 'ASC', createdAt: 'DESC' },
      take: 200,
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      body: r.body,
      status: r.status,
      createdAt: r.createdAt,
      reply: r.reply,
      repliedAt: r.repliedAt,
      rewardPoints: r.rewardPoints,
      replyEmailMasked: maskEmail(r.replyEmail),
    }));
  }

  /**
   * 답변 이메일 원문. 운영자가 수동 발송할 때만 쓴다.
   * 이 경로를 부른 사실은 AuditInterceptor가 남긴다 — 목록에 원문을 싣지 않는 이유가 그것이다.
   */
  async revealEmail(reportId: string): Promise<{ reportId: string; replyEmail: string | null }> {
    const report = await this.dataSource.getRepository(Report).findOne({ where: { id: reportId } });
    if (!report) throw new NotFoundException({ error: 'REPORT_NOT_FOUND' });
    return { reportId, replyEmail: report.replyEmail };
  }

  async reply(reportId: string, rawReply: string, rewardPoints?: number): Promise<ReportReplyResult> {
    const policy = this.policy();
    const reply = stripControlChars(String(rawReply ?? '')).trim();
    if (!reply) throw new BadRequestException({ error: 'EMPTY_REPLY' });

    // 포상 금액은 운영자가 정한다. 정책은 상한만 강제한다 (rules §5) — 상한이 없으면
    // 오타 한 번이 그대로 원장에 들어가고, 원장은 수정·삭제할 수 없다.
    const points = Number.isInteger(rewardPoints) ? (rewardPoints as number) : 0;
    if (points < 0) throw new BadRequestException({ error: 'INVALID_REWARD_POINTS' });
    if (points > policy.maxRewardPoints) throw new BadRequestException({ error: 'REWARD_POINTS_EXCEEDS_LIMIT' });

    try {
      return await this.dataSource.transaction(async (manager) => {
        const report = await manager.findOne(Report, { where: { id: reportId } });
        if (!report) throw new NotFoundException({ error: 'REPORT_NOT_FOUND' });
        if (report.repliedAt) throw new ConflictException({ error: 'ALREADY_ANSWERED' });

        if (points > 0) {
          await this.grantReward(manager, report.userId, reportId, points);
        }

        const repliedAt = new Date();
        await manager.update(Report, { id: reportId }, {
          reply,
          repliedAt,
          rewardPoints: points,
          status: ReportStatus.ANSWERED,
          // 답변으로 목적을 달성했으므로 이메일을 즉시 파기한다 (보유 최소화, CLAW-233).
          // 동의 시각은 증적으로 남긴다.
          replyEmail: null,
        });

        const balancePoints = await this.rewards.confirmedBalance(report.userId, manager);
        return { reportId, repliedAt, rewardedPoints: points, balancePoints };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException({ error: 'ALREADY_ANSWERED' });
      throw error;
    }
  }

  /**
   * 포상 적립. 설문 완료 리워드와 같은 순서다 (SurveyService 참고).
   * 광고 노출 리워드와 달리 사후 부정 검수 대상이 아니므로 pending을 거치지 않고 즉시 확정한다.
   */
  private async grantReward(
    manager: EntityManager,
    userId: string,
    reportId: string,
    points: number,
  ): Promise<void> {
    await this.killSwitch.acquireRewardsShared(manager);
    if (await this.killSwitch.isRewardsPaused(manager)) {
      throw new ServiceUnavailableException({ error: 'REWARDS_PAUSED' });
    }
    // 같은 계정의 리워드 쓰기를 직렬화한다. 적립 배치·교환·탈퇴 정산과 같은 키다.
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`clawad:reward:${userId}`]);
    await manager.getRepository(RewardLedgerEntry).insert({
      userId,
      entryType: RewardEntryType.PROMO_ACCRUE,
      points,
      refIdempotencyKey: this.refKey(reportId),
      // 광고주 매출과 무관한 회사 재원 프로모션이다 (rules §5).
      funding: RewardFunding.COMPANY,
      reason: `BUG_REPORT_${reportId}`,
    });
  }
}
