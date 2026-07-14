import { Controller, Get, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import { ClickService } from './click.service';

/** 브라우저가 여는 공개 클릭 URL. 인증 토큰·serveToken을 URL로 받지 않는다. */
@Controller('v1/click')
export class ClickController {
  constructor(private readonly clicks: ClickService) {}

  @Get(':token')
  async follow(@Param('token') token: string, @Res() res: Response): Promise<void> {
    const landingUrl = await this.clicks.consume(token);
    res.redirect(302, landingUrl);
  }
}
