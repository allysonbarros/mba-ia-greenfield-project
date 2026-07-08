import { FindOperator } from 'typeorm';
import { VideoStatus } from './entities/video.entity';
import { VideoSweepService } from './video-sweep.service';

describe('VideoSweepService', () => {
  const videos = { find: jest.fn(), delete: jest.fn(), update: jest.fn() };
  const storage = { abortMultipartUpload: jest.fn() };
  const storageConf = { uploadStaleTtlHours: 24 };
  const queueConf = { processingStuckCeilingHours: 2 };

  let service: VideoSweepService;

  beforeEach(() => {
    jest.clearAllMocks();
    videos.delete.mockResolvedValue({ affected: 1 });
    videos.update.mockResolvedValue({ affected: 1 });
    storage.abortMultipartUpload.mockResolvedValue(undefined);
    service = new VideoSweepService(
      videos as never,
      storage as never,
      storageConf as never,
      queueConf as never,
    );
  });

  describe('expireStaleDrafts', () => {
    it('aborts the multipart and deletes a stale draft with an open upload', async () => {
      videos.find.mockResolvedValue([
        { id: 'd1', original_key: 'videos/d1/original.mp4', upload_id: 'u1' },
      ]);

      await service.expireStaleDrafts();

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/d1/original.mp4',
        'u1',
      );
      expect(videos.delete).toHaveBeenCalledWith({ id: 'd1' });
    });

    it('deletes a stale draft without an upload_id but does not abort', async () => {
      videos.find.mockResolvedValue([
        { id: 'd2', original_key: 'videos/d2/original.mp4', upload_id: null },
      ]);

      await service.expireStaleDrafts();

      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
      expect(videos.delete).toHaveBeenCalledWith({ id: 'd2' });
    });

    it('queries only DRAFT rows older than the TTL cutoff', async () => {
      videos.find.mockResolvedValue([]);

      await service.expireStaleDrafts();

      const where = videos.find.mock.calls[0][0].where;
      expect(where.status).toBe(VideoStatus.DRAFT);
      expect(where.created_at).toBeInstanceOf(FindOperator);
    });
  });

  describe('failStuckProcessing', () => {
    it('CAS-fails a stuck processing row with STUCK_TIMEOUT', async () => {
      videos.find.mockResolvedValue([{ id: 'p1' }]);

      await service.failStuckProcessing();

      expect(videos.update).toHaveBeenCalledWith(
        { id: 'p1', status: VideoStatus.PROCESSING },
        expect.objectContaining({
          status: VideoStatus.FAILED,
          error_code: 'STUCK_TIMEOUT',
        }),
      );
    });

    it('queries only PROCESSING rows older than the ceiling', async () => {
      videos.find.mockResolvedValue([]);

      await service.failStuckProcessing();

      const where = videos.find.mock.calls[0][0].where;
      expect(where.status).toBe(VideoStatus.PROCESSING);
      expect(where.processing_started_at).toBeInstanceOf(FindOperator);
    });
  });
});
