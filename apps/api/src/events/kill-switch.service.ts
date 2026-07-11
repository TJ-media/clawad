import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KillSwitch, KillSwitchTarget } from '../entities/kill-switch.entity';

@Injectable()
export class KillSwitchService {
  constructor(@InjectRepository(KillSwitch) private readonly repo: Repository<KillSwitch>) {}

  /** 대상이 현재 킬스위치에 걸려 있는가. 수집 파이프라인이 시작 전에 조회한다. */
  async isKilled(target: KillSwitchTarget, targetId: string): Promise<boolean> {
    const count = await this.repo.count({ where: { target, targetId, active: true } });
    return count > 0;
  }

  async enable(target: KillSwitchTarget, targetId: string, reason?: string): Promise<KillSwitch> {
    if (!targetId) throw new BadRequestException({ error: 'TARGET_ID_REQUIRED' });
    // 이미 켜져 있으면 그대로 둔다(멱등).
    const existing = await this.repo.findOne({ where: { target, targetId, active: true } });
    if (existing) return existing;
    return this.repo.save(this.repo.create({ target, targetId, active: true, reason: reason ?? null }));
  }

  async disable(target: KillSwitchTarget, targetId: string): Promise<{ disabled: number }> {
    // 행을 지우지 않고 active=false로 전이해 이력을 남긴다.
    const rows = await this.repo.find({ where: { target, targetId, active: true } });
    for (const row of rows) {
      row.active = false;
      await this.repo.save(row);
    }
    return { disabled: rows.length };
  }
}
