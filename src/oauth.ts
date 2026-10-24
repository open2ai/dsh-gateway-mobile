/**
 * Optional GitHub / Gitee OAuth 2.0 (authorization-code) binding.
 *
 * The gateway terminates the callback locally and binds the provider identity
 * to a device record. Client secrets never leave the host process and are not
 * persisted by this module.
 *
 * @module dsh-gateway-mobile/lib/oauth
 */

import { CODES, GatewayError } from './errors.js'
import { base64urlDecode, base64urlEncode, escapeHtml, timingSafeEqualString } from './util.js'
import type { GatewayConfig } from './config.js'
import type { DeviceManager, OAuthBinding } from './devices.js'
import type { Logger } from './logger.js'
import type { SecretBox } from './store.js'

export type OAuthProvider = 'github' | 'gitee'

interface ProviderEndpoints {
  authorize: string
  token: string
  user: string
  scope: string
}

const PROVIDERS: Readonly<Record<OAuthProvider, ProviderEndpoints>> = {
  github: {
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    user: 'https://api.github.com/user',
    scope: 'read:user',
  },
  gitee: {
    authorize: 'https://gitee.com/oauth/authorize',
    token: 'https://gitee.com/oauth/token',
    user: 'https://gitee.com/api/v5/user',
    scope: 'user_info',
  },
}

interface OAuthState {
  v: 1
  provider: OAuthProvider
  deviceId: string
  exp: number
  nonce: string
}

interface TokenResponse {
  access_token?: string
  error?: string
  error_description?: string
}

interface ProviderUser {
  login?: string
  name?: string
  username?: string
  id?: string | number
  avatar_url?: string
}

export interface OAuthManagerOptions {
  config: GatewayConfig
  logger: Logger
  devices: DeviceManager
  box: SecretBox
  publicBase: () => string
}

function isProvider(value: string): value is OAuthProvider {
  return value === 'github' || value === 'gitee'
}

export class OAuthManager {
  box: SecretBox
  config: GatewayConfig
  devices: DeviceManager
  logger: Logger
  publicBase: () => string

  constructor(options: OAuthManagerOptions) {
    this.config = options.config
    this.logger = options.logger
    this.devices = options.devices
    this.box = options.box
    this.publicBase = options.publicBase
  }

  /** Providers that are both enabled in config and have credentials. */
  enabledProviders(): OAuthProvider[] {
    return this.config.auth.oauthProviders.filter((provider): provider is OAuthProvider => {
      if (!isProvider(provider)) return false
      if (provider === 'github') return Boolean(this.config.auth.githubClientId && this.config.auth.githubClientSecret)
      if (provider === 'gitee') return Boolean(this.config.auth.giteeClientId && this.config.auth.giteeClientSecret)
      return false
    })
  }

  #credentials(provider: OAuthProvider): { clientId: string; clientSecret: string } {
    if (!isProvider(provider)) throw new GatewayError(CODES.OAUTH_NOT_CONFIGURED)
    if (provider === 'github') {
      if (!this.config.auth.githubClientId || !this.config.auth.githubClientSecret) throw new GatewayError(CODES.OAUTH_NOT_CONFIGURED)
      return { clientId: this.config.auth.githubClientId, clientSecret: this.config.auth.githubClientSecret }
    }
    if (!this.config.auth.giteeClientId || !this.config.auth.giteeClientSecret) throw new GatewayError(CODES.OAUTH_NOT_CONFIGURED)
    return { clientId: this.config.auth.giteeClientId, clientSecret: this.config.auth.giteeClientSecret }
  }

  redirectUri(provider: OAuthProvider): string {
    return `${this.publicBase().replace(/\/+$/, '')}/auth/${provider}/callback`
  }

  authorizeUrl(provider: OAuthProvider, deviceId: string): string {
    const credentials = this.#credentials(provider)
    const state = this.#signState({ provider, deviceId })
    const url = new URL(PROVIDERS[provider].authorize)
    url.searchParams.set('client_id', credentials.clientId)
    url.searchParams.set('redirect_uri', this.redirectUri(provider))
    url.searchParams.set('scope', PROVIDERS[provider].scope)
    url.searchParams.set('state', state)
    return url.toString()
  }

  #signState(input: { provider: OAuthProvider; deviceId: string }): string {
    const payload: OAuthState = {
      v: 1,
      provider: input.provider,
      deviceId: input.deviceId,
      exp: Date.now() + 10 * 60 * 1000,
      nonce: base64urlEncode(String(Math.random())),
    }
    const encoded = base64urlEncode(JSON.stringify(payload))
    return `${encoded}.${this.box.hmac(encoded)}`
  }

  #verifyState(state: string, expectedProvider: OAuthProvider): OAuthState {
    if (typeof state !== 'string') throw new GatewayError(CODES.INVALID_OAUTH_STATE)
    const dot = state.indexOf('.')
    if (dot <= 0) throw new GatewayError(CODES.INVALID_OAUTH_STATE)
    const encoded = state.slice(0, dot)
    const signature = state.slice(dot + 1)
    if (!timingSafeEqualString(signature, this.box.hmac(encoded))) throw new GatewayError(CODES.INVALID_OAUTH_STATE)
    let parsed: unknown
    try {
      parsed = JSON.parse(base64urlDecode(encoded))
    } catch {
      throw new GatewayError(CODES.INVALID_OAUTH_STATE)
    }
    const payload = parsed as Partial<OAuthState>
    if (!payload || payload.v !== 1 || payload.provider !== expectedProvider || Date.now() > Number(payload.exp)) {
      throw new GatewayError(CODES.INVALID_OAUTH_STATE)
    }
    return payload as OAuthState
  }

  /**
   * Exchange the authorization code and bind the provider identity.
   */
  async handleCallback(provider: OAuthProvider, code: string, state: string): Promise<{ binding: OAuthBinding; deviceId: string }> {
    if (!isProvider(provider)) throw new GatewayError(CODES.OAUTH_NOT_CONFIGURED)
    const payload = this.#verifyState(state, provider)
    const binding = await this.#exchangeAndFetch(provider, code)
    this.devices.bindOAuth(payload.deviceId, binding)
    return { binding, deviceId: payload.deviceId }
  }

  /**
   * Callback for the SPA flow (code + state posted by the page).
   */
  async callbackFromClient(input: { provider: string; code: string; state: string }): Promise<{ binding: OAuthBinding; deviceId: string }> {
    if (!isProvider(input.provider)) throw new GatewayError(CODES.OAUTH_NOT_CONFIGURED)
    return this.handleCallback(input.provider, input.code, input.state)
  }

  async #exchangeAndFetch(provider: OAuthProvider, code: string): Promise<OAuthBinding> {
    const credentials = this.#credentials(provider)
    let tokenResponse: TokenResponse
    try {
      const body = new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        code,
        redirect_uri: this.redirectUri(provider),
      })
      if (provider === 'gitee') body.set('grant_type', 'authorization_code')
      const response = await fetch(PROVIDERS[provider].token, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(20_000),
      })
      const text = await response.text()
      tokenResponse = JSON.parse(text) as TokenResponse
      if (!response.ok || tokenResponse.error || !tokenResponse.access_token) {
        const message = String(tokenResponse.error_description ?? tokenResponse.error ?? `HTTP ${response.status}`)
        if (/redirect_uri/i.test(message)) throw new GatewayError(CODES.REDIRECT_URI_MISMATCH, {}, 400, message)
        throw new GatewayError(CODES.OAUTH_TOKEN_EXCHANGE_FAILED, {}, 400, message)
      }
    } catch (error) {
      if (error instanceof GatewayError) throw error
      throw new GatewayError(CODES.OAUTH_TOKEN_EXCHANGE_FAILED, {}, 400, (error as Error)?.message)
    }

    let user: ProviderUser
    try {
      const response = await fetch(PROVIDERS[provider].user, {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${tokenResponse.access_token}`,
        },
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      user = (await response.json()) as ProviderUser
    } catch (error) {
      throw new GatewayError(CODES.OAUTH_USER_INFO_FAILED, {}, 400, (error as Error)?.message)
    }
    const username = String(user.login ?? user.name ?? user.username ?? '').trim()
    const providerUserId = String(user.id ?? user.login ?? '').trim()
    if (!username || !providerUserId) throw new GatewayError(CODES.OAUTH_USER_INFO_FAILED, {}, 400, 'user info missing id/login')
    return {
      provider,
      providerUserId,
      username,
      avatarUrl: String(user.avatar_url ?? '').slice(0, 512),
      boundAt: Date.now(),
    }
  }

  unbind(deviceId: string, provider: OAuthProvider): ReturnType<DeviceManager['unbindOAuth']> {
    return this.devices.unbindOAuth(deviceId, provider)
  }

  /** HTML page returned by the OAuth callback popup. */
  callbackPage({ ok, provider, username = '', message = '' }: { ok: boolean; provider: string; username?: string; message?: string }): string {
    const title = ok ? '绑定成功' : '绑定失败'
    const detail = ok ? `已绑定 ${escapeHtml(provider)} 账号 ${escapeHtml(username)}` : escapeHtml(message)
    const script = `if (window.opener) { window.opener.postMessage({ type: 'dsh-oauth', ok: ${ok ? 'true' : 'false'}, provider: ${JSON.stringify(provider)} }, '*'); } if (${ok ? 'true' : 'false'}) { setTimeout(function(){ window.close() }, 800); }`
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{margin:0;background:#0D0D0F;color:#E8E8EC;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;display:grid;place-items:center;min-height:100vh}.card{background:#161618;border:1px solid #1E1E20;border-radius:12px;padding:24px;max-width:320px;text-align:center}.ok{color:#34D399}.err{color:#F87171}a{color:#4F8FFF}</style>
</head><body><div class="card"><h1 style="font-size:20px;margin:0 0 12px">${title}</h1><p class="${ok ? 'ok' : 'err'}">${detail}</p><p><a href="/mobile/">返回</a></p></div>
<script>${script}</script></body></html>`
  }
}
