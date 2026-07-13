import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import { ConsentType } from '../entities/consent.entity';

export class ConsentInput {
  @IsEnum(ConsentType)
  type: ConsentType;

  @IsBoolean()
  granted: boolean;

  @IsString()
  @Length(1, 32)
  documentVersion: string;
}

export class RefreshDto {
  @IsString()
  @Length(1, 512)
  refreshToken: string;
}

export type SocialIntent = 'LOGIN' | 'LINK';

/** 소셜 로그인 시작. LINK는 기존 Bearer 인증이 필수다(컨트롤러에서 확인). */
export class SocialStartDto {
  @IsIn(['LOGIN', 'LINK'])
  intent: SocialIntent;

  /**
   * 콜백 후 handoff code를 fragment로 받을 return target.
   * 설정 allowlist 또는 127.0.0.1 loopback만 허용된다(서버 검증). 임의 외부 URL은 거절.
   */
  @IsString()
  @Length(1, 512)
  returnTarget: string;
}

/** handoff code 교환. 신규 소셜 사용자는 필수 동의를 함께 보내야 계정이 생성된다. */
export class SocialExchangeDto {
  @IsString()
  @Length(1, 128)
  handoffCode: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ConsentInput)
  consents?: ConsentInput[];
}
