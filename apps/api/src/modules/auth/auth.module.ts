import { AccountProvisioningController } from './account-provisioning.controller';
import { AccountActivationController } from './account-activation.controller';
import { AccountProvisioningService } from './account-provisioning.service';
import { AdministrativeResetController } from './administrative-reset.controller';
import { AdministrativeResetService } from './administrative-reset.service';
import { TemporaryPasswordController } from './temporary-password.controller';
import { SystemRolesGuard } from './guards/system-roles.guard';
import { ActorAuthorityService } from './services/actor-authority.service';
import { SessionFamilyService } from './services/session-family.service';
import { AuthOriginGuard } from './guards/auth-origin.guard';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { DatabaseModule } from '@meetwise/infrastructure/database';

import { AuthTokenService } from './services/auth-token.service';
import { PasswordHasherService } from './services/password-hasher.service';
import { RefreshTokenHasherService } from './services/refresh-token-hasher.service';
import { AuthService } from './auth.service';
import { CookieService } from './services/cookie.service';
import { AuthController } from './auth.controller';
import { RedisModule } from '@meetwise/infrastructure/redis';

import { AuthSessionService } from './services/auth-session.service';
import { AccessTokenGuard } from './guards/access-token.guard';
import { QueueModule } from '@meetwise/infrastructure/queue';
import { SecurityModule } from '@meetwise/security';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    RedisModule,
    QueueModule,
    SecurityModule,
    JwtModule.register({}),
  ],
  controllers: [
    AccountProvisioningController,
    AccountActivationController,
    AuthController,
    AdministrativeResetController,
    TemporaryPasswordController,
  ],
  providers: [
    AccountProvisioningService,
    AdministrativeResetService,
    ActorAuthorityService,
    SystemRolesGuard,
    SessionFamilyService,
    AuthOriginGuard,
    PasswordHasherService,
    RefreshTokenHasherService,
    AuthTokenService,
    AuthSessionService,
    CookieService,
    AuthService,
    AccessTokenGuard,
  ],
  exports: [
    ActorAuthorityService,
    AuthOriginGuard,
    SystemRolesGuard,
    SessionFamilyService,
    PasswordHasherService,
    RefreshTokenHasherService,
    AuthTokenService,
    AuthSessionService,
    CookieService,
    AuthService,
    AccessTokenGuard,
  ],
})
export class AuthModule {}
