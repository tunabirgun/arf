// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { confirmAsk } from '../../src/lib/confirm.js';

afterEach(() => vi.restoreAllMocks());
describe('confirmAsk', () => {
  it('honours a synchronous browser confirm', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false); expect(await confirmAsk('x')).toBe(false);
    window.confirm.mockReturnValue(true); expect(await confirmAsk('x')).toBe(true);
  });
  it('awaits the Tauri dialog plugin, whose confirm returns a Promise (always truthy if not awaited)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(Promise.resolve(false)); expect(await confirmAsk('x')).toBe(false);
    window.confirm.mockReturnValue(Promise.resolve(true)); expect(await confirmAsk('x')).toBe(true);
  });
  it('treats a rejected or throwing confirm (e.g. permission denied) as cancel', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(Promise.reject(new Error('not allowed by ACL'))); expect(await confirmAsk('x')).toBe(false);
    window.confirm.mockImplementation(() => { throw new Error('x'); }); expect(await confirmAsk('x')).toBe(false);
  });
});
describe('confirmAsk in the desktop app', () => {
  it('uses the dialog plugin ask() (Yes/No through the allowed message command) and passes the button labels', async () => {
    const calls = [];
    const ask = async (msg, o) => { calls.push([msg, o]); return calls.length === 1; };
    expect(await confirmAsk('Delete it?', { ask })).toBe(true);
    expect(await confirmAsk('Remove it?', { ask, okLabel: 'Remove' })).toBe(false);
    expect(calls[0][1]).toMatchObject({ title: 'Arf', kind: 'warning', okLabel: 'Delete', cancelLabel: 'Cancel' });
    expect(calls[1][1].okLabel).toBe('Remove');
  });
  it('treats a failing ask() as cancel', async () => {
    expect(await confirmAsk('x', { ask: async () => { throw new Error('denied'); } })).toBe(false);
  });
});
