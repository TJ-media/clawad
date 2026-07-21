import { SetMetadata } from '@nestjs/common';
import { AdminRole } from './admin-user.entity';

export const ROLES_KEY = 'clawad:roles';

/**
 * 라우트에 필요한 관리자 역할을 지정한다. SUPERADMIN은 항상 통과한다(가드에서 처리).
 * 지정하지 않으면 인증된 관리자면 누구나(주로 조회) 통과한다.
 */
export const Roles = (...roles: AdminRole[]) => SetMetadata(ROLES_KEY, roles);
