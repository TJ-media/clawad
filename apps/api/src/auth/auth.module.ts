import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtSignOptions } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Consent } from '../entities/consent.entity';
import { Identity, IdentityProvider } from '../entities/identity.entity';
import { Machine } from '../entities/machine.entity';
import { User } from '../entities/user.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { MeIdentitiesController, SocialAuthController } from './social-auth.controller';
import { SocialAuthService } from './social-auth.service';
import { GoogleProvider } from './social/google.provider';
import { KakaoProvider } from './social/kakao.provider';
import { NaverProvider } from './social/naver.provider';
import { SocialProvider } from './social/provider.interface';
import { SocialConfig } from './social/social.config';
import { SocialProviderRegistry } from './social/social-provider.registry';

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
  controllers: [AuthController, SocialAuthController, MeIdentitiesController],
  providers: [
    AuthService,
    JwtAuthGuard,
    SocialConfig,
    SocialAuthService,
    {
      // 활성 공급자만 어댑터로 등록한다(client id/secret이 모두 설정된 경우). 미설정 환경도 부팅된다.
      provide: SocialProviderRegistry,
      inject: [SocialConfig],
      useFactory: (config: SocialConfig) => {
        const providers: SocialProvider[] = [];
        const google = config.credentials(IdentityProvider.GOOGLE);
        if (google) providers.push(new GoogleProvider(google));
        const kakao = config.credentials(IdentityProvider.KAKAO);
        if (kakao) providers.push(new KakaoProvider(kakao));
        const naver = config.credentials(IdentityProvider.NAVER);
        if (naver) providers.push(new NaverProvider(naver));
        return new SocialProviderRegistry(providers);
      },
    },
  ],
  exports: [AuthService, JwtAuthGuard, JwtModule],
})
export class AuthModule {}
