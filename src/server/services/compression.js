const zlib = require('zlib');

const COMPRESSIBLE_TYPE = /^(?:text\/(?!event-stream)|application\/(?:javascript|json|xml|xhtml\+xml)|image\/svg\+xml)/i;

function appendVary(current, value) {
  const values = String(current || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!values.some((part) => part.toLowerCase() === value.toLowerCase())) values.push(value);
  return values.join(', ');
}

function createCompressionMiddleware() {
  return function compressionMiddleware(req, res, next) {
    if (req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (!/\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) return next();

    const write = res.write.bind(res);
    const end = res.end.bind(res);
    let mode = 'unknown';
    const chunks = [];

    function decide() {
      if (mode !== 'unknown') return mode;
      if (res.headersSent) {
        mode = 'passthrough';
        return mode;
      }

      const type = String(res.getHeader('Content-Type') || '');
      const cacheControl = String(res.getHeader('Cache-Control') || '');
      if (
        !type ||
        res.getHeader('Content-Encoding') ||
        /text\/event-stream/i.test(type) ||
        /no-transform/i.test(cacheControl) ||
        !COMPRESSIBLE_TYPE.test(type)
      ) {
        mode = 'passthrough';
        return mode;
      }

      mode = 'gzip';
      return mode;
    }

    res.write = function compressedWrite(chunk, encoding, callback) {
      if (typeof encoding === 'function') {
        callback = encoding;
        encoding = undefined;
      }

      if (decide() !== 'gzip') return write(chunk, encoding, callback);
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8'));
      if (typeof callback === 'function') callback();
      return true;
    };

    res.end = function compressedEnd(chunk, encoding, callback) {
      if (typeof chunk === 'function') {
        callback = chunk;
        chunk = undefined;
        encoding = undefined;
      } else if (typeof encoding === 'function') {
        callback = encoding;
        encoding = undefined;
      }

      if (chunk) res.write(chunk, encoding);
      if (decide() !== 'gzip') return end(callback);

      const body = Buffer.concat(chunks);
      if (body.length < 1024) return end(body, callback);

      zlib.gzip(body, (error, gzipped) => {
        if (error || gzipped.length >= body.length) return end(body, callback);
        res.removeHeader('Content-Length');
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', appendVary(res.getHeader('Vary'), 'Accept-Encoding'));
        end(gzipped, callback);
      });
    };

    next();
  };
}

module.exports = {
  createCompressionMiddleware
};
