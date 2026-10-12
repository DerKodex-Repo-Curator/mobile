/**
 * The voice the person picked is the voice the app speaks with after a relaunch. They choose a voice
 * other than the default in the voice picker; after the app restarts, tapping Speak on a reply plays
 * it in that voice, and the picker still shows that voice as the selected one. It must not fall back
 * to the default voice (Heart) because the engine started before the saved settings were read.
 *
 * Launch 1: pick the text model on Home and chat (real send), download the voice model on the real
 * Models > Voice panel, enter Voice mode with the real chat header toggle, open the real voice picker
 * and choose Michael, then return to Text mode.
 * Relaunch the way the harness models it: a fresh module graph over the same persisted AsyncStorage,
 * so every store rehydrates and Pro activates again, then the chat is opened and mounted anew.
 * Launch 2: tap Speak on the reply from launch 1, then open Voice mode's picker.
 *
 * Fakes only at the device boundary: the LiteRT engine, the RAM sensor, the filesystem, and the
 * executorch TTS runtime. What the runtime was loaded with and asked to speak is AUDIO content with no
 * rendered surface, so this test reads it off the native useTextToSpeech leaf (the sanctioned audio
 * exception): each load records the voice file it was configured with, each stream the text it spoke.
 */
import { setupChatScreen } from '../../harness/chatHarness';
import { installNativeBoundary, requireRTL, GB } from '../../harness/nativeBoundary';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: () => {}, goBack: () => {}, setOptions: () => {}, addListener: () => () => {} }),
  useRoute: () => require('../../harness/chatHarness').routeHolder,
  useFocusEffect: () => {}, useIsFocused: () => true,
}));

interface TtsRuntimeRecord {
  /** Voice file each live (preventLoad=false) runtime load was configured with, e.g. "am_michael". */
  loads: string[];
  /** Each synthesis request: the voice the runtime was loaded with and the text it was asked to speak. */
  spoken: Array<{ voice: string; text: string }>;
}

/**
 * Record what reaches the executorch TTS runtime. Same device-shaped answer as the jest.setup stub
 * (ready, fully downloaded, a stream that resolves), plus a record of what it was given. It decides
 * nothing.
 */
function recordTtsRuntime(): TtsRuntimeRecord {
  const record: TtsRuntimeRecord = { loads: [], spoken: [] };
  const executorch = require('react-native-executorch');
  (executorch.useTextToSpeech as jest.Mock).mockImplementation(
    (config: { voiceSource?: string }, opts?: { preventLoad?: boolean }) => {
      const voice = /\/([^/]+)\.[^/.]+$/.exec(String(config.voiceSource))?.[1] ?? String(config.voiceSource);
      if (!opts?.preventLoad && record.loads[record.loads.length - 1] !== voice) record.loads.push(voice);
      return {
        isReady: true,
        downloadProgress: 1,
        error: null,
        stream: async ({ text }: { text: string }) => { record.spoken.push({ voice, text }); },
        streamStop: () => {},
      };
    },
  );
  return record;
}

/**
 * Relaunch the app the way the harness models it: a fresh module graph over the same persisted
 * AsyncStorage, so every store rehydrates from what launch 1 saved and Pro activates again. The disk
 * outlives the process, so the text model file launch 1 had is placed back at the same path. Then the
 * person opens the chat they were in (the chat list hands the screen its id) and the screen mounts anew.
 */
async function relaunchIntoChat(conversationId: string, modelFileName: string) {
  const boundary = installNativeBoundary({ fs: true, ram: { platform: 'android', totalBytes: 12 * GB, availBytes: 8 * GB } });
  boundary.fs!.seedFile(`${boundary.fs!.DocumentDirectoryPath}/models/${modelFileName}`, 500 * 1024 * 1024);
  // Storage boundary: on a cold launch the persisted store takes a moment to answer. Reads return what
  // launch 1 wrote, just not synchronously-fast, so anything that reads settings before hydration
  // finishes sees the defaults - exactly the window a cold start has on device.
  const AsyncStorage =
    require('@react-native-async-storage/async-storage').default ??
    require('@react-native-async-storage/async-storage');
  const readNow = (AsyncStorage.getItem as jest.Mock).getMockImplementation()!;
  (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
    await new Promise(r => setTimeout(r, 40));
    return readNow(key);
  });
  const React = require('react');
  const rtl = requireRTL();
  const { useAppStore, useChatStore } = require('../../../src/stores');
  const { installPro } = require('../../harness/proHarness');
  await installPro();
  await rtl.waitFor(() => expect(useChatStore.getState().conversations.some((c: { id: string }) => c.id === conversationId)).toBe(true));
  await rtl.waitFor(() => expect(useAppStore.getState().activeModelId).toBe('m'));
  require('../../harness/chatHarness').routeHolder.params = { conversationId };
  const { ChatScreen } = require('../../../src/screens/ChatScreen');
  const { getSlot, SLOTS } = require('../../../src/bootstrap/slotRegistry');
  const AppRoot = getSlot(SLOTS.appRoot);
  return { rtl, React, ChatScreen, AppRoot };
}

describe('the saved voice survives a relaunch', () => {
  it('speaks with the voice picked before the relaunch and shows it selected in the picker', async () => {
    // ── Launch 1: chat, download the voice model, pick Michael ─────────────────────────────────
    const first = await setupChatScreen({ engine: 'litert', platform: 'android', pro: true });
    let conversationId: string;
    {
      const { React, rtl } = first;
      const { VoiceModelsPanel } = require('../../../pro/audio/ui/VoiceModelsPanel');
      const panel = rtl.render(React.createElement(VoiceModelsPanel, { showRemoteModels: false }));
      rtl.fireEvent.press(await rtl.waitFor(() => panel.getByTestId('voice-model-kokoro-download')));
      await rtl.waitFor(() => expect(panel.getByTestId('voice-model-kokoro-delete')).toBeTruthy(), { timeout: 6000 });
      panel.unmount();

      const view = first.render();
      await first.send('what is the capital of France?', { content: 'The capital of France is Paris.' });
      await rtl.waitFor(() => expect(view.queryByText(/The capital of France is Paris\./)).not.toBeNull());
      await rtl.waitFor(() => expect(view.queryByTestId('stop-button')).toBeNull());
      conversationId = first.conversationId!;

      rtl.fireEvent.press(view.getByTestId('chat-mode-toggle'));
      await rtl.waitFor(() => expect(view.getByLabelText('Switch to Text mode')).toBeTruthy());

      // The picker starts on the default voice; the person chooses Michael.
      rtl.fireEvent.press(await rtl.waitFor(() => view.getByText('Heart')));
      await rtl.waitFor(() => expect(view.getByRole('button', { name: 'Heart', selected: true })).toBeTruthy());
      rtl.fireEvent.press(view.getByRole('button', { name: 'Michael' }));
      await rtl.waitFor(() => expect(view.queryByRole('button', { name: 'Adam' })).toBeNull());
      await rtl.waitFor(() => expect(view.getByText('Michael')).toBeTruthy(), { timeout: 8000 });

      rtl.fireEvent.press(view.getByTestId('chat-mode-toggle'));
      await rtl.waitFor(() => expect(view.getByLabelText('Switch to Voice mode')).toBeTruthy());
      await first.settle(50); // let persist flush to AsyncStorage
      view.unmount();
    }

    // ── Relaunch: fresh module graph, same persisted storage, back into the same chat ───────────
    const { rtl, React, ChatScreen, AppRoot } = await relaunchIntoChat(conversationId, 'gemma.litertlm');
    const runtime = recordTtsRuntime();
    const view = rtl.render(React.createElement(React.Fragment, null,
      React.createElement(AppRoot, {}), React.createElement(ChatScreen, {})));
    await rtl.waitFor(() => expect(view.queryByText(/The capital of France is Paris\./)).not.toBeNull());

    // Before: nothing has been spoken in this launch.
    expect(runtime.spoken).toHaveLength(0);

    // The person opens the reply's actions and taps Speak.
    const replies = view.getAllByTestId('assistant-message');
    rtl.fireEvent.press(rtl.within(replies[replies.length - 1]).getByText('•••'));
    rtl.fireEvent.press(await rtl.waitFor(() => view.getByTestId('action-speak')));

    // The reply was spoken by a runtime loaded with the saved voice, never the default one.
    await rtl.waitFor(() => expect(runtime.spoken.length).toBeGreaterThan(0), { timeout: 8000 });
    expect(runtime.spoken[0].text).toContain('The capital of France is Paris.');
    expect(runtime.spoken.map(s => s.voice)).toEqual(runtime.spoken.map(() => 'am_michael'));
    expect(runtime.loads).toEqual(['am_michael']);

    // The picker shows the saved voice as the selected one.
    await rtl.waitFor(() => expect(view.queryByTestId('action-menu')).toBeNull());
    rtl.fireEvent.press(view.getByTestId('chat-mode-toggle'));
    await rtl.waitFor(() => expect(view.getByLabelText('Switch to Text mode')).toBeTruthy());
    rtl.fireEvent.press(await rtl.waitFor(() => view.getByText('Michael')));
    await rtl.waitFor(() => expect(view.getByRole('button', { name: 'Michael', selected: true })).toBeTruthy());
    expect(view.queryByRole('button', { name: 'Heart', selected: true })).toBeNull();
    expect(view.getByRole('button', { name: 'Heart' })).toBeTruthy();

    // Pro starts sync on this launch too. Let that start finish before the suite ends, so none of it
    // runs after the test environment is torn down.
    const { useSyncStore } = require('../../../pro/sync/syncStore');
    await rtl.waitFor(() => expect(useSyncStore.getState().status).not.toBe('starting'), { timeout: 8000 });
    view.unmount();
  });
});
