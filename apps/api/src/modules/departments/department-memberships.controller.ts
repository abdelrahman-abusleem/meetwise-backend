import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import { AuthOriginGuard } from '../auth/guards/auth-origin.guard';
import { DepartmentMembershipsService } from './department-memberships.service';
import {
  CreateMembershipDto,
  MembershipGrantDto,
  MembershipPageDto,
} from './membership.dto';
@Controller('departments/:departmentId/members')
@UseGuards(AccessTokenGuard)
export class DepartmentMembershipsController {
  constructor(private readonly memberships: DepartmentMembershipsService) {}
  @Get() list(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('departmentId', ParseUUIDPipe) departmentId: string,
    @Query() page: MembershipPageDto,
  ) {
    return this.memberships.list(actor, departmentId, page);
  }
  @Post()
  @UseGuards(AuthOriginGuard)
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('departmentId', ParseUUIDPipe) departmentId: string,
    @Body() body: CreateMembershipDto,
    @Headers('if-match') match: unknown,
    @Headers('idempotency-key') key: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { userId, ...grant } = body;
    const result = await this.memberships.change(
      actor,
      departmentId,
      userId,
      'CREATE',
      grant,
      match,
      key,
    );
    response.setHeader('ETag', '"' + result.version + '"');
    return result;
  }
  @Patch(':userId')
  @UseGuards(AuthOriginGuard)
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('departmentId', ParseUUIDPipe) departmentId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: MembershipGrantDto,
    @Headers('if-match') match: unknown,
    @Headers('idempotency-key') key: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.memberships.change(
      actor,
      departmentId,
      userId,
      'UPDATE',
      body,
      match,
      key,
    );
    response.setHeader('ETag', '"' + result.version + '"');
    return result;
  }
  @Post(':userId/revoke')
  @HttpCode(200)
  @UseGuards(AuthOriginGuard)
  async revoke(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('departmentId', ParseUUIDPipe) departmentId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: unknown,
    @Headers('if-match') match: unknown,
    @Headers('idempotency-key') key: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (
      body !== undefined &&
      (!body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length)
    )
      throw new BadRequestException('No request parameters accepted');
    const result = await this.memberships.change(
      actor,
      departmentId,
      userId,
      'REVOKE',
      undefined,
      match,
      key,
    );
    response.setHeader('ETag', '"' + result.version + '"');
    return result;
  }
}
