import { Module } from '@nestjs/common';
import { DatabaseModule } from '@meetwise/infrastructure/database';
import { AuthModule } from '../auth/auth.module';
import { DepartmentMembershipsController } from './department-memberships.controller';
import { DepartmentMembershipsService } from './department-memberships.service';
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [DepartmentMembershipsController],
  providers: [DepartmentMembershipsService],
})
export class DepartmentMembershipsModule {}
