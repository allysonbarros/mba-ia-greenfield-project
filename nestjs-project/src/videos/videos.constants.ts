// 10 GiB hard ceiling on declared/real file size (AMB-3, phase-03-videos/TD-02).
export const MAX_VIDEO_FILE_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

// content_type must be a video/* MIME type (enforced as a domain rule so the
// rejection carries the VIDEO_INVALID_CONTENT_TYPE errorCode).
export const VIDEO_CONTENT_TYPE_PATTERN = /^video\/[\w.+-]+$/;

// public_id format — 11 chars base64url alphabet (phase-03-videos/TD-05).
export const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export const PG_UNIQUE_VIOLATION = '23505';
