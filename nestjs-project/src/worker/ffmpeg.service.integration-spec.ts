import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FfmpegService, MediaProcessingError } from './ffmpeg.service';

// Real ffprobe/ffmpeg — run inside the video-worker container (the only image
// with the binaries): docker compose exec -T video-worker npx jest --runInBand
// --forceExit src/worker
const TINY_MP4 = join(__dirname, '..', '..', 'test', 'fixtures', 'tiny.mp4');

describe('FfmpegService (integration — real ffmpeg)', () => {
  const service = new FfmpegService();
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ffmpeg-it-'));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('probes duration, dimensions and codec from tiny.mp4', async () => {
    const result = await service.probe(TINY_MP4);

    expect(result.durationSeconds).toBeCloseTo(1, 1);
    expect(result.width).toBe(128);
    expect(result.height).toBe(72);
    expect(result.codecName).toBe('h264');
  });

  it('generates a non-empty JPEG thumbnail', async () => {
    const out = join(workDir, 'thumb.jpg');

    await service.generateThumbnail(TINY_MP4, out, 0.1);

    expect(existsSync(out)).toBe(true);
    expect(statSync(out).size).toBeGreaterThan(0);
  });

  it('classifies corrupted input as PROBE_FAILED with stderr captured', async () => {
    const bad = join(workDir, 'bad.mp4');
    writeFileSync(bad, Buffer.from('this is definitely not a video file'));

    let caught: MediaProcessingError | undefined;
    try {
      await service.probe(bad);
    } catch (e) {
      caught = e as MediaProcessingError;
    }

    expect(caught).toBeInstanceOf(MediaProcessingError);
    expect(caught?.code).toBe('PROBE_FAILED');
    // stderr from ffprobe is folded into the message, so it is longer than the
    // bare prefix.
    expect(caught?.message.length).toBeGreaterThan('ffprobe failed: '.length);
  });
});
