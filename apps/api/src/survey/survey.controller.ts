import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { IsObject, IsString, MaxLength } from 'class-validator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SurveyService, SurveyStatus, SurveySubmitResult } from './survey.service';

class SubmitSurveyDto {
  /** 응답한 설문 정의의 버전. 활성 버전과 다르면 400이다. */
  @IsString()
  @MaxLength(32)
  surveyVersion: string;

  /** 문항 키 → 선택지 코드 또는 자유 텍스트. 상세 검증은 서버 정의로 한다. */
  @IsObject()
  answers: Record<string, unknown>;
}

/** 만족도 설문 (CLAW-97). userId는 세션에서 확정한다 — 요청 본문의 자가신고를 신뢰하지 않는다. */
@Controller('v1/survey')
@UseGuards(JwtAuthGuard)
export class SurveyController {
  constructor(private readonly survey: SurveyService) {}

  /** 활성 설문의 문항 정의. */
  @Get('definition')
  definition(): { surveyVersion: string; questions: readonly unknown[] } {
    return this.survey.definition();
  }

  /** 내 응답·적립 여부. 화면이 재응답을 막고 안내 문구를 고르는 데 쓴다. */
  @Get('status')
  status(@Req() req: AuthenticatedRequest): Promise<SurveyStatus> {
    return this.survey.status(req.userId);
  }

  /** 응답 제출 + 설문 완료 리워드 즉시 확정 적립. */
  @Post('responses')
  @HttpCode(HttpStatus.CREATED)
  submit(@Req() req: AuthenticatedRequest, @Body() dto: SubmitSurveyDto): Promise<SurveySubmitResult> {
    return this.survey.submit(req.userId, dto.surveyVersion, dto.answers);
  }
}
