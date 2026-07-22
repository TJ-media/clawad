import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { loadPolicy } from '../common/policy';
import { RewardEntryType, RewardFunding, RewardLedgerEntry } from '../entities/reward-ledger.entity';
import { KillSwitchService } from '../events/kill-switch.service';
import { RewardService } from '../events/reward.service';
import { MAX_TEXT_ANSWER_LENGTH, questionsFor, stripControlChars } from './survey.definition';
import { SurveyResponse } from './survey-response.entity';

export interface SurveySubmitResult {
  surveyVersion: string;
  rewarded: boolean;
  points: number;
  balancePoints: number;
}

export interface SurveyStatus {
  surveyVersion: string;
  submitted: boolean;
  submittedAt: Date | null;
  /** 아직 응답하지 않은 사용자에게 보여줄 적립 예정 포인트. 정책값에서 온다. */
  rewardPoints: number;
}

/** PostgreSQL 유니크 제약 위반. 동시 제출 경합의 최종 방어선이다. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

/**
 * 만족도 설문 (CLAW-97).
 *
 * 응답 저장과 리워드 적립을 한 트랜잭션에서 처리한다 — 응답만 남고 적립이 누락되는 상태를 만들지 않는다.
 * 1인 1회는 survey_responses의 UNIQUE(userId, surveyVersion)와
 * reward_ledger의 UQ_reward_ledger_ref_type(refIdempotencyKey, entryType)이 이중으로 막는다.
 *
 * 광고 노출 리워드와 달리 사후 부정 검수 대상이 아니므로 pending을 거치지 않고 즉시 확정 적립한다.
 * 사후 회수는 같은 refIdempotencyKey의 CLAW_BACK 반대 분개로 성립하도록 기록해 두지만,
 * 현재 운영자 회수 API(admin-reward)는 노출 건만 대상으로 하므로 설문 오적립 전용 회수 경로는 아직 없다.
 * 필요해지면 별도 관리자 경로를 만든다 — 원장 항목을 수정·삭제하지 않는다 (rules §4).
 */
@Injectable()
export class SurveyService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly rewards: RewardService,
    private readonly killSwitch: KillSwitchService,
  ) {}

  /** 설문 리워드의 멱등 키. 사용자·설문 버전당 하나만 존재한다. */
  private refKey(version: string, userId: string): string {
    return `survey:${version}:${userId}`;
  }

  private activeVersion(): string {
    return loadPolicy().survey.version;
  }

  async status(userId: string): Promise<SurveyStatus> {
    const policy = loadPolicy().survey;
    const existing = await this.dataSource.getRepository(SurveyResponse).findOne({
      where: { userId, surveyVersion: policy.version },
    });
    return {
      surveyVersion: policy.version,
      submitted: Boolean(existing),
      submittedAt: existing?.createdAt ?? null,
      rewardPoints: policy.completionRewardPoints,
    };
  }

  /**
   * 클라이언트가 보낸 응답을 서버 정의로 검증한다.
   * 정의에 없는 문항 키·선택지 코드는 저장하지 않고 400으로 거절한다.
   */
  private validateAnswers(version: string, raw: unknown): Record<string, string> {
    const questions = questionsFor(version);
    if (!questions) throw new BadRequestException({ error: 'UNKNOWN_SURVEY_VERSION', surveyVersion: version });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException({ error: 'INVALID_ANSWER', reason: 'answers는 객체여야 합니다.' });
    }
    const input = raw as Record<string, unknown>;

    const known = new Set(questions.map((q) => q.key));
    for (const key of Object.keys(input)) {
      if (!known.has(key)) throw new BadRequestException({ error: 'INVALID_ANSWER', questionKey: key });
    }

    const answers: Record<string, string> = {};
    for (const question of questions) {
      const value = input[question.key];
      const missing = value === undefined || value === null || value === '';
      if (missing) {
        if (question.required) throw new BadRequestException({ error: 'INVALID_ANSWER', questionKey: question.key });
        continue;
      }
      if (typeof value !== 'string') {
        throw new BadRequestException({ error: 'INVALID_ANSWER', questionKey: question.key });
      }
      if (question.type === 'CHOICE') {
        if (!question.choices.includes(value)) {
          throw new BadRequestException({ error: 'INVALID_ANSWER', questionKey: question.key });
        }
        answers[question.key] = value;
        continue;
      }
      const text = stripControlChars(value).trim();
      if (text.length > MAX_TEXT_ANSWER_LENGTH) {
        throw new BadRequestException({
          error: 'INVALID_ANSWER',
          questionKey: question.key,
          maxLength: MAX_TEXT_ANSWER_LENGTH,
        });
      }
      if (text) answers[question.key] = text;
    }
    return answers;
  }

  async submit(userId: string, requestedVersion: string, rawAnswers: unknown): Promise<SurveySubmitResult> {
    const policy = loadPolicy().survey;
    // 클라이언트가 옛 버전 문항을 캐시한 채 제출하는 경우를 막는다. 활성 버전만 적립한다.
    if (requestedVersion !== policy.version) {
      throw new BadRequestException({
        error: 'UNKNOWN_SURVEY_VERSION',
        surveyVersion: requestedVersion,
        activeVersion: policy.version,
      });
    }
    const answers = this.validateAnswers(policy.version, rawAnswers);

    try {
      return await this.dataSource.transaction(async (manager) => {
        // 긴급 리워드 중지(GLOBAL_REWARDS)는 모든 적립 경로에 적용된다 (rules §7 서버 킬스위치).
        // 중지 중에는 응답도 저장하지 않는다 — 저장만 하고 적립이 없으면 재개 후 보상할 근거가 애매해진다.
        await this.killSwitch.acquireRewardsShared(manager);
        if (await this.killSwitch.isRewardsPaused(manager)) {
          throw new ServiceUnavailableException({ error: 'REWARDS_PAUSED' });
        }
        // 같은 계정의 리워드 쓰기를 직렬화한다. 적립 배치·교환·탈퇴 정산과 같은 키를 쓴다.
        await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`clawad:reward:${userId}`]);

        const responses = manager.getRepository(SurveyResponse);
        const already = await responses.findOne({ where: { userId, surveyVersion: policy.version } });
        if (already) throw new ConflictException({ error: 'ALREADY_SUBMITTED' });

        await responses.insert({ userId, surveyVersion: policy.version, answers });

        await manager.getRepository(RewardLedgerEntry).insert({
          userId,
          entryType: RewardEntryType.PROMO_ACCRUE,
          points: policy.completionRewardPoints,
          refIdempotencyKey: this.refKey(policy.version, userId),
          // 광고주 매출과 무관한 회사 재원 프로모션이다 (rules §5).
          funding: RewardFunding.COMPANY,
          reason: `SURVEY_COMPLETION_${policy.version.toUpperCase()}`,
        });

        const balancePoints = await this.rewards.confirmedBalance(userId, manager);
        return {
          surveyVersion: policy.version,
          rewarded: true,
          points: policy.completionRewardPoints,
          balancePoints,
        };
      });
    } catch (error) {
      // 동시 제출로 유니크 제약에 걸린 쪽은 이미 다른 요청이 적립을 마친 경우다.
      if (isUniqueViolation(error)) throw new ConflictException({ error: 'ALREADY_SUBMITTED' });
      throw error;
    }
  }

  /** 활성 설문의 문항 정의. 화면이 서버 정의를 그대로 렌더링할 때 쓴다. */
  definition(): { surveyVersion: string; questions: readonly unknown[] } {
    const version = this.activeVersion();
    return { surveyVersion: version, questions: questionsFor(version) ?? [] };
  }
}
