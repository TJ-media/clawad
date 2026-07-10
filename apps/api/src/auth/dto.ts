import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsEmail, IsEnum, IsString, Length, ValidateNested } from 'class-validator';
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

export class SignupDto {
  @IsEmail()
  @Length(3, 320)
  email: string;

  /** 최소 길이만 강제한다. 원문은 로그·응답 어디에도 남기지 않는다. */
  @IsString()
  @Length(10, 200)
  password: string;

  /** 동의는 항목별로 독립 전달한다. 필수 동의 누락 시 400 (privacy-design.md §3). */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ConsentInput)
  consents: ConsentInput[];
}

export class LoginDto {
  @IsEmail()
  @Length(3, 320)
  email: string;

  @IsString()
  @Length(1, 200)
  password: string;
}

export class RefreshDto {
  @IsString()
  @Length(1, 512)
  refreshToken: string;
}
