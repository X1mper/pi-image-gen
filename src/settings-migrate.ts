import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import {
  canonicalProviderRouteId, IMAGE_CONFIG_VERSION, listProviderRoutes,
  normalizeImageGenSettings, resolveModel, validateImageConfigVersion,
} from './config.js';
import { ImageGenError } from './errors.js';
import { findBuiltInModel } from './models.js';
import { imageSettingsFiles, type ImageSettingsScope } from './settings-paths.js';
import type { ImageGenSettings, ImageRouteSelection } from './types.js';

const KEY = 'pi-image-gen';
export type MigrationScope = ImageSettingsScope | 'all';
export type ImageSettingsMigration = {
  scope: ImageSettingsScope;
  path: string;
  status: 'migrated' | 'would-migrate' | 'unchanged' | 'missing' | 'blocked' | 'error';
  message: string;
  backupPath?: string;
};

/** Explicit per-file operation. Never consumes merged settings or returns secret values. */
export async function migrateImageGenSettings(options: {
  cwd: string;
  projectTrusted: boolean;
  scope?: MigrationScope;
  dryRun?: boolean;
}): Promise<ImageSettingsMigration[]> {
  const selected = imageSettingsFiles(options.cwd).filter((file) => !options.scope || options.scope === 'all' || file.scope === options.scope);
  const seen = new Set<string>();
  const reports: ImageSettingsMigration[] = [];
  for (const file of selected) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    if (file.scope === 'project' && !options.projectTrusted) {
      reports.push({ ...file, status: 'blocked', message: 'Project settings are not trusted; this file was not read or changed.' });
      continue;
    }
    reports.push(await withFileMutationQueue(file.path, () => migrateFile(file, options.dryRun === true, options)));
  }
  return reports;
}

async function migrateFile(file: { scope: ImageSettingsScope; path: string }, dryRun: boolean, context: { cwd: string; projectTrusted: boolean }): Promise<ImageSettingsMigration> {
  let original: Buffer;
  let mode: number;
  try {
    if ((await lstat(dirname(file.path))).isSymbolicLink()) return { ...file, status: 'blocked', message: 'The settings directory must not be a symbolic link.' };
    if (!(await lstat(file.path)).isFile()) return { ...file, status: 'blocked', message: 'Settings must be a regular non-symlink file.' };
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile()) return { ...file, status: 'blocked', message: 'Settings must be a regular non-symlink file.' };
      mode = info.mode & 0o777;
      original = await handle.readFile();
    } finally { await handle.close(); }
  } catch (error) {
    return { ...file, status: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'error', message: 'Settings file was not read or changed (missing, unreadable, or a symbolic link).' };
  }
  let root: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(original));
    if (!isRecord(parsed)) throw new Error();
    root = parsed;
  } catch { return { ...file, status: 'blocked', message: 'Settings must contain a valid UTF-8 JSON object; no changes made.' }; }
  if (!Object.hasOwn(root, KEY)) return { ...file, status: 'unchanged', message: 'No pi-image-gen namespace; nothing to migrate.' };
  if (!isRecord(root[KEY])) return { ...file, status: 'blocked', message: 'pi-image-gen must be an object; no changes made.' };

  let section: Record<string, unknown>;
  try { section = await migrateSection(root[KEY], file.path, context); }
  catch (error) {
    return { ...file, status: 'blocked', message: error instanceof ImageGenError ? error.message : 'Configuration could not be migrated safely; no changes made.' };
  }
  if (JSON.stringify(section) === JSON.stringify(root[KEY])) return { ...file, status: 'unchanged', message: 'Already version 2 with no legacy default keys to remove.' };
  const message = 'Set version 2; convert complete legacy defaults and remove obsolete default keys. Other settings and environment placeholders are preserved.';
  if (dryRun) return { ...file, status: 'would-migrate', message };

  const backupPath = `${file.path}.pi-image-gen-backup-${randomUUID()}.bak`;
  const temporary = join(dirname(file.path), `.settings.json.pi-image-gen-${randomUUID()}`);
  let backupCreated = false;
  let tempCreated = false;
  try {
    const backup = await open(backupPath, 'wx', 0o600);
    backupCreated = true;
    try { await backup.chmod(0o600); await backup.writeFile(original); } finally { await backup.close(); }
    const temp = await open(temporary, 'wx', mode);
    tempCreated = true;
    try {
      await temp.writeFile(`${JSON.stringify({ ...root, [KEY]: section }, null, 2)}\n`, 'utf8');
      await temp.chmod(mode); // Preserve permissions even under a more restrictive umask.
    }
    finally { await temp.close(); }
    if ((await lstat(dirname(file.path))).isSymbolicLink() || !(await lstat(file.path)).isFile()) throw new Error();
    if (!(await readFile(file.path)).equals(original)) {
      return { ...file, status: 'blocked', backupPath, message: 'Settings changed during migration; the current file was not replaced. The original snapshot backup is retained.' };
    }
    await rename(temporary, file.path);
    tempCreated = false;
    return { ...file, status: 'migrated', backupPath, message };
  } catch {
    return { ...file, status: 'error', ...(backupCreated ? { backupPath } : {}), message: 'Could not complete the backup and atomic replacement. The source was not intentionally overwritten; inspect the file and any backup before retrying.' };
  } finally {
    if (tempCreated) { try { await unlink(temporary); } catch { /* Best-effort temporary cleanup only. */ } }
  }
}

async function migrateSection(raw: Record<string, unknown>, path: string, context: { cwd: string; projectTrusted: boolean }): Promise<Record<string, unknown>> {
  validateImageConfigVersion(raw.version);
  const next = { ...raw };
  if (raw.default !== undefined) {
    normalizeImageGenSettings(raw as ImageGenSettings); // Existing nested pair already has precedence.
  } else if (Object.hasOwn(raw, 'defaultProvider') || Object.hasOwn(raw, 'defaultModel')) {
    if (typeof raw.defaultModel !== 'string' || !raw.defaultModel.trim()) {
      throw new ImageGenError('This file has an incomplete legacy default. Add a complete provider/model default in this file before migrating; inherited values are not copied.', 'incomplete legacy image default');
    }
    if (raw.defaultProvider !== undefined && (typeof raw.defaultProvider !== 'string' || !raw.defaultProvider.trim())) {
      throw new ImageGenError('The legacy defaultProvider must be a non-empty string; no changes made.', 'invalid legacy image provider');
    }
    if (raw.defaultProvider === undefined && !(await modelInferenceIsIsolated(path, context.cwd, context.projectTrusted))) {
      throw new ImageGenError('This model-only default interacts with defaults or custom providers in another settings layer. Add an explicit same-file provider/model pair before migrating; inherited routing is not guessed or copied.', 'layered legacy image route');
    }
    next.default = raw.defaultProvider !== undefined
      ? { provider: raw.defaultProvider, model: raw.defaultModel }
      : inferRoute(raw.defaultModel.trim(), raw as ImageGenSettings);
  }
  delete next.defaultProvider;
  delete next.defaultModel;
  next.version = IMAGE_CONFIG_VERSION;
  return next;
}

/** Adding an inferred provider must not alter another layer's legacy routing. */
async function modelInferenceIsIsolated(target: string, cwd: string, projectTrusted: boolean): Promise<boolean> {
  const seen = new Set<string>([target]);
  for (const file of imageSettingsFiles(cwd)) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    if (file.scope === 'project' && !projectTrusted) return false;
    try {
      if ((await lstat(dirname(file.path))).isSymbolicLink() || !(await lstat(file.path)).isFile()) return false;
      const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes: Buffer;
      try {
        if (!(await handle.stat()).isFile()) return false;
        bytes = await handle.readFile();
      } finally { await handle.close(); }
      const root: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!isRecord(root)) return false;
      const section = root[KEY];
      if (section === undefined) continue;
      if (!isRecord(section)) return false;
      validateImageConfigVersion(section.version);
      if (['default', 'defaultProvider', 'defaultModel'].some((key) => Object.hasOwn(section, key))) return false;
      if (section.customProviders !== undefined && (!isRecord(section.customProviders) || Object.keys(section.customProviders).length > 0)) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return false;
    }
  }
  return true;
}

/** Preserve the actual legacy wire model as well as the provider when adding a pair. */
function inferRoute(model: string, settings: ImageGenSettings): ImageRouteSelection {
  const provider = inferProvider(model, settings);
  const legacy = resolveModel(model, settings);
  if (!('error' in legacy)) {
    for (const candidate of new Set([model, legacy.remoteId])) {
      const scoped = resolveModel(candidate, { ...settings, defaultProvider: provider });
      if (!('error' in scoped) && scoped.provider.id === legacy.provider.id &&
          scoped.provider.builtIn === legacy.provider.builtIn && scoped.remoteId === legacy.remoteId) {
        return { provider, model: candidate };
      }
    }
  }
  throw new ImageGenError('Cannot preserve the legacy remote model when adding an explicit provider. Configure the equivalent provider/model pair before migrating.', 'ambiguous legacy image model');
}

/** Infer only deterministic same-file legacy routing, never from live credentials. */
function inferProvider(model: string, settings: ImageGenSettings): string {
  const blocked = (): never => { throw new ImageGenError('Cannot infer one provider from this file without guessing. Add an explicit defaultProvider (or a complete default pair), then migrate again. Legacy Meta auto-auth and environment-dependent choices require an explicit route.', 'ambiguous legacy image route'); };
  if (model.includes('$')) return blocked();
  const routes = listProviderRoutes(settings);
  const explicitCustom = routes.filter((route) => route.authentication === 'custom' && route.modelIds.length > 0 &&
    !('error' in resolveModel(model, { ...settings, defaultProvider: route.id })));
  if (explicitCustom.length > 1) return blocked();
  if (explicitCustom[0]) return explicitCustom[0].id;
  const known = findBuiltInModel(model);
  const catchAll = routes.filter((route) => route.authentication === 'custom' && route.acceptsAnyModel);
  if (known) {
    if (known.provider !== 'codex' && known.provider !== 'meta' && catchAll.length) return blocked();
    if (known.provider === 'meta') return blocked();
    return routes.find((route) => route.authentication !== 'custom' && route.providerId === known.provider)?.id ?? blocked();
  }
  const slash = model.indexOf('/');
  if (slash > 0) {
    const prefix = canonicalProviderRouteId(model.slice(0, slash), settings);
    if (prefix) {
      const resolved = resolveModel(model, settings);
      if (!('error' in resolved)) {
        if (!resolved.provider.builtIn) return resolved.provider.id;
        if (resolved.provider.id === 'meta') return blocked();
        return routes.find((route) => route.authentication !== 'custom' && route.providerId === resolved.provider.id)?.id ?? blocked();
      }
    }
  }
  return catchAll.length === 1 ? catchAll[0]!.id : blocked();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
