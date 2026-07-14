import { Matches } from 'class-validator';
import { PUBLIC_ID_PATTERN } from '../videos.constants';

export class PublicIdParamDto {
  @Matches(PUBLIC_ID_PATTERN, {
    message: 'publicId must be 11 characters of [A-Za-z0-9_-]',
  })
  publicId: string;
}
