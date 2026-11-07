import type { Prisma } from '@meetwise/infrastructure/database';

export const authContextUserSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  passwordHash: true,
  mustChangePassword: true,
  isActive: true,
  tokenVersion: true,
} satisfies Prisma.UserSelect;

export const publicAuthUserSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

export const refreshAuthUserSelect = {
  ...publicAuthUserSelect,
  tokenVersion: true,
  refreshTokenHash: true,
  mustChangePassword: true,
} satisfies Prisma.UserSelect;

export type AuthContextUser = Prisma.UserGetPayload<{
  select: typeof authContextUserSelect;
}>;

export type PublicAuthUser = Prisma.UserGetPayload<{
  select: typeof publicAuthUserSelect;
}>;

export type RefreshAuthUser = Prisma.UserGetPayload<{
  select: typeof refreshAuthUserSelect;
}>;

export function toPublicAuthUser(
  user: PublicAuthUser | RefreshAuthUser,
): PublicAuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}
