import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { Equals, IsEmail, IsOptional, IsUUID, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Product } from './product.entity';
import { RedemptionService, RedemptionView } from './redemption.service';

class RedeemDto {
  @IsUUID()
  productId: string;

  /**
   * 쿠폰을 받을 발송 이메일 (CLAW-74). 사용자가 직접 입력·확인한다. OAuth 이메일에 의존하지 않는다.
   * 운영자는 이 주소로 수동 발송한다. 로그인 식별자로 쓰지 않는다.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  @MaxLength(320)
  deliveryEmail: string;

  /** 발송 목적의 이메일 수집·이용 동의. 반드시 true여야 한다(미동의 시 400). */
  @Equals(true)
  deliveryEmailConsent: boolean;

  /** 교환 의도별 클라이언트 생성 UUID (CLAW-73). 같은 키의 재시도는 최초 결과를 반환한다. 미전송 시 멱등 보장 없음. */
  @IsOptional()
  @IsUUID()
  idempotencyKey?: string;
}

/** 사용자 교환 (CLAW-26). userId는 세션에서 확정한다. */
@Controller('v1/rewards')
@UseGuards(JwtAuthGuard)
export class RedemptionController {
  constructor(private readonly redemption: RedemptionService) {}

  /** 교환 가능한 지정 상품 카탈로그. */
  @Get('products')
  products(): Promise<Product[]> {
    return this.redemption.listActiveProducts();
  }

  /** 교환 신청 — 확정 포인트 차감 + 교환 요청 생성. 발송 이메일을 스냅샷으로 저장한다. */
  @Post('redeem')
  @HttpCode(HttpStatus.CREATED)
  redeem(@Req() req: AuthenticatedRequest, @Body() dto: RedeemDto): Promise<RedemptionView> {
    return this.redemption.requestRedemption(req.userId, dto.productId, dto.deliveryEmail, dto.idempotencyKey ?? null);
  }

  /** 내 교환 내역·상태. 발송 이메일은 마스킹 값으로만 반환한다. */
  @Get('redemptions')
  myRedemptions(@Req() req: AuthenticatedRequest): Promise<RedemptionView[]> {
    return this.redemption.listMyRedemptions(req.userId);
  }
}
