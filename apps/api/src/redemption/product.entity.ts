import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * 교환 상품 카탈로그 (CLAW-26). 지정 상품(모바일 쿠폰)만 교환 가능한 화이트리스트다 (rules §5).
 * 클로애드는 지급수단을 발행하지 않는다 — 이 상품은 외부 브랜드 상품권을 가리키며,
 * 알파에서는 운영자가 수동으로 발송한다. 벤더 API 자동 발급은 P2.
 */
@Entity('products')
export class Product {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 60 })
  brand: string;

  /** 교환에 필요한 확정 포인트. 정책 최소 교환액(minimumRedemptionPoints) 이상이어야 한다. */
  @Column({ type: 'bigint', transformer: { to: (v: number) => v, from: (v: string) => Number(v) } })
  pointCost: number;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
