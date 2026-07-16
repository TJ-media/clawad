import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { IsOptional, IsUUID } from 'class-validator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Product } from './product.entity';
import { Redemption } from './redemption.entity';
import { RedemptionService } from './redemption.service';

class RedeemDto {
  @IsUUID()
  productId: string;

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

  /** 교환 신청 — 확정 포인트 차감 + 교환 요청 생성. */
  @Post('redeem')
  @HttpCode(HttpStatus.CREATED)
  redeem(@Req() req: AuthenticatedRequest, @Body() dto: RedeemDto): Promise<Redemption> {
    return this.redemption.requestRedemption(req.userId, dto.productId, dto.idempotencyKey ?? null);
  }

  /** 내 교환 내역·상태. */
  @Get('redemptions')
  myRedemptions(@Req() req: AuthenticatedRequest): Promise<Redemption[]> {
    return this.redemption.listMyRedemptions(req.userId);
  }
}
