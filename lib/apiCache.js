const crypto = require('crypto');
const zlib = require('zlib');

const API_CACHE_PAYLOAD_KINDS = {
  schedulesV1: 'schedules:v1',
  scheduleTimesV1: 'schedule-times:v1',
  scheduleTimesV2: 'schedule-times:v2',
};

const API_RESPONSE_CACHE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS api_response_cache (
    cache_key text PRIMARY KEY,
    payload_kind text NOT NULL,
    route_id integer,
    etag text NOT NULL,
    payload_text text NOT NULL,
    payload_gzip bytea NOT NULL,
    payload_br bytea NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`;

const API_RESPONSE_CACHE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_api_response_cache_kind_route
  ON api_response_cache (payload_kind, route_id);
`;

function getApiCacheKey(payloadKind, routeId = null) {
  if (payloadKind === API_CACHE_PAYLOAD_KINDS.schedulesV1) {
    return payloadKind;
  }

  return `${payloadKind}:${routeId}`;
}

function createEtag(payloadText) {
  const hash = crypto.createHash('sha256').update(payloadText).digest('base64url');

  return `"${hash}"`;
}

function createCompressedPayloads(payloadText) {
  const payloadBuffer = Buffer.from(payloadText);

  return {
    payload_gzip: zlib.gzipSync(payloadBuffer, { level: 9 }),
    payload_br: zlib.brotliCompressSync(payloadBuffer, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 7,
      },
    }),
  };
}

function createApiPayloadRecord({ cacheKey, payloadKind, routeId = null, payload }) {
  const payloadText = JSON.stringify(payload);
  const compressedPayloads = createCompressedPayloads(payloadText);

  return {
    cache_key: cacheKey,
    payload_kind: payloadKind,
    route_id: routeId == null ? null : Number(routeId),
    etag: createEtag(payloadText),
    payload_text: payloadText,
    ...compressedPayloads,
  };
}

module.exports = {
  API_CACHE_PAYLOAD_KINDS,
  API_RESPONSE_CACHE_INDEX_SQL,
  API_RESPONSE_CACHE_TABLE_SQL,
  createApiPayloadRecord,
  createEtag,
  getApiCacheKey,
};
