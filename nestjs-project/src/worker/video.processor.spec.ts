import { Job, UnrecoverableError } from 'bullmq';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { FfmpegService, MediaProcessingError } from './ffmpeg.service';
import { VideoProcessor } from './video.processor';

jest.mock('node:fs/promises', () => ({
  readFile: jest.fn().mockResolvedValue(Buffer.from('jpeg-bytes')),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

describe('VideoProcessor', () => {
  const videos = { findOneBy: jest.fn(), update: jest.fn() };
  const storage = { presignInternalGetUrl: jest.fn(), putObject: jest.fn() };
  const ffmpeg = { probe: jest.fn(), generateThumbnail: jest.fn() };
  const config = { playbackUrlExpiresIn: 21600 };

  let processor: VideoProcessor;

  const processingVideo = {
    id: 'video-1',
    status: VideoStatus.PROCESSING,
    original_key: 'videos/video-1/original.mp4',
    processing_started_at: null,
  } as unknown as Video;

  function makeJob(overrides: Partial<Job> = {}): Job {
    return {
      data: {
        videoId: 'video-1',
        bucket: 'b',
        key: 'videos/video-1/original.mp4',
      },
      attemptsMade: 0,
      opts: { attempts: 3 },
      ...overrides,
    } as unknown as Job;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    videos.update.mockResolvedValue({ affected: 1 });
    storage.presignInternalGetUrl.mockResolvedValue('http://minio:9000/signed');
    ffmpeg.probe.mockResolvedValue({
      durationSeconds: 1,
      width: 128,
      height: 72,
      codecName: 'h264',
      metadata: { format_name: 'mp4' },
    });
    ffmpeg.generateThumbnail.mockResolvedValue(undefined);
    storage.putObject.mockResolvedValue(undefined);
    processor = new VideoProcessor(
      videos as never,
      storage as unknown as never,
      ffmpeg as unknown as FfmpegService,
      config as never,
    );
  });

  it('drives a valid job to ready with metadata and thumbnail', async () => {
    videos.findOneBy.mockResolvedValue({ ...processingVideo });

    await processor.process(makeJob());

    expect(storage.putObject).toHaveBeenCalledWith(
      'videos/video-1/thumbnail.jpg',
      expect.any(Buffer),
      'image/jpeg',
    );
    expect(videos.update).toHaveBeenCalledWith(
      { id: 'video-1', status: VideoStatus.PROCESSING },
      expect.objectContaining({
        status: VideoStatus.READY,
        thumbnail_key: 'videos/video-1/thumbnail.jpg',
      }),
    );
  });

  it('is idempotent when the final CAS reports affected=0 (concurrent completion)', async () => {
    videos.findOneBy.mockResolvedValue({ ...processingVideo });
    videos.update.mockImplementation((_criteria, patch: { status?: string }) =>
      Promise.resolve({ affected: patch.status === VideoStatus.READY ? 0 : 1 }),
    );

    await expect(processor.process(makeJob())).resolves.toBeUndefined();
  });

  it('skips a duplicate delivery of an already-ready video', async () => {
    videos.findOneBy.mockResolvedValue({
      ...processingVideo,
      status: VideoStatus.READY,
    });

    await processor.process(makeJob());

    expect(ffmpeg.probe).not.toHaveBeenCalled();
    expect(videos.update).not.toHaveBeenCalled();
  });

  it('fails the row immediately and throws UnrecoverableError on invalid media', async () => {
    videos.findOneBy.mockResolvedValue({ ...processingVideo });
    ffmpeg.probe.mockRejectedValue(
      new MediaProcessingError('PROBE_FAILED', 'ffprobe failed: bad data'),
    );

    await expect(processor.process(makeJob())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(videos.update).toHaveBeenCalledWith(
      { id: 'video-1', status: VideoStatus.PROCESSING },
      expect.objectContaining({
        status: VideoStatus.FAILED,
        error_code: 'PROBE_FAILED',
      }),
    );
  });

  it('does not persist a failure on a transient error before exhaustion', async () => {
    videos.findOneBy.mockResolvedValue({ ...processingVideo });
    storage.presignInternalGetUrl.mockRejectedValue(new Error('network blip'));

    await expect(
      processor.process(makeJob({ attemptsMade: 0 } as Partial<Job>)),
    ).rejects.toThrow('network blip');

    const failedUpdate = videos.update.mock.calls.find(
      (call) => (call[1] as { status?: string }).status === VideoStatus.FAILED,
    );
    expect(failedUpdate).toBeUndefined();
  });

  it('persists a STORAGE_IO failure once attempts are exhausted', async () => {
    videos.findOneBy.mockResolvedValue({ ...processingVideo });
    storage.presignInternalGetUrl.mockRejectedValue(new Error('network down'));

    await expect(
      processor.process(makeJob({ attemptsMade: 2 } as Partial<Job>)),
    ).rejects.toThrow('network down');

    expect(videos.update).toHaveBeenCalledWith(
      { id: 'video-1', status: VideoStatus.PROCESSING },
      expect.objectContaining({
        status: VideoStatus.FAILED,
        error_code: 'STORAGE_IO',
      }),
    );
  });

  it('treats a missing video row as unrecoverable', async () => {
    videos.findOneBy.mockResolvedValue(null);

    await expect(processor.process(makeJob())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });
});
