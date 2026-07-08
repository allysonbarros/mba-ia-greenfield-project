// DI tokens for the dual S3 client setup (phase-03-videos/TD-07): one client
// on the internal ops endpoint, one presign-only client on the public endpoint.
export const S3_CLIENT = 'S3_CLIENT' as const;
export const S3_PRESIGN_CLIENT = 'S3_PRESIGN_CLIENT' as const;
