import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { SystemRole } from '@meetwise/infrastructure/database';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireSystemRoles } from '../auth/decorators/system-roles.decorator';
import { SystemRolesGuard } from '../auth/guards/system-roles.guard';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import { AuthOriginGuard } from '../auth/guards/auth-origin.guard';
import { ActivateWizardDto } from './wizard-activation.dto';
import { WizardActivationService } from './wizard-activation.service';
@Controller('onboarding')
@UseGuards(AccessTokenGuard, SystemRolesGuard)
@RequireSystemRoles(SystemRole.OWNER, SystemRole.MANAGER)
export class WizardActivationController {
  constructor(private readonly wizard: WizardActivationService) {}
  @Get() state(
    @CurrentUser() actor: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.wizard.state(actor);
  }
  @Post('activate')
  @HttpCode(200)
  @UseGuards(AuthOriginGuard)
  activate(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: ActivateWizardDto,
    @Headers('if-match') match: unknown,
    @Headers('idempotency-key') key: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.wizard.activate(actor, body.draftId, match, key);
  }
}
