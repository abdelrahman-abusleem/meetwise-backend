export * from './database.module';
export * from './prisma.service';

export {
  Prisma,
  SystemRole,
  LicenseEdition,
  LicenseStatus,
  DepartmentKind,
  DepartmentStatus,
  DepartmentRole,
} from '../../../../generated/prisma/client';
