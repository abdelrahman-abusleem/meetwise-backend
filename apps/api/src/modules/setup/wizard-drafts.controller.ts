import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import { AuthOriginGuard } from '../auth/guards/auth-origin.guard';
import {
  CreateWizardDraftDto,
  UpdateWizardDraftDto,
} from './wizard-config.dto';
import { WizardDraftsService } from './wizard-drafts.service';
@Controller('onboarding/draft')
@UseGuards(AccessTokenGuard)
export class WizardDraftsController {
  constructor(private readonly drafts: WizardDraftsService) {}
  @Post()
  @UseGuards(AuthOriginGuard)
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: CreateWizardDraftDto,
    @Headers('idempotency-key') key: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.drafts.create(actor, body.config, key);
    this.headers(response, result.version);
    return result;
  }
  @Get(':draftId')
  async get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('draftId', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.drafts.get(actor, id);
    this.headers(response, result.version);
    return result;
  }
  @Patch()
  @UseGuards(AuthOriginGuard)
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: UpdateWizardDraftDto,
    @Headers('if-match') match: unknown,
    @Headers('idempotency-key') key: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.drafts.update(
      actor,
      body.draftId,
      body.config,
      match,
      key,
    );
    this.headers(response, result.version);
    return result;
  }
  private headers(response: Response, version: number) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('ETag', '"' + version + '"');
  }
}
