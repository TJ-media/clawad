import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AuthService, TokenPair } from './auth.service';
import { RefreshDto } from './dto';

/**
 * 세션 토큰 회전·폐기. 공개 사용자 로그인·가입은 소셜 전용이며 SocialAuthController가 담당한다(CLAW-37).
 * 이메일/비밀번호 signup·login은 비활성화됐다(관리자 로그인은 admin/v1/auth로 별도 유지).
 */
@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto): Promise<TokenPair> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() dto: RefreshDto): Promise<void> {
    await this.auth.logout(dto.refreshToken);
  }
}
