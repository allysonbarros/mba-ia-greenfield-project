import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
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
import { Public } from '../auth/decorators/public.decorator';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { PublicIdParamDto } from './dto/public-id-param.dto';
import {
  CompleteUploadResult,
  InitiateUploadResult,
  VideoDetailResult,
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

  @Get(':publicId')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'publicId', description: 'Public identifier of the video' })
  @ApiOperation({
    summary: 'Get a video by its public id',
    description:
      'Returns the video metadata and status. `ready` videos are visible to ' +
      'anyone; non-`ready` videos are visible only to their owner (a valid ' +
      'optional bearer token enables the owner view). No existence leak.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video metadata',
    schema: {
      properties: {
        public_id: { type: 'string', example: 'dQw4w9WgXcQ' },
        title: { type: 'string' },
        description: { type: 'string', nullable: true },
        status: { type: 'string', example: 'ready' },
        duration_seconds: { type: 'number', nullable: true },
        width: { type: 'number', nullable: true },
        height: { type: 'number', nullable: true },
        thumbnail_url: { type: 'string', nullable: true },
        created_at: { type: 'string', format: 'date-time' },
        channel: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            nickname: { type: 'string' },
          },
        },
        error_code: { type: 'string', nullable: true },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'publicId does not match the [A-Za-z0-9_-]{11} format',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description:
      'VIDEO_NOT_FOUND (unknown video, or not visible to the caller)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(
    @Param() params: PublicIdParamDto,
    @CurrentUser() user?: JwtPayload,
  ): Promise<VideoDetailResult> {
    return this.videosService.findByPublicId(params.publicId, user?.sub);
  }

  @Get(':publicId/stream')
  @Public()
  @Redirect()
  @ApiParam({ name: 'publicId', description: 'Public identifier of the video' })
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects (302) to a presigned inline GET URL on the storage public ' +
      'endpoint. The storage serves HTTP Range/206 natively — no video bytes ' +
      'pass through the API. Only `ready` videos are streamable.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned inline playback URL',
    headers: {
      Location: {
        description: 'Presigned GET URL (inline disposition)',
        schema: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'publicId does not match the [A-Za-z0-9_-]{11} format',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND (unknown video or not ready)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param() params: PublicIdParamDto,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getStreamUrl(params.publicId);
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Get(':publicId/download')
  @Public()
  @Redirect()
  @ApiParam({ name: 'publicId', description: 'Public identifier of the video' })
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects (302) to a presigned GET URL with an attachment disposition ' +
      'and the title-derived filename. Only `ready` videos are downloadable.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned attachment download URL',
    headers: {
      Location: {
        description: 'Presigned GET URL (attachment disposition)',
        schema: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'publicId does not match the [A-Za-z0-9_-]{11} format',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND (unknown video or not ready)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param() params: PublicIdParamDto,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getDownloadUrl(params.publicId);
    return { url, statusCode: HttpStatus.FOUND };
  }
}
