import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { AuthService, TokenPair } from './auth.service';
import { clearRefreshCookie, readRefreshCookie, refreshCookieOptions, setRefreshCookie } from './cookies';
import { RefreshDto } from './dto';

/**
 * 세션 토큰 회전·폐기. 공개 사용자 로그인·가입은 소셜 전용이며 SocialAuthController가 담당한다(CLAW-37).
 * 웹은 refresh 토큰을 httpOnly 쿠키로, CLI는 응답 본문으로 다룬다(CLAW-38).
 */
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenPair | { accessToken: string; expiresIn: string }> {
    // 쿠키가 있으면 웹 세션으로 보고 쿠키를 우선한다. 없으면 본문 토큰(CLI).
    const cookieToken = readRefreshCookie(req);
    const token = cookieToken ?? dto.refreshToken;
    if (!token) throw new UnauthorizedException({ error: 'INVALID_REFRESH_TOKEN' });

    const pair = await this.auth.refresh(token);
    if (cookieToken) {
      // 회전된 refresh는 쿠키로만 내려주고 본문에는 담지 않는다.
      setRefreshCookie(res, pair.refreshToken, refreshCookieOptions(this.config));
      return { accessToken: pair.accessToken, expiresIn: pair.expiresIn };
    }
    return pair;
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const cookieToken = readRefreshCookie(req);
    const token = cookieToken ?? dto.refreshToken;
    if (token) await this.auth.logout(token);
    if (cookieToken) clearRefreshCookie(res, refreshCookieOptions(this.config));
  }
}
