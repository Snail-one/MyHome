function notFoundApi(req, res) {
  res.status(404).json({ error: '接口不存在' });
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    next(error);
    return;
  }

  const statusCode = Number.isInteger(error.status) && error.status >= 400 ? error.status : 500;
  if (statusCode >= 500) {
    console.error(error);
  }
  res.status(statusCode).json({ error: statusCode === 404 ? '资源不存在' : '服务器内部错误' });
}

module.exports = {
  errorHandler,
  notFoundApi
};
