import { contextBridge, ipcRenderer, webUtils } from 'electron';

// The only native capabilities the UI gets. Media is addressed by id; the main process resolves paths from the DB.
contextBridge.exposeInMainWorld('openphoto', {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('pick-folder'),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  reveal: (id: number): Promise<void> => ipcRenderer.invoke('media:reveal', id),
  openExternal: (id: number): Promise<void> => ipcRenderer.invoke('media:open', id),
  trash: (ids: number[]): Promise<number> => ipcRenderer.invoke('media:trash', ids),
  onUpdateReady: (cb: (version: string) => void): void => {
    ipcRenderer.on('update:ready', (_e, version: string) => cb(version));
  },
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
});
