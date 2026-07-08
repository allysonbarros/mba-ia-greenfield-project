import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import storageConfig from '../config/storage.config';
import {
  VideoFileTooLargeException,
  VideoInvalidContentTypeException,
} from '../common/exceptions/domain.exception';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
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

describe('VideosService.initiateUpload', () => {
  let service: VideosService;

  const videoRepo = { insert: jest.fn() };
  const storage = {
    createMultipartUpload: jest.fn(),
    presignUploadPartUrls: jest.fn(),
  };
  const channels = { findByUserId: jest.fn() };
  const config = { uploadPartSizeMb: 64, uploadUrlExpiresIn: 21600 };

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
        { provide: storageConfig.KEY, useValue: config },
      ],
    }).compile();
    service = module.get(VideosService);
  });

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
