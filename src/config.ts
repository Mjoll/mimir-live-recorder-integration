/** The settings in .env. See .env.example for what each one means. */
export interface Config {
  mimirBaseUrl: string;
  mimirApiKey: string;
  generatedMediaLocationId: string;
  s3Bucket: string;
  s3PathPrefix: string;
  awsRegion: string;
  liveFolderDir: string;
  recordingSeconds: number;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === '') {
    throw new ConfigError(`Missing required setting ${name}`);
  }
  return value;
}

export function loadConfig(env: Env): Config {
  const recordingSeconds = Number(required(env, 'RECORDING_SECONDS'));
  if (!Number.isInteger(recordingSeconds) || recordingSeconds <= 0) {
    throw new ConfigError('RECORDING_SECONDS must be a positive whole number');
  }
  return {
    mimirBaseUrl: required(env, 'MIMIR_BASE_URL').replace(/\/+$/, ''),
    mimirApiKey: required(env, 'MIMIR_API_KEY'),
    generatedMediaLocationId: required(env, 'GENERATED_MEDIA_LOCATION_ID'),
    s3Bucket: required(env, 'S3_BUCKET'),
    s3PathPrefix: required(env, 'S3_PATH_PREFIX'),
    awsRegion: required(env, 'AWS_REGION'),
    liveFolderDir: required(env, 'LIVE_FOLDER_DIR'),
    recordingSeconds,
  };
}
