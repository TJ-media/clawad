import { ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { loadPolicy } from '../common/policy';
import { ClickEvent } from '../entities/click-event.entity';
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
