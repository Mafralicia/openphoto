// Run: npm test. Uses a throwaway library in the OS temp dir; never touches the real one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { ScanEventPayload } from './types.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openphoto-test-'));
process.env.OPENPHOTO_DATA_DIR = path.join(tmp, 'lib');

function findJpg(dir: string): string {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findJpg(p);
      if (hit) return hit;
    } else if (/\.jpe?g$/i.test(e.name)) return p;
  }
  return '';
}

test('library: subfolders, safe deletion, drive relocation, thumbnail backfill', async () => {
  // Env must be set before the DB module evaluates
  const db = await import('./db.ts');
  const { scanDirectory } = await import('./scanner.ts');
  const { queueThumbnailBackfill } = await import('./thumbService.ts');
  const vol = await import('./volumes.ts');

  const jpg = findJpg(path.resolve('sample-photos'));
  assert.ok(jpg, 'needs sample-photos (npx tsx scripts/generateDemoPhotos.ts)');

  const root = path.join(tmp, 'Fotos');
  const place = (rel: string) => {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(jpg, dest);
  };
  place('z.jpg');
  place(path.join('A', 'x.jpg'));
  place(path.join('A', 'B', 'y.jpg'));
  place(path.join('AB', 'w.jpg')); // sibling whose name starts with "A": must not leak into the "A" subtree

  const scan = (p: string) =>
    new Promise<ScanEventPayload[]>((resolve, reject) => {
      const events: ScanEventPayload[] = [];
      scanDirectory(p, (ev) => {
        events.push(ev);
        if (ev.type === 'scan:complete') resolve(events);
        if (ev.type === 'scan:error') reject(new Error(ev.message));
      }).catch(reject);
    });
  const total = (filters: Record<string, unknown>) =>
    db.queryMediaPage({ filters, offset: 0, limit: 100 }).total;
  const moved = path.join(tmp, 'Fotos-novo-disco');
  const items = (folderId: number) => db.queryMediaPage({ filters: { folderId }, offset: 0, limit: 100 }).items;

  try {
    // 1. Nested folders are indexed and exposed as a tree
    await scan(root);
    const folderId = db.listFolders()[0].id;
    assert.equal(total({ folderId }), 4);
    const dirs = db.listFolderDirs(folderId).map((d) => d.dir).sort();
    assert.deepEqual(dirs, ['', 'A', path.join('A', 'B'), 'AB'].sort());
    assert.equal(total({ folderId, dir: 'A' }), 2, '"A" includes A\\B but not AB');
    assert.equal(total({ folderId, dir: path.join('A', 'B') }), 1);
    assert.equal(total({ folderId, dir: 'AB' }), 1);

    // 2. A file deleted on disk disappears on rescan; favorites of the others survive
    const y = items(folderId).find((m) => m.filename === 'y.jpg')!;
    db.setFavorite([y.id], true);
    fs.rmSync(path.join(root, 'z.jpg'));
    const rescan = await scan(root);
    assert.equal(rescan.at(-1)!.removed, 1);
    assert.equal(total({ folderId }), 3);
    assert.equal(db.getMediaById(y.id)!.favorite, 1);

    // 3. Drive gone (root missing): the scan refuses and nothing is deleted
    fs.renameSync(root, moved);
    await assert.rejects(scan(root));
    assert.equal(total({ folderId }), 3);

    // 4. Same files at a new location (what a drive-letter change looks like): relocate keeps
    //    everything and the rescan reads no EXIF again
    db.relocateFolder(folderId, moved);
    const afterMove = await scan(moved);
    assert.ok(!afterMove.some((e) => e.type === 'scan:enriched'), 'no EXIF re-read after relocation');
    assert.equal(afterMove.at(-1)!.removed, 0);
    assert.equal(total({ folderId }), 3);
    assert.equal(db.getMediaById(y.id)!.favorite, 1);
    assert.ok(items(folderId).every((m) => m.path.startsWith(moved + path.sep)));
    assert.equal(db.listFolders()[0].path, moved);

    // 4b. A subfolder renamed on disk keeps its files' favorites and ids (move, not delete+add)
    fs.renameSync(path.join(moved, 'A', 'B'), path.join(moved, 'A', 'C'));
    const afterRename = await scan(moved);
    assert.equal(afterRename.at(-1)!.removed, 0);
    const y2 = db.getMediaById(y.id)!;
    assert.equal(y2.path, path.join(moved, 'A', 'C', 'y.jpg'));
    assert.equal(y2.dir, path.join('A', 'C'));
    assert.equal(y2.favorite, 1);
    assert.equal(total({ folderId }), 3);

    // 4c. Case-only rename (Windows treats it as the same folder): no duplicate rows
    if (process.platform === 'win32') {
      fs.renameSync(path.join(moved, 'AB'), path.join(moved, 'ab-tmp'));
      fs.renameSync(path.join(moved, 'ab-tmp'), path.join(moved, 'ab'));
      await scan(moved);
      assert.equal(total({ folderId }), 3);
      assert.deepEqual(db.listFolderDirs(folderId).map((d) => d.dir).sort(), ['A', path.join('A', 'C'), 'ab'].sort());
    }

    // 5. Volume serial lookup finds the drive this temp dir lives on
    const volumeId = await vol.getVolumeId(tmp);
    if (process.platform === 'win32') {
      assert.ok(volumeId);
      assert.equal(await vol.findVolumeRoot(volumeId!), path.parse(tmp).root);
    }
    assert.equal(vol.pathWithinVolume(path.join(path.parse(tmp).root, 'Fotos', '2024')), path.join('Fotos', '2024'));

    // 6. Background backfill persists every small thumbnail
    await new Promise<void>((resolve) => {
      queueThumbnailBackfill(folderId, moved, (ev) => {
        if (ev.type === 'thumbs:progress' && ev.done === ev.total) resolve();
      });
    });
    assert.ok(items(folderId).every((m) => m.thumb_status === 2));

    // 7. Live Photos: IMG_1.jpg + IMG_1.mp4 (3s) pair up and the clip is hidden; a same-named 6s video
    //    is a real video and stays visible. Needs ffmpeg to synthesize the clips.
    const { readMp4Info } = await import('./exifExtractor.ts');
    const { hasFfmpeg } = await import('./thumbService.ts');
    if (await hasFfmpeg()) {
      const { execFileSync } = await import('node:child_process');
      const clip = (dest: string, seconds: number) =>
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x240:rate=15`, '-pix_fmt', 'yuv420p', '-y', dest]);
      const live = path.join(moved, 'Live');
      fs.mkdirSync(live);
      fs.copyFileSync(jpg, path.join(live, 'IMG_0001.JPG'));
      clip(path.join(live, 'IMG_0001.MP4'), 3);
      fs.copyFileSync(jpg, path.join(live, 'IMG_0002.JPG'));
      clip(path.join(live, 'IMG_0002.MP4'), 6);

      const info = await readMp4Info(path.join(live, 'IMG_0001.MP4'), fs.statSync(path.join(live, 'IMG_0001.MP4')).size);
      assert.ok(info && Math.abs(info.durationMs - 3000) < 100, `duration ${info?.durationMs}`);

      await scan(moved);
      const inLive = db.queryMediaPage({ filters: { folderId, dir: 'Live' }, offset: 0, limit: 10 }).items;
      assert.deepEqual(inLive.map((m) => m.filename).sort(), ['IMG_0001.JPG', 'IMG_0002.JPG', 'IMG_0002.MP4']);
      const photo1 = inLive.find((m) => m.filename === 'IMG_0001.JPG')!;
      assert.ok(photo1.live_video_id, 'IMG_0001 linked to its clip');
      assert.equal(db.getMediaById(photo1.live_video_id!)!.filename, 'IMG_0001.MP4');
      assert.equal(inLive.find((m) => m.filename === 'IMG_0002.JPG')!.live_video_id, null);
      assert.equal(db.listFolders()[0].item_count, 6, 'hidden clip not counted');
    }
  } finally {
    fs.rmSync(moved, { recursive: true, force: true, maxRetries: 5 });
  }
});

after(async () => {
  (await import('./db.ts')).db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

test('library: adding nested folders never steals or loses rows', async () => {
  const db = await import('./db.ts');
  const lib = await import('./library.ts');
  const jpg = findJpg(path.resolve('sample-photos'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openphoto-nested-'));
  for (const rel of ['a.jpg', path.join('2023', 'b.jpg'), path.join('2023', 'x', 'c.jpg'), path.join('2024', 'd.jpg')]) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(jpg, path.join(root, rel));
  }
  const added: number[] = [];
  const addAndWait = (p: string) =>
    new Promise<{ folderId: number; dir: string | null }>((resolve, reject) => {
      let result: { folderId: number; dir: string | null } | null = null;
      lib
        .addFolder(p, (ev) => {
          if (ev.type === 'scan:complete' && result) resolve(result);
        })
        .then((r) => {
          added.push(r.folderId);
          result = r;
          if (r.dir !== null) resolve(r); // nested: no scan happens
        }, reject);
    });

  try {
    // Child first, favorite something, then the parent: the child is folded in, favorite kept
    const child = await addAndWait(path.join(root, '2023'));
    const b = db.queryMediaPage({ filters: { folderId: child.folderId }, offset: 0, limit: 10 }).items.find((m) => m.filename === 'b.jpg')!;
    db.setFavorite([b.id], true);

    const parent = await addAndWait(root);
    assert.notEqual(parent.folderId, child.folderId);
    assert.ok(!db.listFolders().some((f) => f.id === child.folderId), 'child folder merged away');
    const merged = db.getMediaById(b.id)!;
    assert.equal(merged.folder_id, parent.folderId);
    assert.equal(merged.dir, '2023');
    assert.equal(merged.favorite, 1);
    assert.equal(db.queryMediaPage({ filters: { folderId: parent.folderId }, offset: 0, limit: 10 }).total, 4);
    assert.equal(db.queryMediaPage({ filters: { folderId: parent.folderId, dir: '2023' }, offset: 0, limit: 10 }).total, 2);

    // Adding a subfolder of an existing folder just points at it: no new folder, no row moves
    const sub = await addAndWait(path.join(root, '2024'));
    assert.equal(sub.folderId, parent.folderId);
    assert.equal(sub.dir, '2024');
    assert.equal(db.getMediaById(b.id)!.folder_id, parent.folderId);
  } finally {
    for (const id of new Set(added)) lib.forgetFolder(id); // close watchers so the temp dir can go
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
