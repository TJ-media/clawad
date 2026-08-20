import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { RateLimit } from '../common/rate-limit';
import { InquirySubmitResult, InquiriesService } from './inquiries.service';

class SubmitInquiryDto {
  /** 길이는 서버 정책·상수로 다시 검증한다. 여기 상한은 거대한 본문을 일찍 자르기 위한 것이다. */
  @IsString()
  @MaxLength(500)
  creativeText: string;

  @IsString()
  @MaxLength(500)
  brandName: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  linkUrl?: string;

  @IsInt()
  depositAmountKrw: number;

  @IsString()
  @MaxLength(200)
  depositorName: string;

  /** 이메일 또는 국내 휴대전화. 종류 판정은 서버가 한다. */
  @IsString()
  @MaxLength(254)
  contact: string;

  /**
   * 허니팟. 화면에서 CSS로 숨겨 사람은 채울 수 없다. 값이 있으면 봇으로 보고 조용히 버린다 —
   * 오류를 돌려주면 봇이 우회 지점을 알게 된다.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  company?: string;
}

/**
 * 광고 신청 접수 (CLAW-249).
 *
 * **비로그인 공개 엔드포인트다.** 광고주는 우리 서비스 계정이 없다. 인증 대신 레이트리밋·길이
 * 상한·허니팟으로 막는다.
 *
 * 경로에 `ad`·`advertiser` 토큰을 쓰지 않는다 — 광고 차단기의 URL 필터가 그런 경로의 `fetch`를
 * 막아 제출이 조용히 실패한다. 광고주 화면이라 차단기 사용률이 오히려 높다 (CLAW-226과 같은 이유).
 */
@Controller('v1/inquiries')
export class InquiriesController {
  constructor(private readonly inquiries: InquiriesService) {}

  /** 화면이 표시할 단가·입금액 범위. 숫자를 화면에 하드코딩하지 않는다 (rules §5). */
  @Get('limits')
  limits(): { pricePerImpressionKrw: number; minDepositKrw: number; maxDepositKrw: number } {
    return this.inquiries.limits();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ limit: 5, windowSec: 3600 })
  async submit(@Body() dto: SubmitInquiryDto): Promise<InquirySubmitResult> {
    if (dto.company) {
      // 봇. 성공처럼 보이는 응답을 주되 저장하지 않는다.
      return {
        inquiryId: '00000000-0000-0000-0000-000000000000',
        status: 'RECEIVED' as InquirySubmitResult['status'],
        pricePerImpressionKrw: this.inquiries.limits().pricePerImpressionKrw,
        estimatedImpressions: 0,
        receivedAt: new Date().toISOString(),
      };
    }
    return this.inquiries.submit(dto);
  }
}
