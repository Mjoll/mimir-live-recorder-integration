import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { HeadBucketCommand, PutObjectCommand, S3ServiceException, type S3Client } from '@aws-sdk/client-s3';
import { runEncoder } from './encoder.ts';

const SEGMENT_NAME = /^webproxy\.\d{6}\.ts$/;
const THUMBNAIL_NAME = /^live\.\d{5}\.jpg$/;
const STAGING_POLL_MS = 250;

export interface RecordingParams {
  s3: S3Client;
  bucket: string;
  /** `<pathPrefix><itemId>/`: every file of the recording goes into this one folder. */
  keyPrefix: string;
  /** `<live folder>/<itemId>.mxf` */
  highresPath: string;
  stagingDir: string;
  recordingSeconds: number;
  log: (message: string) => void;
}

export interface Delivered {
  segments: number;
  thumbnails: number;
}

/** Fails if the bucket cannot be reached, so that no recording is started that could not be delivered. */
export async function checkBucket(s3: S3Client, bucket: string): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    // HeadBucket responses have no body, so the HTTP status is the useful part: 404 no such bucket, 403 no access.
    const status = error instanceof S3ServiceException ? ` (HTTP ${error.$metadata.httpStatusCode})` : '';
    throw new Error(`The bucket ${bucket} is not reachable with these AWS credentials${status}`, { cause: error });
  }
}

/**
 * Records: the encoder writes the growing high-res file straight into the live folder and stages proxy
 * segments and thumbnails, which are uploaded to S3 while the recording runs. Settles when the encoder has
 * stopped and everything is uploaded, or with the first failure.
 */
export async function record(params: RecordingParams): Promise<Delivered> {
  await mkdir(dirname(params.highresPath), { recursive: true });
  await mkdir(params.stagingDir, { recursive: true });
  params.log(`recording ${params.recordingSeconds} s: high-res ${params.highresPath}`);
  const stopEncoder = new AbortController();
  const encoderDone = runEncoder(params, stopEncoder.signal);
  try {
    return await uploadWhileEncoding(params, encoderDone);
  } catch (error) {
    // Do not keep growing a high-res file whose proxy can no longer be delivered.
    stopEncoder.abort();
    throw error;
  } finally {
    await encoderDone.catch(() => undefined);
    await rm(params.stagingDir, { recursive: true, force: true });
  }
}

async function uploadWhileEncoding(params: RecordingParams, encoderDone: Promise<void>): Promise<Delivered> {
  const { s3, bucket, keyPrefix, stagingDir, log } = params;
  const delivered: Delivered = { segments: 0, thumbnails: 0 };

  const upload = async (name: string): Promise<void> => {
    const path = join(stagingDir, name);
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${keyPrefix}${name}`, Body: await readFile(path) }));
    await rm(path);
    log(`uploaded s3://${bucket}/${keyPrefix}${name}`);
  };

  const uploadReady = async (encoderFinished: boolean): Promise<void> => {
    // The numbers are zero-padded, so sorting by name sorts by index.
    const names = (await readdir(stagingDir)).sort();
    const thumbnails = names.filter((name) => THUMBNAIL_NAME.test(name));
    const segments = names.filter((name) => SEGMENT_NAME.test(name));
    // The encoder is still writing its newest segment; a segment is complete once the next one exists.
    const completeSegments = encoderFinished ? segments : segments.slice(0, -1);
    for (const name of [...thumbnails, ...completeSegments]) {
      await upload(name);
    }
    delivered.thumbnails += thumbnails.length;
    delivered.segments += completeSegments.length;
  };

  let encoding = true;
  encoderDone.then(() => { encoding = false; }, () => { encoding = false; });
  while (encoding) {
    await uploadReady(false);
    await sleep(STAGING_POLL_MS);
  }
  await encoderDone;
  await uploadReady(true);
  return delivered;
}
