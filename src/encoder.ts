import { spawn } from 'node:child_process';

const FRAME_RATE = 25;
/** Mimir recommends 2-second segments; every segment must have the same duration. */
export const SEGMENT_SECONDS = 2;

export interface EncoderParams {
  highresPath: string;
  /** Directory the proxy segments and thumbnails are written to before they are uploaded. */
  stagingDir: string;
  recordingSeconds: number;
}

/**
 * One real-time ffmpeg encode of a test signal stands in for the recorder's encoders. All three outputs
 * come from the same frames, so they stay aligned:
 * - the high-res: AVC-Intra 100 with two mono PCM tracks in a growing MXF, the essence Mimir can rewrap;
 * - the proxy: H.264 and AAC in 2-second TS segments, named webproxy.NNNNNN.ts;
 * - the thumbnails: one 320x180 JPEG per second, named live.NNNNN.jpg.
 */
function encoderArguments({ highresPath, stagingDir, recordingSeconds }: EncoderParams): string[] {
  const gop = String(FRAME_RATE * SEGMENT_SECONDS);
  // Each input is limited to the recording length; an output-side limit would only stop the first output.
  const input = (source: string): string[] => ['-re', '-f', 'lavfi', '-t', String(recordingSeconds), '-i', source];
  return [
    '-hide_banner', '-loglevel', 'warning', '-nostdin', '-y',
    ...input(`testsrc2=size=1920x1080:rate=${FRAME_RATE}`),
    ...input('sine=frequency=440:sample_rate=48000'),
    ...input('sine=frequency=880:sample_rate=48000'),
    '-filter_complex', [
      '[0:v]split=3[vhigh][vproxyin][vthumbin]',
      '[vproxyin]scale=960:540[vproxy]',
      '[vthumbin]fps=1,scale=320:180[vthumb]',
      '[1:a]asplit=2[a1high][a1proxy]',
      '[2:a]asplit=2[a2high][a2proxy]',
      '[a1proxy][a2proxy]amerge=inputs=2[aproxy]',
    ].join(';'),

    '-map', '[vhigh]', '-map', '[a1high]', '-map', '[a2high]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv422p10le', '-x264-params', 'avcintra-class=100',
    '-c:a', 'pcm_s24le', '-timecode', '10:00:00:00',
    '-f', 'mxf', highresPath,

    // Closed GOPs of exactly one segment, so every segment starts on a keyframe.
    '-map', '[vproxy]', '-map', '[aproxy]',
    '-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-b:v', '2M',
    '-g', gop, '-keyint_min', gop, '-sc_threshold', '0', '-flags', '+cgop',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-f', 'segment', '-segment_time', String(SEGMENT_SECONDS), '-segment_format', 'mpegts',
    '-segment_start_number', '0', `${stagingDir}/webproxy.%06d.ts`,

    // A thumbnail only gets its final name once it is completely written.
    '-map', '[vthumb]', '-q:v', '4', '-start_number', '0', '-atomic_writing', '1',
    `${stagingDir}/live.%05d.jpg`,
  ];
}

/** Settles once ffmpeg has exited. Aborting `signal` stops the encode. */
export function runEncoder(params: EncoderParams, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', encoderArguments(params), { stdio: ['ignore', 'ignore', 'pipe'], signal });
    let stderrTail = '';
    ffmpeg.stderr.setEncoding('utf8');
    ffmpeg.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });
    ffmpeg.on('error', (error) => {
      // Without a pid, ffmpeg never started and no 'close' event follows. Otherwise wait for it to exit.
      if (ffmpeg.pid === undefined) {
        reject(error);
      }
    });
    ffmpeg.on('close', (exitCode, signalName) => {
      if (exitCode === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with ${exitCode ?? signalName}: ${stderrTail}`));
      }
    });
  });
}
