import { type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  wait,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';
import {
  isEditorTarget,
  launchDesktopApp,
  materializeDesktopApp,
  NEEDS_VISIBLE_WINDOW_ON_CI,
} from './support/desktopApp.js';

/**
 * Cmd+Shift+V in a text box pastes the clipboard's text without the
 * formatting it was copied with, in the Web UI and in the desktop app.
 *
 * Chromium binds Paste and Match Style to Ctrl+Shift+V off macOS and to
 * Cmd+Option+Shift+V on it, so on a Mac the shorter chord did nothing; and
 * its plain paste left multi-line text as raw newlines in one paragraph.
 * CDP modifiers: Alt 1, Ctrl 2, Meta 4, Shift 8.
 */

const META_SHIFT = 4 | 8;
const CTRL_SHIFT = 2 | 8;
const PASTE_MODIFIER = process.platform === 'darwin' ? 4 : 2;
const STYLED_HTML = '<span style="font-weight: 700; color: rgb(255, 0, 0)">Loud words</span>';
const STYLED_TEXT = 'Loud words';
const BOXES = ['box-a', 'box-b', 'box-c'];

let workDir = '';
let appProcess: ChildProcess | null = null;
let editor: Cdp | null = null;
let server: RunningCollabServer | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(appProcess);
  appProcess = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

function fixtureDeck(): Deck {
  const deck = emptyDeck('Plain paste');
  BOXES.forEach((id, index) => {
    deck.slides[0].elements.push({
      id, type: 'text', x: 100, y: 80 + index * 300, w: 1200, h: 220, rot: 0, z: index + 1, opacity: 1,
      class: [], style: {}, html: 'Before', align: 'left', valign: 'top',
    } as never);
  });
  return deck;
}

const box = (id: string) => `#canvas [data-element-id="${id}"]`;

async function setClipboard(html: string | null, text: string): Promise<void> {
  await editor!.evaluate(`(async () => {
    const parts = { 'text/plain': new Blob([${JSON.stringify(text)}], { type: 'text/plain' }) };
    ${html === null ? '' : `parts['text/html'] = new Blob([${JSON.stringify(html)}], { type: 'text/html' });`}
    await navigator.clipboard.write([new ClipboardItem(parts)]);
  })()`);
}

/** Open a box for editing with all of its text selected. */
async function editAll(id: string): Promise<void> {
  await editor!.doubleClick(`${box(id)} .text-content`, id);
  await eventually(
    async () => editor!.evaluate<boolean>(`document.querySelector('${box(id)} .text-content')?.isContentEditable === true`),
    `${id} did not open for editing`,
  );
  await editor!.chord('a', 'KeyA', 65, PASTE_MODIFIER, ['selectAll']);
}

/** Leave the box and read back what it stored. */
async function closeAndRead(id: string): Promise<string> {
  await wait(300);
  await editor!.key('Escape', 27);
  return eventually(
    async () => editor!.evaluate<string>(`document.querySelector('${box(id)} .text-content')?.innerHTML ?? ''`),
    `${id} did not render after editing`,
    (html) => !html.includes('contenteditable'),
  );
}

async function openWebUi(): Promise<void> {
  workDir = await mkdtemp(join(tmpdir(), 'paste-plain-web-'));
  const decksRoot = join(workDir, 'decks');
  const deckDir = join(decksRoot, 'plain-paste');
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(deckDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await saveDeck(deckDir, fixtureDeck());
  await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; color: #111; font: 400 48px/1.3 sans-serif; }\n', 'utf8');
  server = await startCollabServer({ rootDir: decksRoot, clientDir: await collabClientDir(), host: '127.0.0.1', port: 0 });
  const browser = await launchBrowser(`http://127.0.0.1:${server.port}/?deck=plain-paste&name=P`, profileDir);
  appProcess = browser.process;
  const target = await findTarget(browser.debugPort, (c) => c.url.includes('deck=plain-paste'), browser.log);
  editor = await Cdp.connect(target.webSocketDebuggerUrl!);
  await editor.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await editor.call('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => {});
  await eventually(async () => editor!.evaluate<boolean>(`Boolean(document.querySelector('${box('box-c')}'))`), 'no fixture');
}

describe.skipIf(!electronBinary)('Cmd+Shift+V pastes text without its formatting', () => {
  it('Web UI: drops the copied formatting, as one undo step, where Cmd+V keeps it', { timeout: 120_000 }, async () => {
    await openWebUi();

    await setClipboard(STYLED_HTML, STYLED_TEXT);
    await editAll('box-a');
    await editor!.chord('v', 'KeyV', 86, PASTE_MODIFIER, ['paste']);
    const control = await closeAndRead('box-a');
    expect(control, 'soundness: an ordinary paste keeps the bold').toMatch(/font-weight:\s*700/);

    await setClipboard(STYLED_HTML, STYLED_TEXT);
    await editAll('box-b');
    await editor!.chord('V', 'KeyV', 86, META_SHIFT);
    await eventually(
      async () => editor!.evaluate<string>(`document.querySelector('${box('box-b')} .text-content')?.textContent ?? ''`),
      'Cmd+Shift+V pasted nothing',
      (text) => text.includes(STYLED_TEXT),
    );
    // Undo takes back the paste and only the paste.
    await editor!.chord('z', 'KeyZ', 90, PASTE_MODIFIER);
    await eventually(
      async () => editor!.evaluate<string>(`document.querySelector('${box('box-b')} .text-content')?.textContent ?? ''`),
      'undo did not take back the plain paste',
      (text) => text === 'Before',
    );
    await editAll('box-b');
    await editor!.chord('V', 'KeyV', 86, META_SHIFT);
    await wait(300);
    const plain = await closeAndRead('box-b');
    expect(plain).toContain(STYLED_TEXT);
    expect(plain).not.toMatch(/font-weight|color|<b>|<strong>/);
  });

  it('Web UI: multi-line text becomes one paragraph per line, with either chord', { timeout: 120_000 }, async () => {
    await openWebUi();
    const lines = 'First line\nSecond line\n\nAfter a gap';
    const html = `<p style="color: red">${lines.replace(/\n/g, '<br>')}</p>`;
    const results: string[] = [];
    for (const [id, modifiers] of [['box-a', META_SHIFT], ['box-b', CTRL_SHIFT]] as const) {
      await setClipboard(html, lines);
      await editAll(id);
      await editor!.chord('V', 'KeyV', 86, modifiers);
      results.push(await closeAndRead(id));
    }
    // Chromium's own Ctrl+Shift+V wrote the lines as raw newlines in a single
    // paragraph, where no paragraph or list control could reach them.
    for (const result of results) {
      expect(result).toBe('<p>First line</p><p>Second line</p><p><br></p><p>After a gap</p>');
    }
  });

  it('Web UI: a URL pasted over selected text still links it', { timeout: 120_000 }, async () => {
    await openWebUi();
    await setClipboard('<a href="https://example.com/x" style="color: red">https://example.com/x</a>', 'https://example.com/x');
    await editAll('box-c');
    await editor!.chord('V', 'KeyV', 86, META_SHIFT);
    const linked = await closeAndRead('box-c');
    expect(linked).toMatch(/<a [^>]*href="https:\/\/example\.com\/x"[^>]*>Before<\/a>/);
  });

  it('desktop app: drops the copied formatting', { timeout: 120_000 }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'paste-plain-desktop-'));
    const deckDir = join(workDir, 'deck');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(profileDir, { recursive: true });
    await saveDeck(deckDir, fixtureDeck());
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; color: #111; font: 400 48px/1.3 sans-serif; }\n', 'utf8');
    const appDir = join(workDir, 'app');
    await materializeDesktopApp(appDir, 'deckwerk-plain-paste-test');
    const app = await launchDesktopApp(appDir, [deckDir, '--inspect=0'], {
      profileDir,
      visible: NEEDS_VISIBLE_WINDOW_ON_CI,
    });
    appProcess = app.process;
    const target = await findTarget(app.debugPort, isEditorTarget, app.log);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await editor.call('Emulation.setFocusEmulationEnabled', { enabled: true });
    await eventually(async () => editor!.evaluate<boolean>(`Boolean(document.querySelector('${box('box-a')}'))`), 'desktop editor did not open the deck');

    await setClipboard(STYLED_HTML, `${STYLED_TEXT}\nNext line`);
    await editAll('box-a');
    await editor.chord('V', 'KeyV', 86, META_SHIFT);
    await eventually(
      async () => editor!.evaluate<string>(`document.querySelector('${box('box-a')} .text-content')?.textContent ?? ''`),
      'Cmd+Shift+V pasted nothing in the desktop app',
      (text) => text.includes(STYLED_TEXT),
    );
    const plain = await closeAndRead('box-a');
    expect(plain).toBe(`<p>${STYLED_TEXT}</p><p>Next line</p>`);
  });
});
