import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Response } from 'express';
import { Repository } from 'typeorm';
import { User, UserStatus } from '../entities/user.entity';
import { AuthenticatedRequest, JwtAuthGuard } from './jwt-auth.guard';
import { SocialExchangeDto, SocialStartDto } from './dto';
import { SocialAuthService } from './social-auth.service';

/**
 * Google·Kakao·Naver 소셜 전용 인증 (CLAW-37).
 * provider token/secret/subject·내부 토큰을 URL·응답·로그에 남기지 않는다.
 */
@Controller('v1/auth/social')
export class SocialAuthController {
  constructor(
    private readonly social: SocialAuthService,
    private readonly jwt: JwtService,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  /** LINK intent에서만 Bearer로 기존 세션 사용자를 확정한다. LOGIN은 인증이 필요 없다. */
  private async resolveLinkUser(authorization?: string): Promise<string> {
    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException({ error: 'LINK_REQUIRES_AUTH' });
    }
    let userId: string;
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(authorization.slice(7));
      userId = payload.sub;
    } catch {
      throw new UnauthorizedException({ error: 'INVALID_TOKEN' });
    }
    const user = await this.users.findOneBy({ id: userId });
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException({ error: 'USER_SUSPENDED' });
    }
    return userId;
  }

  @Post(':provider/start')
  @HttpCode(HttpStatus.OK)
  async start(
    @Param('provider') provider: string,
    @Body() dto: SocialStartDto,
    @Headers('authorization') authorization?: string,
  ): Promise<{ authorizationUrl: string }> {
    const linkUserId = dto.intent === 'LINK' ? await this.resolveLinkUser(authorization) : undefined;
    return this.social.start(provider, dto.intent, dto.returnTarget, linkUserId);
  }

  @Get(':provider/callback')
  async callback(
    @Param('provider') provider: string,
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ): Promise<void> {
    // state가 무효면 서비스가 예외를 던지고 예외 필터가 JSON 4xx를 응답한다(open redirect 방지).
    const { redirectUrl } = await this.social.handleCallback(provider, code, state, error);
    res.redirect(HttpStatus.FOUND, redirectUrl);
  }

  @Post('exchange')
  @HttpCode(HttpStatus.OK)
  async exchange(@Body() dto: SocialExchangeDto): Promise<Record<string, unknown>> {
    const result = await this.social.exchange(dto.handoffCode, dto.consents);
    switch (result.kind) {
      case 'SESSION':
        return { ...result.tokens };
      case 'LINKED':
        return { linked: true, provider: result.provider };
      case 'SIGNUP_REQUIRED':
        return { signupRequired: true, provider: result.provider };
    }
  }
}

/** 내 계정의 로그인 수단 관리. 재인증된 세션(Bearer)에서만 연결을 해제한다. */
@Controller('v1/me/identities')
@UseGuards(JwtAuthGuard)
export class MeIdentitiesController {
  constructor(private readonly social: SocialAuthService) {}

  @Delete(':provider')
  @HttpCode(HttpStatus.OK)
  async unlink(
    @Req() req: AuthenticatedRequest,
    @Param('provider') provider: string,
  ): Promise<{ removed: boolean; provider: string }> {
    return this.social.unlinkIdentity(req.userId, provider);
  }
}
