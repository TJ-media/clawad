import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Observable } from 'rxjs';
import { Repository } from 'typeorm';
import { AuditLog } from './audit-log.entity';
import { AdminRequest } from './admin.guard';
import { sanitizeOperationalValue } from '../common/sanitize';

export function maskParams(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  return JSON.stringify(sanitizeOperationalValue(body)).slice(0, 4000);
}

/**
 * 감사 인터셉터 (CLAW-27). 변경 조작(POST/PUT/PATCH/DELETE)을 실행 **전에** 기록한다.
 * 기록에 실패하면 조작을 차단한다(이슈 예외 조항: 감사로그 기록 실패 시 조작 차단).
 * 조회(GET)는 감사하지 않는다.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(@InjectRepository(AuditLog) private readonly audit: Repository<AuditLog>) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    const method = req.method.toUpperCase();

    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return next.handle();
    }

    // 라우트 경로(파라미터 원형)로 액션을 기록한다. 실제 값은 targetId·params에.
    const routePath = (req.route?.path as string) || req.path;
    const targetId = (req.params?.id as string) || null;

    try {
      await this.audit.save(
        this.audit.create({
          actorAdminId: req.admin?.id ?? null,
          actorRole: req.admin?.role ?? null,
          action: `${method} ${routePath}`.slice(0, 200),
          targetId: targetId ? String(targetId).slice(0, 128) : null,
          params: maskParams(req.body),
        }),
      );
    } catch {
      // 감사 기록 실패 → 조작 차단. 핸들러를 실행하지 않는다.
      throw new ServiceUnavailableException({ error: 'AUDIT_LOG_FAILED' });
    }

    return next.handle();
  }
}
