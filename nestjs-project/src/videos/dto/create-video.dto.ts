import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateVideoDto {
  /** Video title shown to viewers. */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title: string;

  /** Optional longer description. */
  @IsOptional()
  @IsString()
  description?: string;

  /** Original filename; its extension drives the storage key suffix. */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Matches(/\.[^./\\]+$/, {
    message: 'file_name must include a file extension',
  })
  file_name: string;

  /** Declared size in bytes; verified against the real object at complete. */
  @IsInt()
  @Min(1)
  file_size: number;

  /** MIME type; must be a video/* type (enforced as a domain rule). */
  @IsString()
  content_type: string;
}
