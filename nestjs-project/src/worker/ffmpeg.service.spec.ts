import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MediaProcessingError, parseProbeOutput } from './ffmpeg.service';

// The fixture is the verbatim `ffprobe -print_format json -show_format
// -show_streams` output for test/fixtures/tiny.mp4 (regenerate both together —
// see test/fixtures/README.md).
const PROBE_JSON = readFileSync(
  join(__dirname, '__fixtures__', 'ffprobe-tiny.output.json'),
  'utf-8',
);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof MediaProcessingError ? e.code : 'NOT_A_MEDIA_ERROR';
  }
  return undefined;
}

describe('parseProbeOutput', () => {
  it('parses duration, dimensions and codec from real ffprobe output', () => {
    const result = parseProbeOutput(PROBE_JSON);

    expect(result.durationSeconds).toBeCloseTo(1, 3);
    expect(result.width).toBe(128);
    expect(result.height).toBe(72);
    expect(result.codecName).toBe('h264');
    expect(result.metadata.format_name).toContain('mp4');
    expect(result.metadata.pix_fmt).toBe('yuv420p');
  });

  it('classifies input without a video stream as UNSUPPORTED_MEDIA', () => {
    const audioOnly = JSON.stringify({
      streams: [{ codec_type: 'audio', codec_name: 'aac' }],
      format: { duration: '3.0' },
    });

    expect(codeOf(() => parseProbeOutput(audioOnly))).toBe('UNSUPPORTED_MEDIA');
  });

  it('classifies non-JSON output as PROBE_FAILED', () => {
    expect(codeOf(() => parseProbeOutput('not json at all'))).toBe(
      'PROBE_FAILED',
    );
  });
});
