export type Domain = '.douyin.com' | 'www.douyin.com'

export type Path = '/'

export type SameSite = 'no_restriction'

export interface DouyinCookie {
  domain: Domain
  expirationDate?: number
  hostOnly: boolean
  httpOnly: boolean
  name: string
  path: Path
  sameSite: SameSite | null
  secure: boolean
  session: boolean
  storeId: null
  value: string
}
