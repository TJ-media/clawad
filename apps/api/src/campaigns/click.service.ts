import { ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { loadPolicy } from '../common/policy';
import { ClickEvent } from '../entities/click-event.entity';
import { Consent, ConsentType } from '../entities/consent.entity';
import { KillSwitchService } from '../events/kill-switch.service';

interface ClickClaims {
  campaignId: string;
  creativeId: string;
  userId: string;
  machineId: string;
  landingUrl: string;
}

interface ClickPayload extends ClickClaims {
  jti: string;
  issuedAt: number;
  expiresAt: number;
}

interface ClickTokenLib {
  issueClickToken(claims: ClickClaims, secret: string, ttlMs: number, now?: number): string;
  verifyClickToken(token: string, secret: string, now?: number): { ok: true; payload: ClickPayload } | { ok: false; reason: string };
}

const require_ = createRequire(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const clickTokenLib: ClickTokenLib = require_(join(REPO_ROOT, 'server', 'lib', 'clickToken.js'));

@Injectable()
export class ClickService {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    private readonly killSwitch: KillSwitchService,
  ) {}

  private secret(): string {
    const secret = this.config.get<string>('CLICK_TOKEN_SECRET');
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
      throw new ServiceUnavailableException({ error: 'CLICK_TOKEN_SECRET_NOT_CONFIGURED' });
    }
    return secret;
  }

  issue(claims: ClickClaims): string {
    return clickTokenLib.issueClickToken(claims, this.secret(), loadPolicy().click.tokenTtlMs);
  }

  async consume(token: string): Promise<string> {
    const verified = clickTokenLib.verifyClickToken(token, this.secret());
    if (!verified.ok) {
      throw new ConflictException({ error: verified.reason === 'EXPIRED' ? 'CLICK_LINK_EXPIRED' : 'INVALID_CLICK_LINK' });
    }
    const payload = verified.payload;
    return this.killSwitch.withAdsShared(async (manager) => {
      if (await this.killSwitch.isAdsKilled(manager, payload.userId, payload.machineId, payload.campaignId)) {
        throw new ConflictException({ error: 'CLICK_DISABLED' });
      }
      // 클릭 정보 수집은 CLICK_TRACKING **별도 동의**가 있을 때만 한다 (규칙 §6, 처리방침 v3 §1.4,
      // privacy-design.md §1.4). 동의 전에는 기록을 남기지 않고 리다이렉트만 수행해, 공개 처리방침이
      // 공표한 "클릭 정보를 수집하지 않는다"를 코드가 실제로 지키게 한다 (CLAW-174).
      const consent = await manager.findOne(Consent, {
        where: { userId: payload.userId, type: ConsentType.CLICK_TRACKING },
        order: { recordedAt: 'DESC' },
      });
      if (!consent?.granted) {
        return payload.landingUrl;
      }
      try {
        await manager.insert(ClickEvent, {
          clickJti: payload.jti,
          campaignId: payload.campaignId,
          creativeId: payload.creativeId,
          userId: payload.userId,
          machineId: payload.machineId,
          sequence: null,
          clientVersion: null,
        });
      } catch (error: unknown) {
        if (typeof error === 'object' && error && 'code' in error && error.code === '23505') {
          throw new ConflictException({ error: 'CLICK_ALREADY_RECORDED' });
        }
        throw error;
      }
      return payload.landingUrl;
    });
  }
}
