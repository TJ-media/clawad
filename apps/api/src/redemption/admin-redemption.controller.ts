import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Min } from 'class-validator';
import { AdminGuard } from '../admin/admin.guard';
import { AdminRole } from '../admin/admin-user.entity';
import { AuditInterceptor } from '../admin/audit.interceptor';
import { Roles } from '../admin/roles.decorator';
import { Product } from './product.entity';
import { Redemption } from './redemption.entity';
import { RedemptionService } from './redemption.service';

class CreateProductDto {
  @IsString()
  @Length(1, 200)
  name: string;

  @IsString()
  @Length(1, 60)
  brand: string;

  @IsInt()
  @Min(1)
  pointCost: number;
}

class SetActiveDto {
  @IsBoolean()
  active: boolean;
}

class DeliverDto {
  /** 운영자 수동 발송 참조 메모(주문번호 등). 쿠폰 코드·연락처는 넣지 않는다. */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  supplierRef?: string;
}

class ReasonDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  reason?: string;
}

/** 운영자 교환 관리 (CLAW-26). 상품=SUPERADMIN, 지급 처리=SETTLER. 변경 조작은 감사 기록. */
@Controller('internal/v1')
@UseGuards(AdminGuard)
@UseInterceptors(AuditInterceptor)
export class AdminRedemptionController {
  constructor(private readonly redemption: RedemptionService) {}

  @Post('products')
  @HttpCode(HttpStatus.CREATED)
  @Roles(AdminRole.SUPERADMIN)
  createProduct(@Body() dto: CreateProductDto): Promise<Product> {
    return this.redemption.createProduct(dto.name, dto.brand, dto.pointCost);
  }

  @Post('products/:id/active')
  @HttpCode(HttpStatus.OK)
  @Roles(AdminRole.SUPERADMIN)
  setActive(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetActiveDto): Promise<Product> {
    return this.redemption.setProductActive(id, dto.active);
  }

  /** 수동 발송 대기 큐. */
  @Get('redemptions/pending')
  @Roles(AdminRole.SETTLER)
  pending(): Promise<Redemption[]> {
    return this.redemption.listPending();
  }

  /** 운영자가 쿠폰을 직접 보낸 뒤 지급 완료 처리. */
  @Post('redemptions/:id/deliver')
  @HttpCode(HttpStatus.OK)
  @Roles(AdminRole.SETTLER)
  deliver(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DeliverDto): Promise<Redemption> {
    return this.redemption.markDelivered(id, dto.supplierRef);
  }

  @Post('redemptions/:id/fail')
  @HttpCode(HttpStatus.OK)
  @Roles(AdminRole.SETTLER)
  fail(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto): Promise<Redemption> {
    return this.redemption.markFailed(id, dto.reason);
  }

  @Post('redemptions/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(AdminRole.SETTLER)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto): Promise<Redemption> {
    return this.redemption.cancel(id, dto.reason);
  }
}
