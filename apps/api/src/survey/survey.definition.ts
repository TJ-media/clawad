/**
 * 만족도 설문 정의 (CLAW-97). 문항·선택지의 단일 원본은 **서버**다.
 * 클라이언트가 보낸 문항 키·선택지 코드를 그대로 신뢰하지 않고 이 정의로 검증한다.
 *
 * 문항을 바꾸면 새 버전을 추가한다. 기존 버전의 문항을 수정하지 않는다 —
 * 이미 저장된 응답의 의미가 바뀌어 집계가 깨진다. 리워드도 버전 단위로 1회씩 지급된다.
 */

export type SurveyQuestionType = 'CHOICE' | 'TEXT';

export interface SurveyQuestion {
  key: string;
  type: SurveyQuestionType;
  required: boolean;
  /** CHOICE 문항의 허용 선택지 코드. TEXT 문항은 비어 있다. */
  choices: readonly string[];
}

/** 자유 응답 길이 상한. 초과분을 자르지 않고 400으로 거절한다. */
export const MAX_TEXT_ANSWER_LENGTH = 1000;

const V1_QUESTIONS: readonly SurveyQuestion[] = [
  {
    key: 'usagePeriod',
    type: 'CHOICE',
    required: true,
    choices: ['FIRST_DAY', 'UNDER_WEEK', 'ONE_TO_FOUR_WEEKS', 'OVER_MONTH'],
  },
  {
    key: 'overallSatisfaction',
    type: 'CHOICE',
    required: true,
    choices: ['VERY_UNSATISFIED', 'UNSATISFIED', 'NEUTRAL', 'SATISFIED', 'VERY_SATISFIED'],
  },
  {
    key: 'adInterference',
    type: 'CHOICE',
    required: true,
    choices: ['NOT_AT_ALL', 'BARELY', 'SOMETIMES', 'OFTEN', 'SEVERE'],
  },
  {
    key: 'accrualSpeed',
    type: 'CHOICE',
    required: true,
    choices: ['TOO_SLOW', 'SLIGHTLY_SLOW', 'REASONABLE', 'FAST', 'NOT_CHECKED'],
  },
  {
    key: 'catalogSatisfaction',
    type: 'CHOICE',
    required: true,
    choices: ['VERY_UNSATISFIED', 'UNSATISFIED', 'NEUTRAL', 'SATISFIED', 'VERY_SATISFIED', 'NOT_VISITED'],
  },
  { key: 'onboardingIssues', type: 'TEXT', required: false, choices: [] },
  {
    key: 'continueIntent',
    type: 'CHOICE',
    required: true,
    choices: ['WILL_CONTINUE', 'UNSURE', 'WILL_STOP'],
  },
  { key: 'improvements', type: 'TEXT', required: false, choices: [] },
];

const DEFINITIONS: Readonly<Record<string, readonly SurveyQuestion[]>> = {
  v1: V1_QUESTIONS,
};

export function questionsFor(version: string): readonly SurveyQuestion[] | null {
  return DEFINITIONS[version] ?? null;
}

/** 제어문자(개행 제외)를 제거한다. 응답을 로그·운영 화면에 그대로 쓰기 때문이다. */
export function stripControlChars(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    if (code === 0x0a) out += ch;
    else if (code < 0x20 || code === 0x7f) continue;
    else out += ch;
  }
  return out;
}
