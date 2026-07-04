class AppError extends Error {
  constructor(message, code, status, details = []) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.details = details;
    this.isOperational = true;
  }
}

class ValidationError extends AppError {
  constructor(details) {
    super("请求参数不完整", "VALIDATION_ERROR", 422, details);
  }
}

class NotFoundError extends AppError {
  constructor(resource, id) {
    super(`${resource} 不存在：${id}`, "NOT_FOUND", 404, [{ resource, id }]);
  }
}

class ConflictError extends AppError {
  constructor(message, details = []) {
    super(message, "CONFLICT", 409, details);
  }
}

module.exports = {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
};
