import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// Test fixtures own only the image path they created. Never detach another image.
export const native = (command: string, args: string[], input?: string) => execFileSync(command, args,
  {input, encoding: 'utf8', timeout: 60_000, env: {...process.env, LC_ALL: 'C'}, stdio: ['pipe', 'pipe', 'pipe']});

type ImageAttachment = {'image-path': string; 'system-entities': {'dev-entry': string}[]};
export function imageAttachments(): ImageAttachment[] {
  const plist = native('/usr/bin/hdiutil', ['info', '-plist']);
  const info = JSON.parse(native('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], plist));
  assert.ok(Array.isArray(info.images), 'hdiutil must return an image inventory');
  return info.images;
}

export function canonicalImagePath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  // A failed create may remove the file while its helper still owns the device.
  return existsSync(dirname(path)) ? join(realpathSync(dirname(path)), basename(path)) : resolve(path);
}

export function releaseFixtureImage(dmg: string, {images = imageAttachments(), run = native}:
  {images?: ImageAttachment[]; run?: typeof native} = {}): void {
  const ownedPath = canonicalImagePath(dmg);
  for (const image of images) {
    if (typeof image['image-path'] !== 'string' || canonicalImagePath(image['image-path']) !== ownedPath) continue;
    // Detach only the owning image's base device, not its partitions or APFS
    // synthesized devices. Never force a detach or act on another fixture.
    const device = image['system-entities']?.[0]?.['dev-entry'];
    assert.ok(typeof device === 'string' && /^\/dev\/disk\d+$/.test(device), 'owned image must identify its base device');
    run('/usr/bin/hdiutil', ['detach', device]);
  }
}

