import { Controller, Get } from '@nestjs/common';
import { Product } from './product.entity';
import { RedemptionService } from './redemption.service';

/**
 * 교환 상품 카탈로그 — **무인증 공개** (CLAW-253).
 *
 * 리워드 샵 창은 로그인 전에도 열린다. 무엇을 교환할 수 있는지 보고 나서 가입할지 정할 수
 * 있어야 하므로 카탈로그만 세션 없이 연다. 나가는 것은 운영자가 등록한 상품 목록뿐이며
 * 사용자·잔액·교환 이력은 담기지 않는다 — 그 경로는 `RedemptionController`에 남아 있고
 * 여전히 `JwtAuthGuard`를 지난다.
 *
 * 같은 이유로 이 컨트롤러에 조회 외의 라우트를 추가하지 않는다.
 */
@Controller('v1/rewards')
export class PublicCatalogController {
  constructor(private readonly redemption: RedemptionService) {}

  @Get('products')
  products(): Promise<Product[]> {
    return this.redemption.listActiveProducts();
  }
}
