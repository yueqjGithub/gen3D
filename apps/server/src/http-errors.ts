import { z } from 'zod';
import {
  apiErrorSchema,
  type ApiError,
} from '@agent3d/shared';
import {
  ArtifactNotFoundError,
  ArtifactVersionConflictError,
} from './storage/artifacts';
import {
  ChatTurnConflictError,
  ChatTurnPayloadConflictError,
} from './storage/conversations';
import { UnsupportedInlineImageError } from './attachments/prepare-conversation-input';
import { AgentServiceUnavailableError } from './agent-client';

export type HttpStatus = 400 | 403 | 404 | 409 | 413 | 422 | 500 | 502;

/** 统一的错误响应：HttpError 是路由主动抛出的业务错误，其余异常在 toApiErrorResponse 中按类型映射。 */
export class HttpError extends Error {
  constructor(
    readonly status: HttpStatus,
    readonly code: ApiError['code'],
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface ApiErrorResponse {
  status: HttpStatus;
  body: ApiError;
}

/**
 * 把任意异常转成 HTTP 状态码 + 前端可识别的错误体。
 * 未识别的异常一律返回通用的 500，不泄露内部细节。
 */
export function toApiErrorResponse(error: unknown): ApiErrorResponse {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: apiErrorSchema.parse({
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      }),
    };
  }

  if (error instanceof z.ZodError) {
    return {
      status: 400,
      body: apiErrorSchema.parse({
        code: 'VALIDATION_FAILED',
        message: 'The request did not match the expected format.',
        retryable: false,
      }),
    };
  }

  if (error instanceof AgentServiceUnavailableError) {
    return {
      status: 502,
      body: apiErrorSchema.parse({
        code: 'INTERNAL_ERROR',
        message: 'The Agent service is unavailable. Retry the request.',
        retryable: true,
      }),
    };
  }
  if (error instanceof UnsupportedInlineImageError) {
    return {
      status: 422,
      body: apiErrorSchema.parse({
        code: 'UNSUPPORTED_CAPABILITY',
        message: error.message,
        retryable: false,
      }),
    };
  }
  if (error instanceof ArtifactNotFoundError) {
    return {
      status: 404,
      body: apiErrorSchema.parse({
        code: 'NOT_FOUND',
        message: 'The requested artifact does not exist.',
        retryable: false,
      }),
    };
  }
  if (
    error instanceof ArtifactVersionConflictError
    || error instanceof ChatTurnConflictError
    || error instanceof ChatTurnPayloadConflictError
  ) {
    return {
      status: 409,
      body: apiErrorSchema.parse({
        code: 'CONFLICT',
        message: error.message,
        retryable: error instanceof ChatTurnConflictError,
      }),
    };
  }
  if (error instanceof RangeError) {
    return {
      status: 413,
      body: apiErrorSchema.parse({
        code: 'ATTACHMENT_TOO_LARGE',
        message: 'Attachment or extracted content exceeds the supported size limit.',
        retryable: false,
      }),
    };
  }
  if (error instanceof TypeError) {
    return {
      status: 400,
      body: apiErrorSchema.parse({
        code: 'VALIDATION_FAILED',
        message: error.message,
        retryable: false,
      }),
    };
  }

  return {
    status: 500,
    body: apiErrorSchema.parse({
      code: 'INTERNAL_ERROR',
      message: 'The local API could not complete the request.',
      retryable: false,
    }),
  };
}
