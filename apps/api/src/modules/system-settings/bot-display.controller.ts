import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Patch,
  Res,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { SystemRole } from '@meetwise/infrastructure/database';
import type { Response } from 'express';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import { AuthOriginGuard } from '../auth/guards/auth-origin.guard';
import { SystemRolesGuard } from '../auth/guards/system-roles.guard';
import { RequireSystemRoles } from '../auth/decorators/system-roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { BotDisplayService } from './bot-display.service';
import { UpdateBotDisplayDto } from './dto/update-bot-display.dto';

@Controller('settings/bot')
@UseGuards(AccessTokenGuard, SystemRolesGuard)
@RequireSystemRoles(SystemRole.OWNER, SystemRole.MANAGER)
export class BotDisplayController {
  constructor(private readonly display: BotDisplayService) {}
  @Get()
  async read(@Res({ passthrough: true }) res: Response) {
    const value = await this.display.read();
    this.headers(res, value.version);
    return value;
  }
  @Patch()
  @UseGuards(AuthOriginGuard)
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() input: UpdateBotDisplayDto,
    @Headers('if-match') header: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (header === undefined)
      throw new HttpException('If-Match is required', 428);
    if (typeof header !== 'string' || !/^"(0|[1-9]\d*)"$/.test(header))
      throw new BadRequestException('Invalid If-Match');
    const version = Number(header.slice(1, -1));
    if (!Number.isSafeInteger(version) || version > 2147483646)
      throw new BadRequestException('Invalid If-Match');
    const value = await this.display.update(actor, input.displayName, version);
    this.headers(res, value.version);
    return value;
  }
  private headers(res: Response, version: number) {
    res.setHeader('ETag', '"' + version + '"');
    res.setHeader('Cache-Control', 'no-store');
  }
}
