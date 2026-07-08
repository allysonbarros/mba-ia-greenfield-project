import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import storageConfig from '../config/storage.config';
import {
  VideoFileTooLargeException,
  VideoInvalidContentTypeException,
  VideoNotFoundException,
  VideoUploadNotCompletableException,
  VideoUploadSizeMismatchException,
} from '../common/exceptions/domain.exception';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { VideoQueueProducer } from '../queue/video-queue.producer';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { MAX_VIDEO_FILE_SIZE_BYTES } from './videos.constants';
import { VideosService } from './videos.service';

function uniqueViolation(column: string): QueryFailedError {
  const error = new QueryFailedError('INSERT', [], new Error('duplicate key'));
  Object.assign(error, {
    code: '23505',
    detail: `Key (${column})=(abc) already exists.`,
  });
  return error;
}

describe('VideosService', () => {
  let service: VideosService;

  const videoRepo = {
    insert: jest.fn(),
    findOne: jest.fn(),
    findOneByOrFail: jest.fn(),
    update: jest.fn(),
  };
  const storage = {
    createMultipartUpload: jest.fn(),
    presignUploadPartUrls: jest.fn(),
    completeMultipartUpload: jest.fn(),
    headObject: jest.fn(),
    abortMultipartUpload: jest.fn(),
  };
  const channels = { findByUserId: jest.fn() };
  const producer = { enqueueProcessing: jest.fn() };
  const config = {
    uploadPartSizeMb: 64,
    uploadUrlExpiresIn: 21600,
    bucket: 'streamtube-videos',
  };

  const validDto: CreateVideoDto = {
    title: 'My Video',
    file_name: 'video.mp4',
    file_size: 5 * 1024 * 1024,
    content_type: 'video/mp4',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepo },
        { provide: StorageService, useValue: storage },
        { provide: ChannelsService, useValue: channels },
        { provide: VideoQueueProducer, useValue: producer },
        { provide: storageConfig.KEY, useValue: config },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  describe('initiateUpload', () => {
    it('rejects a file above the 10 GiB ceiling with VideoFileTooLargeException', async () => {
      await expect(
        service.initiateUpload('user-1', {
          ...validDto,
          file_size: MAX_VIDEO_FILE_SIZE_BYTES + 1,
        }),
      ).rejects.toBeInstanceOf(VideoFileTooLargeException);

      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepo.insert).not.toHaveBeenCalled();
    });

    it('rejects a non-video content_type with VideoInvalidContentTypeException', async () => {
      await expect(
        service.initiateUpload('user-1', {
          ...validDto,
          content_type: 'image/png',
        }),
      ).rejects.toBeInstanceOf(VideoInvalidContentTypeException);

      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('regenerates public_id and retries once on a 23505 collision', async () => {
      channels.findByUserId.mockResolvedValue({ id: 'channel-1' });
      storage.createMultipartUpload.mockResolvedValue({ uploadId: 'upload-1' });
      storage.presignUploadPartUrls.mockResolvedValue([
        { partNumber: 1, url: 'https://minio:9000/part-1' },
      ]);
      videoRepo.insert
        .mockRejectedValueOnce(uniqueViolation('public_id'))
        .mockResolvedValueOnce({});

      const result = await service.initiateUpload('user-1', validDto);

      expect(videoRepo.insert).toHaveBeenCalledTimes(2);
      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.public_id).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(result.upload.part_count).toBe(1);
    });
  });

  describe('completeUpload', () => {
    const draft = {
      id: 'video-1',
      public_id: 'abcdefghijk',
      channel_id: 'channel-1',
      status: VideoStatus.DRAFT,
      original_key: 'videos/video-1/original.mp4',
      upload_id: 'upload-1',
      file_size: 1024,
    };
    const parts = { parts: [{ part_number: 1, etag: '"etag-1"' }] };

    beforeEach(() => {
      channels.findByUserId.mockResolvedValue({ id: 'channel-1' });
    });

    it('is idempotent — returns 200 with current status when already processing', async () => {
      videoRepo.findOne.mockResolvedValue({
        ...draft,
        status: VideoStatus.PROCESSING,
        upload_id: null,
      });

      const result = await service.completeUpload(
        'user-1',
        'abcdefghijk',
        parts,
      );

      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(producer.enqueueProcessing).not.toHaveBeenCalled();
    });

    it('throws VideoUploadNotCompletableException (409) when the video is failed', async () => {
      videoRepo.findOne.mockResolvedValue({
        ...draft,
        status: VideoStatus.FAILED,
      });

      await expect(
        service.completeUpload('user-1', 'abcdefghijk', parts),
      ).rejects.toBeInstanceOf(VideoUploadNotCompletableException);
    });

    it('throws VideoNotFoundException when the video belongs to another channel', async () => {
      videoRepo.findOne.mockResolvedValue({
        ...draft,
        channel_id: 'other-channel',
      });

      await expect(
        service.completeUpload('user-1', 'abcdefghijk', parts),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('aborts the multipart and marks the video failed on a size mismatch', async () => {
      videoRepo.findOne.mockResolvedValue({ ...draft });
      storage.completeMultipartUpload.mockResolvedValue(undefined);
      storage.headObject.mockResolvedValue({ contentLength: 2048 });
      storage.abortMultipartUpload.mockResolvedValue(undefined);
      videoRepo.update.mockResolvedValue({ affected: 1 });

      await expect(
        service.completeUpload('user-1', 'abcdefghijk', parts),
      ).rejects.toBeInstanceOf(VideoUploadSizeMismatchException);

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        draft.original_key,
        draft.upload_id,
      );
      expect(videoRepo.update).toHaveBeenCalledWith(
        { id: draft.id, status: VideoStatus.DRAFT },
        expect.objectContaining({
          status: VideoStatus.FAILED,
          error_code: 'VIDEO_UPLOAD_SIZE_MISMATCH',
        }),
      );
      expect(producer.enqueueProcessing).not.toHaveBeenCalled();
    });

    it('completes a draft: CAS to processing and enqueues the job', async () => {
      videoRepo.findOne.mockResolvedValue({ ...draft });
      storage.completeMultipartUpload.mockResolvedValue(undefined);
      storage.headObject.mockResolvedValue({ contentLength: 1024 });
      videoRepo.update.mockResolvedValue({ affected: 1 });

      const result = await service.completeUpload(
        'user-1',
        'abcdefghijk',
        parts,
      );

      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(producer.enqueueProcessing).toHaveBeenCalledWith(
        draft.id,
        config.bucket,
        draft.original_key,
      );
    });
  });
});
