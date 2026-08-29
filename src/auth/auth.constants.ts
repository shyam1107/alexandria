export const ACCESS_TOKEN_ALGORITHM = 'HS256';
export const ACCESS_TOKEN_TYPE = 'JWT';
export const BEARER_PREFIX = 'Bearer ';
export const PASSWORD_HASH_ALGORITHM = 'scrypt';
export const PASSWORD_SALT_BYTES = 16;
export const PASSWORD_KEY_LENGTH = 64;
export const PASSWORD_SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1 } as const;
export const REFRESH_TOKEN_BYTES = 48;
