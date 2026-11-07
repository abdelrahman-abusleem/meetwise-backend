import { plainToInstance, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnvironment {
  DEVELOPMENT = 'development',
  TEST = 'test',
  PRODUCTION = 'production',
}

export class EnvironmentVariables {
  @IsEnum(NodeEnvironment)
  NODE_ENV: NodeEnvironment = NodeEnvironment.DEVELOPMENT;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65_535)
  PORT = 3000;

  @IsString()
  @IsNotEmpty()
  APP_NAME = 'meetwise';

  @IsString()
  @IsNotEmpty()
  @Matches(/^postgres(?:ql)?:\/\//, {
    message: 'DATABASE_URL must start with postgresql:// or postgres://',
  })
  DATABASE_URL!: string;

  @IsString()
  @IsNotEmpty()
  REDIS_HOST = 'localhost';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65_535)
  REDIS_PORT = 6379;

  @IsString()
  @IsNotEmpty()
  @MinLength(32)
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(32)
  JWT_REFRESH_SECRET!: string;

  @Type(() => Number)
  @IsInt()
  @Min(60)
  JWT_ACCESS_TTL_SECONDS = 900;

  @Type(() => Number)
  @IsInt()
  @Min(60)
  JWT_REFRESH_TTL_SECONDS = 604_800;

  @IsString()
  @IsNotEmpty()
  @MinLength(32)
  PASSWORD_RESET_SECRET!: string;

  @Type(() => Number)
  @IsInt()
  @Min(300)
  PASSWORD_RESET_TTL_SECONDS!: number;
  @IsString()
  @IsNotEmpty()
  SMTP_HOST!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65_535)
  SMTP_PORT = 587;

  @IsString()
  @IsIn(['true', 'false'])
  SMTP_SECURE = 'false';

  @IsString()
  @IsNotEmpty()
  SMTP_FROM!: string;

  @IsOptional()
  @IsString()
  SMTP_USER?: string;

  @IsOptional()
  @IsString()
  SMTP_PASSWORD?: string;

  @IsString()
  @IsNotEmpty()
  WEB_APP_URL!: string;
}

export function validateEnvironment(
  configuration: Record<string, unknown>,
): EnvironmentVariables {
  const validatedConfiguration = plainToInstance(
    EnvironmentVariables,
    configuration,
    {
      enableImplicitConversion: true,
    },
  );

  const errors = validateSync(validatedConfiguration, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(errors.toString());
  }

  if (
    validatedConfiguration.JWT_ACCESS_SECRET ===
    validatedConfiguration.JWT_REFRESH_SECRET
  ) {
    throw new Error(
      'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different',
    );
  }

  if (
    validatedConfiguration.JWT_REFRESH_TTL_SECONDS <=
    validatedConfiguration.JWT_ACCESS_TTL_SECONDS
  ) {
    throw new Error(
      'JWT_REFRESH_TTL_SECONDS must be greater than JWT_ACCESS_TTL_SECONDS',
    );
  }

  if (
    validatedConfiguration.PASSWORD_RESET_SECRET ===
      validatedConfiguration.JWT_ACCESS_SECRET ||
    validatedConfiguration.PASSWORD_RESET_SECRET ===
      validatedConfiguration.JWT_REFRESH_SECRET
  ) {
    throw new Error('PASSWORD_RESET_SECRET must be different from JWT secrets');
  }

  const smtpUserConfigured = Boolean(validatedConfiguration.SMTP_USER);

  const smtpPasswordConfigured = Boolean(validatedConfiguration.SMTP_PASSWORD);

  if (smtpUserConfigured !== smtpPasswordConfigured) {
    throw new Error('SMTP_USER and SMTP_PASSWORD must be configured together');
  }

  return validatedConfiguration;
}
