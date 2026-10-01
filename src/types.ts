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
}
