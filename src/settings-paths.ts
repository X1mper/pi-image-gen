import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { resolveConfigDir } from '@amaster.ai/pi-shared/settings';

export type ImageSettingsScope = 'global' | 'agent' | 'project';
export type ImageSettingsFile = { scope: ImageSettingsScope; path: string };

/** Same paths and priority as pi-shared's loader; callers deduplicate selected paths. */
export function imageSettingsFiles(cwd: string): ImageSettingsFile[] {
  return [
    { scope: 'global', path: resolve(homedir(), '.pi', 'agent', 'settings.json') },
    { scope: 'agent', path: resolve(resolveConfigDir(), 'settings.json') },
    { scope: 'project', path: resolve(cwd, '.pi', 'settings.json') },
  ];
}
