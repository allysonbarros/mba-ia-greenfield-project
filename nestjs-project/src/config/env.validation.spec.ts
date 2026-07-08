import { envValidationSchema } from './env.validation';

const completeEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ENDPOINT: 'http://minio:9000',
  STORAGE_PUBLIC_ENDPOINT: 'http://minio:9000',
  STORAGE_ACCESS_KEY_ID: 'minioadmin',
  STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
  STORAGE_BUCKET: 'streamtube-videos',
  REDIS_HOST: 'redis',
  REDIS_PORT: '6379',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(env, {
    allowUnknown: true,
    abortEarly: false,
  });

describe('envValidationSchema — storage/queue (phase 03)', () => {
  it('accepts a complete env and applies numeric/boolean defaults', () => {
    const { error, value } = validate(completeEnv);

    expect(error).toBeUndefined();
    expect(value.STORAGE_REGION).toBe('us-east-1');
    expect(value.STORAGE_FORCE_PATH_STYLE).toBe(true);
    expect(value.STORAGE_AUTO_CREATE_BUCKET).toBe(true);
    expect(value.UPLOAD_PART_SIZE_MB).toBe(64);
    expect(value.UPLOAD_URL_EXPIRES_IN).toBe(21600);
    expect(value.PLAYBACK_URL_EXPIRES_IN).toBe(21600);
    expect(value.DOWNLOAD_URL_EXPIRES_IN).toBe(900);
    expect(value.UPLOAD_STALE_TTL_HOURS).toBe(24);
    expect(value.VIDEO_PROCESSING_ATTEMPTS).toBe(3);
    expect(value.PROCESSING_STUCK_CEILING_HOURS).toBe(2);
  });

  it('rejects a missing STORAGE_ENDPOINT', () => {
    const { STORAGE_ENDPOINT, ...withoutEndpoint } = completeEnv;
    void STORAGE_ENDPOINT;

    const { error } = validate(withoutEndpoint);

    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ENDPOINT');
  });

  it('rejects a non-numeric REDIS_PORT', () => {
    const { error } = validate({ ...completeEnv, REDIS_PORT: 'not-a-number' });

    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_PORT');
  });
});
