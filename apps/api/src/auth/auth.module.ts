import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtSignOptions } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Consent } from '../entities/consent.entity';
import { Identity } from '../entities/identity.entity';
import { Machine } from '../entities/machine.entity';
import { User } from '../entities/user.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Identity, Consent, Machine]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('AUTH_JWT_SECRET');
        // 공개 fallback을 두지 않는다 (CLAW-18 §서명 키).
        if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
          throw new Error('AUTH_JWT_SECRET이 없거나 32바이트 미만입니다. 기본값 fallback을 두지 않습니다.');
        }
        // ACCESS_TOKEN_TTL은 '15m' 같은 ms 문자열이다. jsonwebtoken의 리터럴 유니온으로 좁혀준다.
        const expiresIn = config.get<string>('ACCESS_TOKEN_TTL', '15m') as JwtSignOptions['expiresIn'];
        return { secret, signOptions: { expiresIn } };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  exports: [AuthService, JwtAuthGuard, JwtModule],
})
export class AuthModule {}
