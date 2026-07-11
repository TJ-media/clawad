import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

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
    methods: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-clawad-machine-id', 'x-clawad-admin-token'],
  });

  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

void bootstrap();
