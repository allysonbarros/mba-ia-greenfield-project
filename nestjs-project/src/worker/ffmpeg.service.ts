import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';

const execFileAsync = promisify(execFile);

// ffprobe JSON can carry many streams/tags; give the pipe generous headroom.
const MAX_BUFFER = 16 * 1024 * 1024;

export type MediaErrorCode =
  | 'PROBE_FAILED'
  | 'THUMBNAIL_FAILED'
  | 'UNSUPPORTED_MEDIA';

// Classifies ffprobe/ffmpeg failures into the phase Error Catalog codes so the
// processor can persist them on processing→failed (phase-03-videos Error Catalog).
export class MediaProcessingError extends Error {
  constructor(
    public readonly code: MediaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MediaProcessingError';
  }
}

export interface ProbeResult {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  codecName: string | null;
  metadata: Record<string, unknown>;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: {
    duration?: string;
    format_name?: string;
    bit_rate?: string;
  };
}

// Pure parse of ffprobe JSON, split out from the exec so it is unit-testable
// against a committed fixture without invoking ffprobe.
export function parseProbeOutput(stdout: string): ProbeResult {
  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw new MediaProcessingError(
      'PROBE_FAILED',
      'ffprobe returned non-JSON output',
    );
  }

  const videoStream = (parsed.streams ?? []).find(
    (s) => s.codec_type === 'video',
  );
  if (!videoStream) {
    throw new MediaProcessingError(
      'UNSUPPORTED_MEDIA',
      'Input has no video stream',
    );
  }

  const duration = parsed.format?.duration;
  return {
    durationSeconds:
      duration !== undefined && duration !== '' ? parseFloat(duration) : null,
    width: videoStream.width ?? null,
    height: videoStream.height ?? null,
    codecName: videoStream.codec_name ?? null,
    metadata: {
      format_name: parsed.format?.format_name ?? null,
      codec_name: videoStream.codec_name ?? null,
      pix_fmt: videoStream.pix_fmt ?? null,
      bit_rate: parsed.format?.bit_rate ?? null,
    },
  };
}

function stderrOf(error: unknown): string {
  const e = error as { stderr?: string | Buffer; message?: string };
  if (e.stderr) {
    return e.stderr.toString().trim();
  }
  return e.message ?? 'unknown error';
}

/**
 * Thin wrapper over the two FFmpeg invocations the phase needs — ffprobe for
 * metadata and ffmpeg for a single thumbnail frame (phase-03-videos/TD-03).
 * Input is always a seekable (presigned) URL or path, never stdin, so ffprobe
 * can read an MP4's trailing moov atom without a full download.
 */
@Injectable()
export class FfmpegService {
  async probe(inputUrl: string): Promise<ProbeResult> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          inputUrl,
        ],
        { maxBuffer: MAX_BUFFER },
      ));
    } catch (error) {
      throw new MediaProcessingError(
        'PROBE_FAILED',
        `ffprobe failed: ${stderrOf(error)}`,
      );
    }
    return parseProbeOutput(stdout);
  }

  async generateThumbnail(
    inputUrl: string,
    outPath: string,
    atSecond: number,
  ): Promise<void> {
    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-ss',
          String(atSecond),
          '-i',
          inputUrl,
          '-frames:v',
          '1',
          '-vf',
          'scale=640:-2',
          '-q:v',
          '3',
          '-y',
          outPath,
        ],
        { maxBuffer: MAX_BUFFER },
      );
    } catch (error) {
      throw new MediaProcessingError(
        'THUMBNAIL_FAILED',
        `ffmpeg thumbnail failed: ${stderrOf(error)}`,
      );
    }
  }
}
