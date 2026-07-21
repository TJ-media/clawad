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
  // 웹(쿠키) 모드에서는 refresh 토큰이 httpOnly 쿠키로 오므로 본문이 비어 있을 수 있다(CLAW-38).
  // 비브라우저(CLI)는 본문으로 보낸다. 컨트롤러가 쿠키 우선, 없으면 본문을 쓴다.
  @IsOptional()
  @IsString()
  @Length(1, 512)
  refreshToken?: string;
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

  /**
   * 웹 세션 모드(CLAW-38). true면 서버가 refresh 토큰을 httpOnly 쿠키로 내려주고
   * 응답 본문에는 accessToken만 담는다. 미지정(CLI 등)이면 현행 본문 방식.
   */
  @IsOptional()
  @IsBoolean()
  useCookie?: boolean;
}
