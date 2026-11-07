import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

const DEFAULT_TIMEZONE = 'UTC';
const DEFAULT_LANGUAGE = 'en';
const DEFAULT_BOT_NAME = 'Meetwise Bot';

interface NormalizeOptions {
  defaultValue?: string;
  lowercase?: boolean;
  emptyToUndefined?: boolean;
}

const normalizeString = (
  value: unknown,
  options: NormalizeOptions = {},
): unknown => {
  if (value === undefined) {
    return options.defaultValue;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const trimmedValue = value.trim();

  if (options.emptyToUndefined && !trimmedValue) {
    return undefined;
  }

  const normalizedValue = options.lowercase
    ? trimmedValue.toLowerCase()
    : trimmedValue;

  return normalizedValue || options.defaultValue;
};

export class CompleteSetupDto {
  @Transform(({ value }: { value: unknown }) => normalizeString(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  companyName!: string;

  @Transform(({ value }: { value: unknown }) =>
    normalizeString(value, {
      emptyToUndefined: true,
    }),
  )
  @IsOptional()
  @IsString()
  @MaxLength(500)
  companyLogoUrl?: string;

  @Transform(({ value }: { value: unknown }) =>
    normalizeString(value, {
      defaultValue: DEFAULT_TIMEZONE,
    }),
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  timezone = DEFAULT_TIMEZONE;

  @Transform(({ value }: { value: unknown }) =>
    normalizeString(value, {
      defaultValue: DEFAULT_LANGUAGE,
      lowercase: true,
    }),
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  defaultLanguage = DEFAULT_LANGUAGE;

  @Transform(({ value }: { value: unknown }) =>
    normalizeString(value, {
      defaultValue: DEFAULT_BOT_NAME,
    }),
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  defaultBotName = DEFAULT_BOT_NAME;

  @Transform(({ value }: { value: unknown }) => normalizeString(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  ownerName!: string;

  @Transform(({ value }: { value: unknown }) =>
    normalizeString(value, {
      lowercase: true,
    }),
  )
  @IsEmail()
  @MaxLength(254)
  ownerEmail!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  ownerPassword!: string;
}
