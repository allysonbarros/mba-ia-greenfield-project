import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class UploadedPartDto {
  /** 1-based part number, matching the presigned UploadPart URL. */
  @IsInt()
  @Min(1)
  @Max(10000)
  part_number: number;

  /** ETag returned by the storage on the part PUT. */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  /** Parts collected by the client from each UploadPart response. */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => UploadedPartDto)
  parts: UploadedPartDto[];
}
