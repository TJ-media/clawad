import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from '../admin/admin.module';
import { AdminInquiriesController } from './admin-inquiries.controller';
import { Inquiry } from './inquiry.entity';
import { InquiriesController } from './inquiries.controller';
import { InquiriesService } from './inquiries.service';
import { InquiryNotifierService } from './inquiry-notifier.service';

/**
 * 광고 신청 접수 (CLAW-249). 공개 폼은 인증이 없고 운영 경로만 AdminGuard를 탄다.
 * AuthModule을 넣지 않는다 — 광고주는 우리 서비스 계정이 없다.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Inquiry]), AdminModule],
  controllers: [InquiriesController, AdminInquiriesController],
  providers: [InquiriesService, InquiryNotifierService],
  exports: [InquiriesService],
})
export class InquiriesModule {}
