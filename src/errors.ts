/**
 * Error codes and bilingual messages shared by the gateway API.
 *
 * Codes follow the product document:
 *   0 success, 1xxx client, 2xxx auth, 3xxx authorization, 4xxx business, 5xxx server.
 *
 * @module dsh-gateway-mobile/lib/errors
 */

export const CODES = Object.freeze({
  SUCCESS: 0,
  INVALID_PARAMS: 1001,
  INVALID_PAIRING_CODE: 1002,
  INVALID_DEVICE_ID: 1003,
  INVALID_OAUTH_STATE: 1004,
  INVALID_CONFIRM_TEXT: 1005,
  DEVICE_LIMIT_REACHED: 1006,
  CSRF_FAILED: 1007,
  NOT_SUPPORTED: 1008,

  UNAUTHENTICATED: 2001,
  SESSION_EXPIRED: 2002,
  SESSION_INVALID: 2003,
  PAIRING_TOKEN_EXPIRED: 2004,
  PAIRING_TOKEN_USED: 2005,

  DEVICE_REVOKED: 3001,
  DEVICE_EXPIRED: 3002,
  PERMISSION_DENIED: 3003,
  OAUTH_REQUIRED: 3004,

  RATE_LIMITED: 4001,
  PAIRING_FAILED: 4002,
  OAUTH_CALLBACK_ERROR: 4003,
  OAUTH_TOKEN_EXCHANGE_FAILED: 4004,
  OAUTH_USER_INFO_FAILED: 4005,
  REDIRECT_URI_MISMATCH: 4006,
  TUNNEL_NOT_CONNECTED: 4007,
  OAUTH_NOT_CONFIGURED: 4008,
  DEVICE_NOT_DELETABLE: 4009,

  INTERNAL_ERROR: 5001,
  TUNNEL_START_FAILED: 5002,
  PROXY_ERROR: 5003,
  STORAGE_ERROR: 5004,
  CLOUDFLARED_DOWNLOAD_FAILED: 5005,
})

export type Language = 'zh' | 'en'
export type GatewayErrorCode = (typeof CODES)[keyof typeof CODES]

export interface ApiMessage {
  zh: string
  en: string
}

export interface ApiBody {
  code: number
  message: string
  data: Record<string, unknown>
}

const MESSAGES: Readonly<Record<number, ApiMessage>> = Object.freeze({
  [CODES.SUCCESS]: { zh: '成功', en: 'success' },
  [CODES.INVALID_PARAMS]: { zh: '参数缺失或格式错误', en: 'Missing or invalid parameter' },
  [CODES.INVALID_PAIRING_CODE]: { zh: '配对码格式无效', en: 'Invalid pairing code format' },
  [CODES.INVALID_DEVICE_ID]: { zh: '设备 ID 无效', en: 'Invalid device id' },
  [CODES.INVALID_OAUTH_STATE]: { zh: 'OAuth state 校验失败', en: 'OAuth state validation failed' },
  [CODES.INVALID_CONFIRM_TEXT]: { zh: '确认文本不匹配', en: 'Confirmation text does not match' },
  [CODES.DEVICE_LIMIT_REACHED]: { zh: '设备数量已达上限', en: 'Device limit reached' },
  [CODES.CSRF_FAILED]: { zh: '缺少防 CSRF 请求头', en: 'Missing CSRF request header' },
  [CODES.NOT_SUPPORTED]: { zh: '该功能在当前版本未提供', en: 'This feature is not available in this version' },

  [CODES.UNAUTHENTICATED]: { zh: '未认证', en: 'Unauthenticated' },
  [CODES.SESSION_EXPIRED]: { zh: '会话已过期', en: 'Session expired' },
  [CODES.SESSION_INVALID]: { zh: '会话无效', en: 'Invalid session' },
  [CODES.PAIRING_TOKEN_EXPIRED]: { zh: '配对令牌已过期', en: 'Pairing token expired' },
  [CODES.PAIRING_TOKEN_USED]: { zh: '配对令牌已被使用', en: 'Pairing token already used' },

  [CODES.DEVICE_REVOKED]: { zh: '设备已被撤销', en: 'Device revoked' },
  [CODES.DEVICE_EXPIRED]: { zh: '设备已静默过期', en: 'Device expired' },
  [CODES.PERMISSION_DENIED]: { zh: '权限不足', en: 'Permission denied' },
  [CODES.OAUTH_REQUIRED]: { zh: '需要完成 OAuth 绑定', en: 'OAuth binding required' },

  [CODES.RATE_LIMITED]: { zh: '请求过于频繁，请稍后重试', en: 'Too many requests, retry later' },
  [CODES.PAIRING_FAILED]: { zh: '配对码错误，请重试', en: 'Pairing failed, check the code' },
  [CODES.OAUTH_CALLBACK_ERROR]: { zh: 'OAuth 回调失败', en: 'OAuth callback failed' },
  [CODES.OAUTH_TOKEN_EXCHANGE_FAILED]: { zh: '授权失败，请重试', en: 'OAuth token exchange failed' },
  [CODES.OAUTH_USER_INFO_FAILED]: { zh: '获取账号信息失败', en: 'Failed to fetch OAuth user info' },
  [CODES.REDIRECT_URI_MISMATCH]: { zh: '回调地址不匹配，请检查开放平台配置', en: 'Redirect URI mismatch' },
  [CODES.TUNNEL_NOT_CONNECTED]: { zh: '隧道未连接，服务暂不可用', en: 'Tunnel is not connected' },
  [CODES.OAUTH_NOT_CONFIGURED]: { zh: '该 OAuth 提供商未配置', en: 'OAuth provider is not configured' },
  [CODES.DEVICE_NOT_DELETABLE]: { zh: '只能永久删除已撤销或已过期的设备', en: 'Only revoked or expired devices can be deleted' },

  [CODES.INTERNAL_ERROR]: { zh: '服务异常', en: 'Internal error' },
  [CODES.TUNNEL_START_FAILED]: { zh: '隧道启动失败', en: 'Tunnel failed to start' },
  [CODES.PROXY_ERROR]: { zh: '代理转发失败', en: 'Proxy error' },
  [CODES.STORAGE_ERROR]: { zh: '配置存储异常', en: 'Storage error' },
  [CODES.CLOUDFLARED_DOWNLOAD_FAILED]: { zh: 'cloudflared 下载失败', en: 'cloudflared download failed' },
})

const HTTP_STATUS: Readonly<Record<number, number>> = Object.freeze({
  [CODES.SUCCESS]: 200,
  [CODES.INVALID_PARAMS]: 400,
  [CODES.INVALID_PAIRING_CODE]: 400,
  [CODES.INVALID_DEVICE_ID]: 400,
  [CODES.INVALID_OAUTH_STATE]: 400,
  [CODES.INVALID_CONFIRM_TEXT]: 400,
  [CODES.DEVICE_LIMIT_REACHED]: 403,
  [CODES.CSRF_FAILED]: 403,
  [CODES.NOT_SUPPORTED]: 501,
  [CODES.UNAUTHENTICATED]: 401,
  [CODES.SESSION_EXPIRED]: 401,
  [CODES.SESSION_INVALID]: 401,
  [CODES.PAIRING_TOKEN_EXPIRED]: 410,
  [CODES.PAIRING_TOKEN_USED]: 409,
  [CODES.DEVICE_REVOKED]: 403,
  [CODES.DEVICE_EXPIRED]: 403,
  [CODES.PERMISSION_DENIED]: 403,
  [CODES.OAUTH_REQUIRED]: 403,
  [CODES.RATE_LIMITED]: 429,
  [CODES.PAIRING_FAILED]: 400,
  [CODES.OAUTH_CALLBACK_ERROR]: 400,
  [CODES.OAUTH_TOKEN_EXCHANGE_FAILED]: 400,
  [CODES.OAUTH_USER_INFO_FAILED]: 400,
  [CODES.REDIRECT_URI_MISMATCH]: 400,
  [CODES.TUNNEL_NOT_CONNECTED]: 503,
  [CODES.OAUTH_NOT_CONFIGURED]: 400,
  [CODES.DEVICE_NOT_DELETABLE]: 409,
  [CODES.INTERNAL_ERROR]: 500,
  [CODES.TUNNEL_START_FAILED]: 500,
  [CODES.PROXY_ERROR]: 502,
  [CODES.STORAGE_ERROR]: 500,
  [CODES.CLOUDFLARED_DOWNLOAD_FAILED]: 500,
})

/** An error carrying a product error code and optional structured data. */
export class GatewayError extends Error {
  code: number
  data: Record<string, unknown>
  detail: string
  httpStatus: number

  constructor(
    code: number,
    data: Record<string, unknown> = {},
    httpStatus?: number,
    detail = '',
  ) {
    super(detail || `gateway error ${code}`)
    this.name = 'GatewayError'
    this.code = code
    this.data = data
    this.httpStatus = httpStatus ?? HTTP_STATUS[code] ?? 500
    this.detail = detail
  }
}

export function languageOf(acceptLanguage?: string): Language {
  if (!acceptLanguage) return 'zh'
  return /^en\b/i.test(acceptLanguage.trim()) || /\ben\b/i.test(acceptLanguage) ? 'en' : 'zh'
}

export function messageFor(code: number, lang: Language = 'zh'): string {
  const entry = MESSAGES[code]
  if (!entry) return lang === 'en' ? 'Unknown error' : '未知错误'
  return entry[lang]
}

export function successBody(code = CODES.SUCCESS, data: Record<string, unknown> = {}): ApiBody {
  return { code, message: messageFor(code), data }
}

export function errorBody(code: number, data: Record<string, unknown> = {}, lang: Language = 'zh'): ApiBody {
  return { code, message: messageFor(code, lang), data }
}

export function httpStatusFor(code: number): number {
  return HTTP_STATUS[code] ?? 500
}

export function isGatewayErrorCode(code: number): boolean {
  return (Object.values(CODES) as number[]).includes(code)
}
