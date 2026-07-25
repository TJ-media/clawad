import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { assertPolicyLoadable } from './common/policy';
import { validateProductionEnv } from './config/production-env';

async function bootstrap(): Promise<void> {
  validateProductionEnv(process.env);
  // 정책 파일이 없거나 불변식을 위반하면 여기서 부팅을 멈춘다. 운영 여부와 무관하게 검사한다
  // — 잘못된 정책으로 뜬 서버는 헬스체크만 통과하고 광고·리워드 요청을 전부 실패시킨다.
  const policyVersion = assertPolicyLoadable();
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // 허용목록 외 필드는 조용히 제거한다 (privacy-design.md §1)
      forbidNonWhitelisted: true, // 모르는 필드를 보내면 400
      transform: true,
    }),
  );

  // 사용자 샵 웹(user-web) 등 브라우저 클라이언트를 위한 CORS (CLAW-36).
  // Bearer 토큰 인증이라 쿠키 자격증명을 쓰지 않으므로 origin 반영으로 충분하다.
  // 운영은 CORS_ORIGINS(쉼표 구분)로 화이트리스트를 좁힌다.
  const corsOrigins = (process.env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    // refresh 쿠키(CLAW-38)를 주고받으려면 credentials가 필요하다.
    // 임의 origin 반사(origin:true)와 credentials를 동시에 켜지 않는다 — 명시 allowlist가 있을 때만 허용.
    credentials: corsOrigins.length > 0,
    methods: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-clawad-machine-id',
      'x-clawad-campaign-ids',
      'x-clawad-admin-token',
    ],
  });

  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`clawad api listening on ${port} (policy v${policyVersion})`);
}

void bootstrap().catch((error: unknown) => {
  // 기동 단계 실패(환경변수·정책 검증 포함)는 조용히 넘기지 않고 종료 코드로 드러낸다.
  console.error('[bootstrap] 기동 실패:', error instanceof Error ? error.message : error);
  process.exit(1);
});
