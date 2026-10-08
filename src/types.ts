export interface BrowserExtension {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
}

export type BrowserName = 'edge' | 'msedge' | 'chrome';

export interface ListExtensionsOptions {
  browser?: BrowserName;
}

export interface ReloadExtensionOptions extends ListExtensionsOptions {
  name?: string;
  id?: string;
  /** false 时跳过缓存读取，查询成功并完成重载后更新缓存。 */
  cache?: boolean;
}
