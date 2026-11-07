import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SystemRole } from '@meetwise/infrastructure/database';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../auth.types';
import { RequireSystemRoles } from '../decorators/system-roles.decorator';
import { SystemRolesGuard } from './system-roles.guard';

@RequireSystemRoles(SystemRole.OWNER)
class ScopedController {
  read(this: void) {
    return 'config';
  }
  @RequireSystemRoles(SystemRole.OWNER, SystemRole.MANAGER)
  delegated(this: void) {
    return 'delegated config';
  }
}
class UnscopedController {
  read(this: void) {
    return 'unscoped';
  }
}

describe('SystemRolesGuard deny-by-default contract', () => {
  const guard = new SystemRolesGuard(new Reflector());
  const actor = (role: SystemRole): AuthenticatedUser => ({
    id: randomUUID(),
    email: 'synthetic@example.invalid',
    familyId: randomUUID(),
    tokenVersion: 0,
    role,
  });
  const context = (
    user: AuthenticatedUser | undefined,
    controller:
      typeof ScopedController | typeof UnscopedController = ScopedController,
    handler: () => string = controller.prototype.read,
  ) =>
    ({
      getClass: () => controller,
      getHandler: () => handler,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  it('requires an authenticated actor', () => {
    expect(() => guard.canActivate(context(undefined))).toThrow(
      UnauthorizedException,
    );
  });
  it('denies missing role metadata even to OWNER', () => {
    expect(() =>
      guard.canActivate(context(actor(SystemRole.OWNER), UnscopedController)),
    ).toThrow(ForbiddenException);
  });
  it('allows the explicitly required OWNER role', () => {
    expect(guard.canActivate(context(actor(SystemRole.OWNER)))).toBe(true);
  });
  it('denies nonmatching MEMBER and MANAGER roles', () => {
    for (const role of [SystemRole.MEMBER, SystemRole.MANAGER])
      expect(() => guard.canActivate(context(actor(role)))).toThrow(
        ForbiddenException,
      );
  });
  it('uses explicit method metadata to allow delegated MANAGER access', () => {
    expect(
      guard.canActivate(
        context(
          actor(SystemRole.MANAGER),
          ScopedController,
          ScopedController.prototype.delegated,
        ),
      ),
    ).toBe(true);
    expect(() =>
      guard.canActivate(
        context(
          actor(SystemRole.MEMBER),
          ScopedController,
          ScopedController.prototype.delegated,
        ),
      ),
    ).toThrow(ForbiddenException);
  });
});
