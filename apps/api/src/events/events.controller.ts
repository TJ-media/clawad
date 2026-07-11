import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { EventsResult, EventsService, FactEvent } from './events.service';

const MAX_BATCH = 200;

/**
 * 노출 이벤트 수집 (CLAW-6). 클라이언트는 사실만 보낸다.
 * userId는 인증 세션에서 서버가 확정한다 — 본문에 userId를 받지 않는다 (CLAW-18).
 * 금액 필드(gross/userShare/rewardAmount 등)는 실려와도 무시한다.
 */
@Controller('v1/events')
@UseGuards(JwtAuthGuard)
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async collect(@Req() req: AuthenticatedRequest, @Body() body: unknown): Promise<EventsResult> {
    if (!Array.isArray(body)) throw new BadRequestException({ error: 'ARRAY_BODY_REQUIRED' });
    if (body.length === 0) return { received: 0, accepted: 0, rejected: {} };
    if (body.length > MAX_BATCH) throw new BadRequestException({ error: 'BATCH_TOO_LARGE', max: MAX_BATCH });

    // 사실 필드만 뽑는다. 클라이언트가 실은 금액 필드는 여기서 버려진다.
    const events: FactEvent[] = body.map((e) => ({
      serveToken: e?.serveToken,
      sequence: e?.sequence,
      machineId: e?.machineId,
      startedAt: e?.startedAt,
      endedAt: e?.endedAt,
      clientVersion: e?.clientVersion,
    }));

    return this.events.process(req.userId, events);
  }
}
