/**
 * Public file metadata and private byte-range responses.
 * Resolve the row through an owner-scoped repository query before calling.
 */
import { fail } from './protocol.mjs';

export const publicFile = row => {
  const {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Omit the private storage key from the public projection.
    objectKey,
    ...rest
  } = row;
  return {
    ...rest,
    contentUrl: `/api/v2/${row.sourceAssetIds ? 'creatives' : 'assets'}/${row.id}/content`
  };
};

export async function contentResponse(request, row, bucket) {
  const range = request.headers.get('Range');
  let options;
  if (range) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!m) {
      return new Response(null, {
        status: 416
      });
    }
    const offset = Number(m[1]);
    const end = m[2] ? Number(m[2]) : row.size - 1;
    if (offset >= row.size || end < offset) {
      return new Response(null, {
        status: 416
      });
    }
    options = {
      range: {
        offset,
        length: Math.min(end, row.size - 1) - offset + 1
      }
    };
  }
  const object = await bucket.get(row.objectKey, options);
  if (!object) {
    fail(404, '素材内容不存在', 'not_found');
  }
  const headers = new Headers({
    'Content-Type': row.mimeType,
    'Content-Length': String(options?.range.length ?? row.size),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${row.mimeType === 'image/svg+xml' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(row.filename)}`
  });
  if (options) {
    headers.set('Content-Range', `bytes ${options.range.offset}-${options.range.offset + options.range.length - 1}/${row.size}`);
  }
  return new Response(object.body, {
    status: options ? 206 : 200,
    headers
  });
}
