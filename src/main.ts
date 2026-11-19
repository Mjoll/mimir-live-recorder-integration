/**
 * A live recorder that starts a recording on its own and delivers it into Mimir, as in Part 1 of the
 * guide "Integrating a Live Recorder with Mimir":
 *
 *   1. Create the Mimir item. Its ID names every file of the recording.
 *   2. Write the high-res as a growing <itemId>.mxf into a Kelda live folder.
 *   3. Upload proxy segments and thumbnails to <pathPrefix><itemId>/ in S3 as each one is complete.
 *
 * Steps 2 and 3 run together in recording.ts. Nothing more is needed to end the recording: Kelda ends it
 * once the file has stopped growing.
 */
import { join } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { ConfigError, loadConfig, type Config } from './config.ts';
import { createLiveItem } from './mimirApi.ts';
import { checkBucket, record } from './recording.ts';

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return error.cause === undefined ? error.message : `${error.message}: ${errorMessage(error.cause)}`;
}

async function recordIntoMimir(config: Config, s3: S3Client): Promise<void> {
  await checkBucket(s3, config.s3Bucket);

  // Step 1. The item must exist before the first byte of media is written.
  const title = `Live recorder example ${new Date().toISOString()}`;
  const itemId = await createLiveItem({
    baseUrl: config.mimirBaseUrl,
    apiKey: config.mimirApiKey,
    title,
    generatedMediaLocationId: config.generatedMediaLocationId,
  });
  log(`created Mimir item ${itemId} ("${title}")`);

  // Steps 2 and 3.
  const delivered = await record({
    s3,
    bucket: config.s3Bucket,
    keyPrefix: `${config.s3PathPrefix}${itemId}/`,
    highresPath: join(config.liveFolderDir, `${itemId}.mxf`),
    stagingDir: join('work', itemId),
    recordingSeconds: config.recordingSeconds,
    log,
  });
  log(`recording ended: uploaded ${delivered.segments} segments and ${delivered.thumbnails} thumbnails`);
  log('Kelda ends the recording in Mimir about 10 seconds after the file stops growing');
}

/** Exit codes: 0 the recording was delivered, 1 the run failed, 2 the configuration is incomplete. */
async function main(): Promise<number> {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`${error.message}. See .env.example.`);
      return 2;
    }
    throw error;
  }

  const s3 = new S3Client({ region: config.awsRegion });
  try {
    await recordIntoMimir(config, s3);
    return 0;
  } catch (error) {
    console.error(`ERROR: ${errorMessage(error)}`);
    return 1;
  } finally {
    s3.destroy();
  }
}

process.exitCode = await main();
