import { plainToInstance, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Max,
  Min,
  validateSync,
} from 'class-validator';

export enum NodeEnvironment {
  DEVELOPMENT = 'development',
  TEST = 'test',
  PRODUCTION = 'production',
}

class EnvironmentVariables {
  @IsEnum(NodeEnvironment)
  NODE_ENV: NodeEnvironment = NodeEnvironment.DEVELOPMENT;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 3000;

  @IsString()
  @IsNotEmpty()
  APP_NAME = 'meetwise';

  @IsString()
  @IsNotEmpty()
  @Matches(/^postgresql?:\/\//, {
    message: 'DATABASE_URL must start with postgresql:// or postgres://',
  })
  DATABASE_URL!: string;

  @IsString()
  @IsNotEmpty()
  REDIS_HOST = 'localhost';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  REDIS_PORT = 6379;
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

  return validatedConfiguration;
}
