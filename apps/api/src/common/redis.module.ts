import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // 기본 포트(6379) fallback을 두지 않는다 — 같은 머신의 다른 프로젝트 Redis에 붙지 않게 한다.
        const port = config.get<string>('REDIS_PORT');
        if (!port) throw new Error('REDIS_PORT 환경변수가 필요합니다. apps/api/.env.example을 참고하세요.');
        return new Redis({
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: Number(port),
          maxRetriesPerRequest: 2,
        });
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(private readonly moduleRef: ModuleRef) {}

  async onApplicationShutdown(): Promise<void> {
    const client = this.moduleRef.get<Redis>(REDIS_CLIENT, { strict: false });
    await client.quit();
  }
}
