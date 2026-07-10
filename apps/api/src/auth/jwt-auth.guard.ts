import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { Repository } from 'typeorm';
import { Machine, MachineStatus } from '../entities/machine.entity';
import { User, UserStatus } from '../entities/user.entity';

export interface AuthenticatedRequest extends Request {
  /** 서버가 확정한 사용자 식별자. 요청 본문의 자가신고 userId를 신뢰하지 않는다 (CLAW-18). */
  userId: string;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Machine) private readonly machines: Repository<Machine>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException({ error: 'MISSING_TOKEN' });
    }

    let userId: string;
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(header.slice(7));
      userId = payload.sub;
    } catch {
      // 토큰 원문을 로그·응답에 남기지 않는다 (privacy-design.md §6.5).
      throw new UnauthorizedException({ error: 'INVALID_TOKEN' });
    }

    const user = await this.users.findOneBy({ id: userId });
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException({ error: 'USER_SUSPENDED' });
    }

    // 차단된 머신에서의 인증은 403 (CLAW-22 [예외]).
    // machineId 헤더는 선택이다. 없으면 계정 단위 요청으로 본다.
    const machineId = req.headers['x-clawad-machine-id'];
    if (typeof machineId === 'string' && machineId.length) {
      const machine = await this.machines.findOneBy({ userId, machineId });
      if (machine?.status === MachineStatus.BLOCKED) {
        throw new ForbiddenException({ error: 'MACHINE_BLOCKED', reason: machine.blockedReason });
      }
    }

    req.userId = userId;
    return true;
  }
}
