import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import {
  CompleteUploadResult,
  InitiateUploadResult,
  VideosService,
} from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Pre-registers the video as a draft, opens a multipart upload in object ' +
      'storage and returns presigned URLs for each part. No video bytes pass ' +
      'through the API.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload initiated',
    schema: {
      properties: {
        public_id: { type: 'string', example: 'dQw4w9WgXcQ' },
        status: { type: 'string', example: 'draft' },
        upload: {
          type: 'object',
          properties: {
            part_size: { type: 'number' },
            part_count: { type: 'number' },
            urls: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  part_number: { type: 'number' },
                  url: { type: 'string' },
                },
              },
            },
            expires_at: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation error, VIDEO_FILE_TOO_LARGE or VIDEO_INVALID_CONTENT_TYPE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiate(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':publicId/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'publicId', description: 'Public identifier of the video' })
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Closes the multipart upload, verifies the object, transitions the video ' +
      'to processing and enqueues the processing job. Idempotent on repeat.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed; video transitioning to processing',
    schema: {
      properties: {
        public_id: { type: 'string', example: 'dQw4w9WgXcQ' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'VIDEO_UPLOAD_INCOMPLETE, VIDEO_UPLOAD_SIZE_MISMATCH or validation error',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND (unknown video or not owned by the caller)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_UPLOAD_NOT_COMPLETABLE (video in failed status)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    return this.videosService.completeUpload(user.sub, publicId, dto);
  }
}
